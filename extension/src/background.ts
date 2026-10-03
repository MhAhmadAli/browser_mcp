import {
  CloseCode,
  type ConsoleLog,
  type HelloMessage,
  NO_CONNECTED_TAB_ERROR,
  type PingMessage,
  PORT_COUNT,
  type RequestMessage,
  type ResponseMessage,
} from "../../src/protocol";
import { type Cdp, currentHistoryEntry } from "./cdp";
import {
  handleRequest,
  type SnapshotState,
  type TabSession,
  updateConsoleLogs,
} from "./handlers";
import {
  type ConnectionState,
  disconnectedState,
  loadSettings,
  type PopupRequest,
  type PopupResponse,
} from "./state";

const protocolVersion = "1.3";
/** Chrome 116+ keeps a service worker alive while its WebSocket is active. */
const keepAliveIntervalMs = 20000;
/** How often to look for servers, e.g. one started by a new chat. */
const scanIntervalMs = { whileConnected: 5000, whileWaiting: 2000 };
/** Wakes the service worker to reconnect if it was stopped while the server was down. */
const reconnectAlarm = "reconnect";
const connectionKey = "connection";
const snapshotStateKey = "snapshotState";

const badgeText: Record<ConnectionState["status"], string> = {
  disconnected: "",
  connecting: "…",
  connected: "ON",
};

let state: ConnectionState = disconnectedState;
/** One socket per MCP server (open or still connecting), by port. */
const sockets = new Map<number, WebSocket>();
/** Servers that accepted the pairing token. */
const readyPorts = new Set<number>();
/** Ports not to retry until the user connects again, e.g. taken by another browser. */
const blockedPorts = new Set<number>();
let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
let scanTimer: ReturnType<typeof setTimeout> | undefined;
const consoleLogs: ConsoleLog[] = [];
const eventListeners = new Map<string, Set<(params: unknown) => void>>();

/** Connection changes run one at a time. */
let commandQueue: Promise<unknown> = Promise.resolve();
/** Server requests run one at a time, so actions on the tab don't interleave. */
let requestQueue: Promise<void> = Promise.resolve();

function runCommand<T>(command: () => Promise<T>): Promise<T> {
  const result = commandQueue.then(command);
  commandQueue = result.catch(() => {});
  return result;
}

