import type {
  ConsoleLog,
  MessagePayload,
  MessageResult,
  MessageType,
} from "../../src/protocol";
import {
  type Cdp,
  currentHistoryEntry,
  getMainFrame,
  type NavigationHistory,
  runAndWaitForNavigation,
  withTimeout,
} from "./cdp";
import {
  callFunction,
  clickablePoint,
  evaluate,
  resolveObjectId,
  scrollIntoView,
} from "./dom";
import { click, dragMouse, hover, mouseDown, mouseUp, pressKey } from "./input";
import { captureSnapshot, parseRef } from "./snapshot";

/** Which page load the latest snapshot's refs belong to. */
export type SnapshotState = { loaderId: string; document: number };

/** Everything a request handler needs to act on the connected tab. */
export type TabSession = {
  cdp: Cdp;
  consoleLogs: ConsoleLog[];
  snapshotState: {
    get(): Promise<SnapshotState | undefined>;
    set(state: SnapshotState): Promise<void>;
  };
};

type Handlers = {
  [T in MessageType]: (
    session: TabSession,
    payload: MessagePayload<T>,
  ) => Promise<MessageResult<T>>;
};

type RemoteObject = {
  type: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  preview?: ObjectPreview;
};

type ObjectPreview = {
  subtype?: string;
  overflow: boolean;
  properties: { name: string; type: string; value?: string }[];
};

type ViewportMetrics = {
  cssVisualViewport: {
    pageX: number;
    pageY: number;
    clientWidth: number;
    clientHeight: number;
  };
};

const screenshotTimeoutMs = 10000;
const maxConsoleLogs = 1000;

const handlers: Handlers = {
  getUrl: async ({ cdp }) => (await currentHistoryEntry(cdp)).url,

  getTitle: async ({ cdp }) => (await currentHistoryEntry(cdp)).title,

  browser_navigate: async ({ cdp }, { url }) => {
    const target = parseHttpUrl(url);
    await runAndWaitForNavigation(cdp, async () => {
      const { errorText } = await cdp.send<{ errorText?: string }>(
        "Page.navigate",
        { url: target },
      );
      if (errorText) {
        throw new Error(`Couldn't open ${target}: ${errorText}`);
      }
    });
    return null;
  },

  browser_go_back: async ({ cdp }) => {
    await navigateHistory(cdp, -1);
    return null;
  },

  browser_go_forward: async ({ cdp }) => {
    await navigateHistory(cdp, 1);
    return null;
  },

  browser_snapshot: async ({ cdp, snapshotState }) => {
    const { loaderId } = await getMainFrame(cdp);
    const previous = await snapshotState.get();
    const document =
      previous?.loaderId === loaderId
        ? previous.document
        : nextDocumentNumber(previous);
    const snapshot = await captureSnapshot(cdp, document);
    await snapshotState.set({ loaderId, document });
    return snapshot;
  },

  browser_click: async (session, { ref }) => {
    const { cdp } = session;
    const node = await resolveRef(session, ref);
    await runAndWaitForNavigation(cdp, async () =>
      click(cdp, await clickablePoint(cdp, node)),
    );
    return null;
  },

  browser_hover: async (session, { ref }) => {
    const { cdp } = session;
    const node = await resolveRef(session, ref);
    await hover(cdp, await clickablePoint(cdp, node));
    return null;
  },

  browser_drag: async (session, { startRef, endRef }) => {
    const { cdp } = session;
    const source = await resolveRef(session, startRef);
    const target = await resolveRef(session, endRef);
    await runAndWaitForNavigation(cdp, async () => {
      const start = await clickablePoint(cdp, source);
      await hover(cdp, start);
      await mouseDown(cdp, start);
      let end = start;
      try {
        // Found after pressing, as scrolling the target into view can move the source
        end = await clickablePoint(cdp, target);
        await dragMouse(cdp, start, end);
      } finally {
        await mouseUp(cdp, end);
      }
    });
    return null;
  },

  browser_type: async (session, { ref, text, submit }) => {
    const { cdp } = session;
    const node = await resolveRef(session, ref);
    await scrollIntoView(cdp, node);
    const objectId = await resolveObjectId(cdp, node);
    const isEditable = await callFunction<boolean>(
      cdp,
      objectId,
      focusAndSelectContents,
    );
    if (!isEditable) {
      throw new Error(
        "Element is not an editable field. Take a new snapshot and pick a textbox.",
      );
    }
    if (text) {
      await cdp.send("Input.insertText", { text });
    } else {
      await pressKey(cdp, "Delete");
    }
    if (submit) {
      await runAndWaitForNavigation(cdp, () => pressKey(cdp, "Enter"));
    }
    return null;
  },

  browser_select_option: async (session, { ref, values }) => {
    const { cdp } = session;
    const node = await resolveRef(session, ref);
    const objectId = await resolveObjectId(cdp, node);
    await runAndWaitForNavigation(cdp, async () => {
      const error = await callFunction<string | null>(
        cdp,
        objectId,
        selectOptions,
        [values],
      );
      if (error) {
        throw new Error(error);
      }
    });
    return null;
  },

  browser_press_key: async ({ cdp }, { key }) => {
    await runAndWaitForNavigation(cdp, () => pressKey(cdp, key));
    return null;
  },

  browser_get_console_logs: async ({ consoleLogs }) => [...consoleLogs],

  browser_screenshot: async ({ cdp }) => captureScreenshot(cdp),
};

