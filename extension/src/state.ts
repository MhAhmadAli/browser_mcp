import { DEFAULT_PORT } from "../../src/protocol";

export type ConnectionStatus = "disconnected" | "connecting" | "connected";

export type ConnectionState = {
  tabId: number | null;
  status: ConnectionStatus;
  error: string | null;
};

export const disconnectedState: ConnectionState = {
  tabId: null,
  status: "disconnected",
  error: null,
};

export type Settings = { token: string; port: number };

/** Requests the popup sends to the background service worker. */
export type PopupRequest =
  | { type: "getState" }
  | { type: "connect"; tabId: number }
  | { type: "disconnect" };

export type PopupResponse = {
  state: ConnectionState;
  /** Title of the connected tab. */
  title: string | null;
  /** Number of MCP servers connected, one per MCP client such as a chat. */
  servers: number;
  error?: string;
};

export async function loadSettings(): Promise<Settings> {
  const { token, port } = await chrome.storage.local.get(["token", "port"]);
  return {
    token: typeof token === "string" ? token : "",
    port: typeof port === "number" ? port : DEFAULT_PORT,
  };
}

export async function saveSettings(settings: Settings) {
  await chrome.storage.local.set(settings);
}