// Listeners are registered synchronously so their events can wake the service worker
chrome.runtime.onMessage.addListener(
  (request: PopupRequest, _sender, sendResponse) => {
    runCommand(() => handlePopupRequest(request)).then(sendResponse, (error) =>
      sendResponse({
        state,
        title: null,
        servers: readyPorts.size,
        error: errorMessage(error),
      }),
    );
    return true;
  },
);

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined || source.tabId !== state.tabId) {
    return;
  }
  updateConsoleLogs(consoleLogs, method, params);
  for (const listener of eventListeners.get(method) ?? []) {
    listener(params);
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  void runCommand(async () => {
    if (source.tabId !== undefined && source.tabId === state.tabId) {
      await disconnect(
        reason === "canceled_by_user"
          ? null
          : `Lost control of the tab (${reason}).`,
      );
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void runCommand(async () => {
    if (tabId === state.tabId) {
      await disconnect(null);
    }
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === reconnectAlarm) {
    void runCommand(scanServers);
  }
});

void runCommand(restore);

async function handlePopupRequest(request: PopupRequest): Promise<PopupResponse> {
  if (request.type === "connect") {
    await connectTab(request.tabId);
  } else if (request.type === "disconnect") {
    await disconnect(null);
  }
  return { state, title: await connectedTabTitle(), servers: readyPorts.size };
}

/** Picks up an existing connection after the service worker restarts. */
async function restore() {
  const stored = await chrome.storage.session.get(connectionKey);
  const saved = stored[connectionKey] as ConnectionState | undefined;
  if (saved?.tabId == null) {
    await updateBadge();
    return;
  }
  state = saved;
  // The socket closed along with the previous service worker
  await setState({ status: "connecting" });
  const { tabId } = saved;
  try {
    await chrome.tabs.get(tabId);
  } catch {
    await disconnect(null);
    return;
  }
  try {
    await chrome.debugger.attach({ tabId }, protocolVersion);
  } catch {
    // Still attached from before the service worker stopped
  }
  try {
    await enableDomains(tabId);
  } catch (error) {
    await disconnect(`Lost control of the tab: ${errorMessage(error)}`);
    return;
  }
  await scanServers();
}

async function connectTab(tabId: number) {
  const { token } = await loadSettings();
  if (!token) {
    throw new Error("Paste the pairing token in Settings first.");
  }
  if (tabId === state.tabId) {
    blockedPorts.clear();
    await scanServers();
    return;
  }
  if (state.tabId !== null) {
    await disconnect(null);
  }

  try {
    await chrome.debugger.attach({ tabId }, protocolVersion);
  } catch (error) {
    throw new Error(`Can't control this tab: ${errorMessage(error)}`);
  }
  // Set before enabling domains, so the console messages Chrome replays are recorded
  await setState({ tabId, status: "connecting", error: null });
  try {
    await enableDomains(tabId);
  } catch (error) {
    await disconnect(null);
    throw new Error(`Can't control this tab: ${errorMessage(error)}`);
  }
  await chrome.alarms.create(reconnectAlarm, { periodInMinutes: 0.5 });
  await scanServers();
}

async function disconnect(error: string | null) {
  const { tabId } = state;
  await setState({ tabId: null, status: "disconnected", error });
  await chrome.alarms.clear(reconnectAlarm);
  closeSockets();
  blockedPorts.clear();
  consoleLogs.length = 0;
  await chrome.storage.session.remove(snapshotStateKey);
  if (tabId !== null) {
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

async function enableDomains(tabId: number) {
  const cdp = createCdp(tabId);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  // Lets focus-dependent pages behave normally while the window is in the background
  await cdp
    .send("Emulation.setFocusEmulationEnabled", { enabled: true })
    .catch(() => {});
}

/**
 * Connects to every server in the port range that isn't connected yet. Each MCP
 * client (e.g. each chat) runs its own server, and all of them share the tab.
 */
async function scanServers() {
  clearTimeout(scanTimer);
  if (state.tabId === null) {
    return;
  }
  const { token, port: firstPort } = await loadSettings();
  for (let port = firstPort; port < firstPort + PORT_COUNT; port++) {
    if (!sockets.has(port) && !blockedPorts.has(port)) {
      openSocket(port, token);
    }
  }
  keepAliveTimer ??= setInterval(() => {
    for (const port of readyPorts) {
      const ws = sockets.get(port);
      if (ws) {
        send(ws, { type: "ping" } satisfies PingMessage);
      }
    }
  }, keepAliveIntervalMs);
  scheduleScan(
    readyPorts.size > 0
      ? scanIntervalMs.whileConnected
      : scanIntervalMs.whileWaiting,
  );
}

function scheduleScan(delayMs: number) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => void runCommand(scanServers), delayMs);
}

function openSocket(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.set(port, ws);
  ws.addEventListener("open", () =>
    send(ws, { type: "hello", token } satisfies HelloMessage),
  );
  ws.addEventListener("message", (event) =>
    onSocketMessage(ws, port, event.data),
  );
  ws.addEventListener("close", (event) => onSocketClose(ws, port, event));
}

function closeSockets() {
  clearTimeout(scanTimer);
  clearInterval(keepAliveTimer);
  keepAliveTimer = undefined;
  const open = [...sockets.values()];
  sockets.clear();
  readyPorts.clear();
  for (const ws of open) {
    ws.close(1000, "Disconnected");
  }
}

function onSocketMessage(ws: WebSocket, port: number, data: unknown) {
  if (typeof data !== "string") {
    return;
  }
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return;
  }
  if (typeof message !== "object" || message === null) {
    return;
  }
  if ("type" in message && message.type === "ready") {
    void runCommand(async () => {
      if (sockets.get(port) === ws) {
        readyPorts.add(port);
        await setState({ status: "connected", error: null });
      }
    });
  } else if ("id" in message && typeof message.id === "number") {
    const request = message as RequestMessage;
    requestQueue = requestQueue.then(() => respond(ws, request));
  }
}

function onSocketClose(ws: WebSocket, port: number, event: CloseEvent) {
  if (sockets.get(port) !== ws) {
    return;
  }
  sockets.delete(port);
  // Most closes are scans finding no server on a port; those need no action
  const wasReady = readyPorts.delete(port);
  void runCommand(async () => {
    if (state.tabId === null) {
      return;
    }
    if (event.code === CloseCode.InvalidToken) {
      // All servers share one token, so the others would reject it too
      await disconnect(
        "The MCP server rejected the pairing token. Copy it again by running the server's token command.",
      );
      return;
    }
    const error = closeError(event, port);
    if (error) {
      blockedPorts.add(port);
    }
    if (wasReady || error) {
      await setState({
        status: readyPorts.size > 0 ? "connected" : "connecting",
        error: error ?? state.error,
      });
    }
    if (wasReady) {
      // The server stopped or restarted: keep the tab and look for it again soon
      scheduleScan(scanIntervalMs.whileWaiting);
    }
  });
}

function closeError(event: CloseEvent, port: number): string | null {
  switch (event.code) {
    case CloseCode.Replaced:
      return `Another browser connected to the MCP server on port ${port}.`;
    case CloseCode.HandshakeFailed:
      return `Couldn't connect to the MCP server on port ${port}: ${event.reason || "handshake failed"}.`;
    default:
      return null;
  }
}

async function respond(ws: WebSocket, request: RequestMessage) {
  let response: ResponseMessage;
  try {
    if (state.tabId === null) {
      throw new Error(NO_CONNECTED_TAB_ERROR);
    }
    const result = await handleRequest(
      createSession(state.tabId),
      request.type,
      request.payload,
    );
    response = { id: request.id, result: result ?? null };
  } catch (error) {
    response = { id: request.id, error: errorMessage(error) };
  }
  send(ws, response);
}

function send(ws: WebSocket, message: HelloMessage | PingMessage | ResponseMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function createSession(tabId: number): TabSession {
  return {
    cdp: createCdp(tabId),
    consoleLogs,
    snapshotState: {
      get: async () => {
        const stored = await chrome.storage.session.get(snapshotStateKey);
        return stored[snapshotStateKey] as SnapshotState | undefined;
      },
      set: (snapshotState) =>
        chrome.storage.session.set({ [snapshotStateKey]: snapshotState }),
    },
  };
}

function createCdp(tabId: number): Cdp {
  return {
    async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      try {
        return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
      } catch (error) {
        throw new Error(protocolErrorMessage(error));
      }
    },
    on<T>(event: string, listener: (params: T) => void) {
      const listeners = eventListeners.get(event) ?? new Set();
      eventListeners.set(event, listeners);
      const untyped = listener as (params: unknown) => void;
      listeners.add(untyped);
      return () => {
        listeners.delete(untyped);
      };
    },
  };
}

async function connectedTabTitle(): Promise<string | null> {
  if (state.tabId === null) {
    return null;
  }
  try {
    const { title, url } = await currentHistoryEntry(createCdp(state.tabId));
    return title || url;
  } catch {
    return null;
  }
}

async function setState(update: Partial<ConnectionState>) {
  state = { ...state, ...update };
  await chrome.storage.session.set({ [connectionKey]: state });
  await updateBadge();
}

async function updateBadge() {
  await chrome.action.setBadgeText({ text: badgeText[state.status] });
  await chrome.action.setBadgeBackgroundColor({
    color: state.status === "connected" ? "#1a7f37" : "#9a6700",
  });
}

/** chrome.debugger reports protocol errors as JSON, like {"code":-32000,"message":"..."}. */
function protocolErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  try {
    const parsed: unknown = JSON.parse(message);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof parsed.message === "string"
    ) {
      return parsed.message;
    }
  } catch {
    // Not JSON
  }
  return message;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
