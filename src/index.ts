#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_INFO } from "./server.js";

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // IMPORTANT: log only to stderr — stdout is the JSON-RPC channel.
  console.error(`${SERVER_INFO.name} v${SERVER_INFO.version} running on stdio`);
}

main().catch((err) => {
  console.error("Fatal error starting dota2-workshop-mcp:", err);
  process.exit(1);
});
