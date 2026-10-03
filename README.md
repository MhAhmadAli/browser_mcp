<a href="https://browsermcp.io">
  <img src="./.github/images/banner.png" alt="Browser MCP banner">
</a>

<h3 align="center">Browser MCP</h3>

<p align="center">
  Automate your browser with AI.
  <br />
  <a href="https://browsermcp.io"><strong>Website</strong></a> 
  •
  <a href="https://docs.browsermcp.io"><strong>Docs</strong></a>
</p>

## About

Browser MCP is an MCP server + Chrome extension that allows you to automate your browser using AI applications like VS Code, Claude, Cursor, and Windsurf.

## Features

- ⚡ Fast: Automation happens locally on your machine, resulting in better performance without network latency.
- 🔒 Private: Since automation happens locally, your browser activity stays on your device and isn't sent to remote servers.
- 👤 Logged In: Uses your existing browser profile, keeping you logged into all your services.
- 🥷🏼 Stealth: Avoids basic bot detection and CAPTCHAs by using your real browser fingerprint.

## Running it locally

This repo contains both halves: the MCP server (`src/`) and the Chrome extension (`extension/`).

1. Build both: `npm install && npm run build && npm run build:extension`
2. Load the extension: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the `extension/dist` folder.
3. Add the server to your MCP client, for example:
   ```json
   { "command": "node", "args": ["/path/to/browser_mcp/dist/index.js"] }
   ```
4. Pair them: run `node dist/index.js token`, then paste the token into the extension's popup under **Settings** and click **Save**.
5. Open the tab the AI should control, click the extension icon and click **Connect**. Chrome shows a debugging banner while the tab is connected.

Each server takes the first free port from 9009 to 9018, and the extension connects to every server in that range, so several MCP clients (e.g. two chats in the same folder) can share the connected tab. To use other ports, start the server with `--port <port>` and set the extension's **First port** so the range includes it.

### Security model

- The server only listens on `127.0.0.1`, only accepts connections from this extension, and requires the pairing token stored in `~/.browser-mcp/token`.
- Only the tab you connect can be controlled, and only `http` and `https` pages can be opened.
- Page content is passed to the AI as is, so a malicious page can try to give it instructions. Avoid connecting a tab while you're logged in to sensitive accounts and browsing untrusted sites.

## Credits

Browser MCP was adapted from the [Playwright MCP server](https://github.com/microsoft/playwright-mcp) in order to automate the user's browser rather than creating new browser instances. This allows using the user's existing browser profile to use logged-in sessions and avoid bot detection mechanisms that commonly block automated browser use.