export async function handleRequest(
  session: TabSession,
  type: string,
  payload: unknown,
): Promise<unknown> {
  if (!Object.hasOwn(handlers, type)) {
    throw new Error(`Unknown request type: ${type}`);
  }
  const handler = handlers[type as MessageType] as (
    session: TabSession,
    payload: unknown,
  ) => Promise<unknown>;
  return handler(session, payload);
}

/** Records console output from a protocol event, keeping only the current page's logs. */
export function updateConsoleLogs(
  logs: ConsoleLog[],
  method: string,
  params: unknown,
) {
  if (method === "Page.frameNavigated") {
    const { frame } = params as { frame: { parentId?: string } };
    if (!frame.parentId) {
      logs.length = 0;
    }
    return;
  }
  const log = toConsoleLog(method, params);
  if (log) {
    logs.push(log);
    if (logs.length > maxConsoleLogs) {
      logs.splice(0, logs.length - maxConsoleLogs);
    }
  }
}

function toConsoleLog(method: string, params: unknown): ConsoleLog | undefined {
  switch (method) {
    case "Runtime.consoleAPICalled": {
      const { type, timestamp, args } = params as {
        type: string;
        timestamp: number;
        args: RemoteObject[];
      };
      return { type, timestamp, message: args.map(formatRemoteObject).join(" ") };
    }
    case "Runtime.exceptionThrown": {
      const { timestamp, exceptionDetails } = params as {
        timestamp: number;
        exceptionDetails: { text: string; exception?: RemoteObject };
      };
      return {
        type: "error",
        timestamp,
        message: exceptionDetails.exception?.description ?? exceptionDetails.text,
      };
    }
    case "Log.entryAdded": {
      const { entry } = params as {
        entry: { level: string; text: string; timestamp: number; url?: string };
      };
      return {
        type: entry.level,
        timestamp: entry.timestamp,
        message: entry.url ? `${entry.text} (${entry.url})` : entry.text,
      };
    }
    default:
      return undefined;
  }
}

function formatRemoteObject(object: RemoteObject): string {
  if (object.unserializableValue) {
    return object.unserializableValue;
  }
  if ("value" in object) {
    return typeof object.value === "string"
      ? object.value
      : JSON.stringify(object.value);
  }
  // Plain objects and arrays read better as their contents than as "Object"
  if (object.preview && (!object.subtype || object.subtype === "array")) {
    return formatPreview(object.preview);
  }
  return object.description ?? object.type;
}

function formatPreview(preview: ObjectPreview): string {
  const isArray = preview.subtype === "array";
  const entries = preview.properties.map((property) => {
    const value =
      property.type === "string"
        ? JSON.stringify(property.value)
        : (property.value ?? property.type);
    return isArray ? value : `${property.name}: ${value}`;
  });
  if (preview.overflow) {
    entries.push("…");
  }
  return isArray ? `[${entries.join(", ")}]` : `{${entries.join(", ")}}`;
}

function nextDocumentNumber(previous: SnapshotState | undefined): number {
  // A random start keeps refs from an earlier connection from matching by accident
  return previous ? previous.document + 1 : 100 + Math.floor(Math.random() * 900);
}

