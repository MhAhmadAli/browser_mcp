/**
 * Wire protocol between the MCP server and the browser extension.
 *
 * Shared by both sides, so it must not import anything Node- or browser-specific.
 */

export const DEFAULT_PORT = 9009;

/**
 * Each server takes the first free port from DEFAULT_PORT on, so several MCP
 * clients can run at once; the extension connects to all of them.
 */
export const PORT_COUNT = 10;

export const CloseCode = {
  InvalidToken: 4001,
  Replaced: 4002,
  HandshakeFailed: 4003,
} as const;

export const NO_CONNECTED_TAB_ERROR = "No connected tab";

/** First message the extension sends after the socket opens. */
export type HelloMessage = { type: "hello"; token: string };

/** Sent by the server once the token has been accepted. */
export type ReadyMessage = { type: "ready" };

/** Sent by the extension periodically to keep its service worker alive. */
export type PingMessage = { type: "ping" };

export type RequestMessage = {
  id: number;
  type: MessageType;
  payload: unknown;
};

export type ResponseMessage =
  | { id: number; result: unknown }
  | { id: number; error: string };

export type ConsoleLog = {
  type: string;
  timestamp: number;
  message: string;
};

type EmptyPayload = Record<string, never>;

type ElementTarget = {
  /** Human-readable description, shown to the user when asking for permission. */
  element: string;
  /** Element reference from the latest page snapshot. */
  ref: string;
};

export type SocketMessageMap = {
  getUrl: { payload: undefined; result: string };
  getTitle: { payload: undefined; result: string };
  browser_navigate: { payload: { url: string }; result: null };
  browser_go_back: { payload: EmptyPayload; result: null };
  browser_go_forward: { payload: EmptyPayload; result: null };
  browser_snapshot: { payload: EmptyPayload; result: string };
  browser_click: { payload: ElementTarget; result: null };
  browser_drag: {
    payload: {
      startElement: string;
      startRef: string;
      endElement: string;
      endRef: string;
    };
    result: null;
  };
  browser_hover: { payload: ElementTarget; result: null };
  browser_type: {
    payload: ElementTarget & { text: string; submit?: boolean };
    result: null;
  };
  browser_select_option: {
    payload: ElementTarget & { values: string[] };
    result: null;
  };
  browser_press_key: { payload: { key: string }; result: null };
  browser_get_console_logs: { payload: EmptyPayload; result: ConsoleLog[] };
  browser_screenshot: { payload: EmptyPayload; result: string };
};

export type MessageType = keyof SocketMessageMap;
export type MessagePayload<T extends MessageType> =
  SocketMessageMap[T]["payload"];
export type MessageResult<T extends MessageType> =
  SocketMessageMap[T]["result"];
