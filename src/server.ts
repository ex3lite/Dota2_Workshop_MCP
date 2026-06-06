import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDiagnosticsTools } from "./tools/diagnostics.tools.js";
import { registerKvTools } from "./tools/kv.tools.js";
import { registerApiTools } from "./tools/api.tools.js";
import { registerScaffoldTools } from "./tools/scaffold.tools.js";
import { registerBuildTools } from "./tools/build.tools.js";
import { registerDebugTools } from "./tools/debug.tools.js";
import { registerDocsTools } from "./tools/docs.tools.js";
import { registerMapTools } from "./tools/map.tools.js";
import { registerSoundeventsTools } from "./tools/soundevents.tools.js";
import { registerAssetTools } from "./tools/assets.tools.js";
import { registerEventTools } from "./tools/events.tools.js";
import { registerMapGenTools } from "./tools/mapgen.tools.js";
import { registerWorkshopTools } from "./tools/workshop.tools.js";
import { apiStats } from "./api/search.js";
import { panoramaStats } from "./api/panorama.js";

export const SERVER_INFO = { name: "dota2-workshop-mcp", version: "0.1.0" } as const;

export function createServer(): McpServer {
  const server = new McpServer(SERVER_INFO);

  registerDiagnosticsTools(server);
  registerKvTools(server);
  registerApiTools(server);
  registerScaffoldTools(server);
  registerBuildTools(server);
  registerDebugTools(server);
  registerDocsTools(server);
  registerMapTools(server);
  registerSoundeventsTools(server);
  registerAssetTools(server);
  registerEventTools(server);
  registerMapGenTools(server);
  registerWorkshopTools(server);

  // A small read-only resource describing the bundled VScript API.
  server.registerResource(
    "vscript-api-info",
    "dota://api/info",
    { title: "Dota VScript API (bundled)", description: "Counts + generation time of the bundled VScript API data.", mimeType: "application/json" },
    async (uri) => {
      const [lua, panorama] = await Promise.all([apiStats(), panoramaStats()]);
      return { contents: [{ uri: uri.href, text: JSON.stringify({ vscript: lua, panorama }, null, 2) }] };
    },
  );

  return server;
}
