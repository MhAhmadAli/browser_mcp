#!/usr/bin/env node
import path from "node:path";

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InvalidArgumentError, program } from "commander";

import { config } from "@/config";
import { PORT_COUNT } from "@/protocol";
import type { Resource } from "@/resources/resource";
import { createServerWithTools } from "@/server";
import { getOrCreateToken } from "@/token";
import * as common from "@/tools/common";
import * as custom from "@/tools/custom";
import * as snapshot from "@/tools/snapshot";
import type { Tool } from "@/tools/tool";
import { debugLog } from "@/utils/log";

import packageJSON from "../package.json";

function setupExitWatchdog(server: Server) {
  process.stdin.on("close", async () => {
    setTimeout(() => process.exit(0), 15000);
    await server.close();
    process.exit(0);
  });
}

const commonTools: Tool[] = [common.pressKey, common.wait];

const customTools: Tool[] = [custom.getConsoleLogs, custom.screenshot];

const snapshotTools: Tool[] = [
  common.navigate(true),
  common.goBack(true),
  common.goForward(true),
  snapshot.snapshot,
  snapshot.click,
  snapshot.hover,
  snapshot.type,
  snapshot.selectOption,
  snapshot.drag,
  ...commonTools,
  ...customTools,
];

const resources: Resource[] = [];

async function createServer(port: number | undefined, token: string) {
  return createServerWithTools({
    name: config.name,
    version: packageJSON.version,
    tools: snapshotTools,
    resources,
    port,
    token,
  });
}

/** Explains the silence when the server is started by hand, as stdout carries the MCP protocol. */
function printInteractiveHint(port: number) {
  const script = path.relative(process.cwd(), process.argv[1]) || process.argv[1];
  debugLog(
    [
      `${config.name} server is running; the browser extension can connect on port ${port}.`,
      "It's meant to be started by your MCP client, which talks to it over stdin/stdout, so it prints nothing else.",
      `To get the pairing token for the extension, run: node ${script} token`,
      "Press Ctrl+C to stop.",
    ].join("\n"),
  );
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError("Must be a port number between 1 and 65535.");
  }
  return port;
}

/**
 * Note: Tools must be defined *before* calling `createServer` because only declarations are hoisted, not the initializations
 */
program
  .version("Version " + packageJSON.version)
  .name(packageJSON.name)
  .option(
    "-p, --port <port>",
    `port the browser extension connects to (default: the first free one from ${config.defaultWsPort} to ${config.defaultWsPort + PORT_COUNT - 1})`,
    parsePort,
  )
  .action(async (options: { port?: number }) => {
    const token = await getOrCreateToken();
    const { server, port } = await createServer(options.port, token);
    setupExitWatchdog(server);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    if (process.stdin.isTTY) {
      printInteractiveHint(port);
    }
  });

program
  .command("token")
  .description("print the pairing token to paste into the browser extension")
  .action(async () => {
    console.log(await getOrCreateToken());
  });

program.parse(process.argv);