/** Checks that a ref comes from a snapshot of the page that's currently loaded. */
async function resolveRef(session: TabSession, ref: string): Promise<number> {
  const { document, backendNodeId } = parseRef(ref);
  const [snapshot, frame] = await Promise.all([
    session.snapshotState.get(),
    getMainFrame(session.cdp),
  ]);
  if (!snapshot) {
    throw new Error("Take a page snapshot first to get element refs.");
  }
  if (document !== snapshot.document || snapshot.loaderId !== frame.loaderId) {
    throw new Error(
      "The page has changed since that ref was taken. Take a new snapshot to get fresh element refs.",
    );
  }
  return backendNodeId;
}

function parseHttpUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `"${url}" is not a valid URL. Include the scheme, like https://example.com`,
    );
  }
  if (!isHttpUrl(parsed.href)) {
    throw new Error(
      `Only http and https URLs can be opened, not ${parsed.protocol} URLs.`,
    );
  }
  return parsed.href;
}

function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

async function navigateHistory(cdp: Cdp, offset: -1 | 1) {
  const { currentIndex, entries } = await cdp.send<NavigationHistory>(
    "Page.getNavigationHistory",
  );
  const entry = entries[currentIndex + offset];
  if (!entry) {
    throw new Error(
      offset < 0
        ? "There is no previous page to go back to."
        : "There is no next page to go forward to.",
    );
  }
  // The tab's history can include pages opened before it was connected
  if (!isHttpUrl(entry.url)) {
    throw new Error(
      `Can't go ${offset < 0 ? "back" : "forward"} to ${entry.url}: only http and https pages can be opened.`,
    );
  }
  await runAndWaitForNavigation(cdp, () =>
    cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }),
  );
}

async function captureScreenshot(cdp: Cdp): Promise<string> {
  const { cssVisualViewport: viewport } =
    await cdp.send<ViewportMetrics>("Page.getLayoutMetrics");
  const devicePixelRatio = await evaluate<number>(cdp, "window.devicePixelRatio");
  const { data } = await withTimeout(
    cdp.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      // One image pixel per CSS pixel, so high-DPI screens don't produce oversized images
      clip: {
        x: viewport.pageX,
        y: viewport.pageY,
        width: viewport.clientWidth,
        height: viewport.clientHeight,
        scale: 1 / (devicePixelRatio || 1),
      },
    }),
    screenshotTimeoutMs,
    "Timed out taking a screenshot. Make sure the connected tab is visible, not in a background tab or a minimized window.",
  );
  return data;
}

/** Runs in the page: focuses the editable element (or one inside it) and selects its content. */
function focusAndSelectContents(this: Element): boolean {
  const nonTextInputTypes = [
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
  ];
  const isEditable = (element: Element): element is HTMLElement =>
    (element instanceof HTMLTextAreaElement &&
      !element.disabled &&
      !element.readOnly) ||
    (element instanceof HTMLInputElement &&
      !nonTextInputTypes.includes(element.type) &&
      !element.disabled &&
      !element.readOnly) ||
    (element instanceof HTMLElement && element.isContentEditable);

  const target = isEditable(this)
    ? this
    : [...this.querySelectorAll("input, textarea, [contenteditable]")].find(
        isEditable,
      );
  if (!target) {
    return false;
  }
  target.focus();
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  ) {
    target.select();
  } else {
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  return true;
}

/** Runs in the page: selects the <select> options matching `values` by value or label. */
function selectOptions(this: Element, values: string[]): string | null {
  if (!(this instanceof HTMLSelectElement)) {
    return "Element is not a <select>. Click it to open it, then click the option you want.";
  }
  if (this.disabled) {
    return "The dropdown is disabled.";
  }
  const options = [...this.options];
  const matches: HTMLOptionElement[] = [];
  for (const value of values) {
    const option = options.find(
      (candidate) =>
        candidate.value === value ||
        candidate.label === value ||
        candidate.text.trim() === value,
    );
    if (!option) {
      const available = options.map((candidate) => JSON.stringify(candidate.label));
      return `No option matches "${value}". Available options: ${available.join(", ")}`;
    }
    matches.push(option);
  }
  if (matches.length > 1 && !this.multiple) {
    return "This dropdown allows only one selected option.";
  }
  for (const option of options) {
    option.selected = matches.includes(option);
  }
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return null;
}
