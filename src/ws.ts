import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

import { type WebSocket, WebSocketServer } from "ws";

import { config } from "@/config";
import { CloseCode, DEFAULT_PORT, PORT_COUNT, type ReadyMessage } from "@/protocol";
import { debugLog } from "@/utils/log";
import { isPortInUse } from "@/utils/port";

const portWaitTimeoutMs = 5000;
const handshakeTimeoutMs = 5000;
/** Leaves room for full-page snapshots and screenshots. */
const maxMessageBytes = 32 * 1024 * 1024;

type Options = {
  /** Exact port to use; by default the first free one in the extension's range. */
  port?: number;
  token: string;
  /** Called for each connection that presented the right pairing token. */
  onConnection: (ws: WebSocket) => void;
};

export async function createWebSocketServer({
  port,
  token,
  onConnection,
}: Options): Promise<{ wss: WebSocketServer; port: number }> {
  const wss =
    port === undefined ? await listenOnFirstFreePort() : await listenOnPort(port);
  // Without a listener, an "error" event would crash the server
  wss.on("error", (error) => debugLog("WebSocket server error:", error));
  wss.on("connection", (ws) => authenticate(ws, token, onConnection));
  return { wss, port: (wss.address() as AddressInfo).port };
}

/** Lets several MCP clients (e.g. two chats) each run a server at the same time. */
async function listenOnFirstFreePort(): Promise<WebSocketServer> {
  const lastPort = DEFAULT_PORT + PORT_COUNT - 1;
  for (let port = DEFAULT_PORT; port <= lastPort; port++) {
    try {
      return await listen(port);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) {
        throw error;
      }
    }
  }
  throw new Error(
    `Ports ${DEFAULT_PORT}-${lastPort} are all in use. Close some Browser MCP servers and try again.`,
  );
}

async function listenOnPort(port: number): Promise<WebSocketServer> {
  await waitForFreePort(port);
  return listen(port);
}

function listen(port: number): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({
      host: "127.0.0.1",
      port,
      maxPayload: maxMessageBytes,
      verifyClient: ({ origin }: { origin?: string }) => isAllowedOrigin(origin),
    });
    const onError = (error: Error) => {
      wss.close();
      reject(error);
    };
    wss.once("error", onError);
    wss.once("listening", () => {
      wss.off("error", onError);
      resolve(wss);
    });
  });
}

async function waitForFreePort(port: number) {
  const deadline = Date.now() + portWaitTimeoutMs;
  while (await isPortInUse(port)) {
    if (Date.now() > deadline) {
      throw new Error(
        `Port ${port} is already in use. Close the other Browser MCP server (or the process using this port) and try again.`,
      );
    }
    await sleep(100);
  }
}

/**
 * Only the bundled extension may connect. Browsers always send an Origin header,
 * so this also rejects connections from web pages.
 */
function isAllowedOrigin(origin: string | undefined): boolean {
  const allowed = origin === `chrome-extension://${config.extensionId}`;
  if (!allowed) {
    debugLog(`Rejected WebSocket connection from origin ${origin ?? "(none)"}`);
  }
  return allowed;
}

/** Waits for the extension's hello message and checks its pairing token. */
function authenticate(
  ws: WebSocket,
  token: string,
  onConnection: (ws: WebSocket) => void,
) {
  // Malformed frames emit "error" (and then close the socket); unhandled, it would
  // crash the server. This listener stays for the connection's whole lifetime.
  ws.on("error", (error) => debugLog("WebSocket connection error:", error));
  const timer = setTimeout(
    () => ws.close(CloseCode.HandshakeFailed, "Handshake timed out"),
    handshakeTimeoutMs,
  );
  ws.once("close", () => clearTimeout(timer));
  ws.once("message", (data) => {
    clearTimeout(timer);
    const receivedToken = parseHelloToken(data.toString());
    if (receivedToken === undefined) {
      ws.close(CloseCode.HandshakeFailed, "Expected a hello message");
      return;
    }
    if (!tokensMatch(receivedToken, token)) {
      debugLog("Rejected WebSocket connection with an invalid pairing token");
      ws.close(CloseCode.InvalidToken, "Invalid pairing token");
      return;
    }
    const ready: ReadyMessage = { type: "ready" };
    ws.send(JSON.stringify(ready));
    onConnection(ws);
  });
}

function parseHelloToken(raw: string): string | undefined {
  try {
    const message: unknown = JSON.parse(raw);
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "hello" &&
      "token" in message &&
      typeof message.token === "string"
    ) {
      return message.token;
    }
  } catch {
    // Not JSON
  }
  return undefined;
}

function tokensMatch(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
