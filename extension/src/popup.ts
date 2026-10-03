import {
  type ConnectionState,
  loadSettings,
  type PopupRequest,
  type PopupResponse,
  saveSettings,
} from "./state";

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const statusText = element("status");
const errorText = element("error");
const connectButton = element<HTMLButtonElement>("connect");
const disconnectButton = element<HTMLButtonElement>("disconnect");
const settingsDetails = element<HTMLDetailsElement>("settings");
const settingsForm = element<HTMLFormElement>("settings-form");
const tokenInput = element<HTMLInputElement>("token");
const portInput = element<HTMLInputElement>("port");
const savedText = element("saved");

let activeTabId: number | undefined;
let hasToken = false;

async function request(message: PopupRequest) {
  try {
    const response: PopupResponse = await chrome.runtime.sendMessage(message);
    render(response);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

function render({ state, title, servers, error }: PopupResponse) {
  const isThisTab = state.tabId !== null && state.tabId === activeTabId;
  statusText.textContent = describe(state, isThisTab ? "this tab" : title, servers);
  statusText.dataset.status = state.status;
  showError(error ?? state.error);

  connectButton.hidden = isThisTab;
  connectButton.textContent =
    state.tabId === null ? "Connect" : "Connect this tab instead";
  connectButton.disabled = !hasToken || activeTabId === undefined;
  disconnectButton.hidden = state.tabId === null;
}

function describe(
  state: ConnectionState,
  tab: string | null,
  servers: number,
): string {
  const tabName = tab === "this tab" ? tab : `“${tab ?? "another tab"}”`;
  switch (state.status) {
    case "connected":
      return servers > 1
        ? `Connected to ${tabName}, shared by ${servers} MCP servers`
        : `Connected to ${tabName}`;
    case "connecting":
      return `Waiting for the MCP server (${tabName})`;
    default:
      return "Not connected";
  }
}

function showError(message: string | null) {
  errorText.textContent = message ?? "";
  errorText.hidden = !message;
}

connectButton.addEventListener("click", () => {
  if (activeTabId !== undefined) {
    void request({ type: "connect", tabId: activeTabId });
  }
});

disconnectButton.addEventListener("click", () => {
  void request({ type: "disconnect" });
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const port = Number(portInput.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    showError("Port must be a number between 1 and 65535.");
    return;
  }
  const token = tokenInput.value.trim();
  await saveSettings({ token, port });
  hasToken = token !== "";
  savedText.hidden = false;
  await request({ type: "getState" });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && "connection" in changes) {
    void request({ type: "getState" });
  }
});

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id;
  const settings = await loadSettings();
  tokenInput.value = settings.token;
  portInput.value = String(settings.port);
  hasToken = settings.token !== "";
  settingsDetails.open = !hasToken;
  await request({ type: "getState" });
}

void init();
