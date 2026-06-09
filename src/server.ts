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
import { registerControlTools } from "./tools/control.tools.js";
import { registerDebugSdkTools } from "./tools/debugsdk.tools.js";
import { registerReflibTools } from "./tools/reflib.tools.js";
import { registerPreviewTools } from "./tools/preview.tools.js";
import { registerRecordTools } from "./tools/record.tools.js";
import { registerDiagnoseTools } from "./tools/diagnose.tools.js";
import { apiStats } from "./api/search.js";
import { panoramaStats } from "./api/panorama.js";
import { SHARING_GUIDE, SERVER_INSTRUCTIONS } from "./guide/sharing.js";

export const SERVER_INFO = { name: "dota2-workshop-mcp", version: "0.1.0" } as const;

export function createServer(): McpServer {
  // `instructions` are sent in the MCP `initialize` result and injected into the client's context
  // on connect — so the show/share/record guidance travels with the server, no separate skill file.
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

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
  registerControlTools(server);
  registerDebugSdkTools(server);
  registerReflibTools(server);
  registerPreviewTools(server);
  registerRecordTools(server);
  registerDiagnoseTools(server);

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

  // The full preview / share / record how-to, as a readable resource (the same knowledge the
  // server `instructions` summarize). Lets any client pull the complete guide on demand.
  server.registerResource(
    "sharing-guide",
    "dota://guide/sharing",
    {
      title: "How to preview / share / record Dota assets",
      description: "Inline previews, the shareable Cloudflare gallery, and recording motion to an animated GIF.",
      mimeType: "text/markdown",
    },
    async (uri) => ({ contents: [{ uri: uri.href, text: SHARING_GUIDE }] }),
  );

  // Invocable prompts so the guidance is one slash-command away (e.g. /mcp share_assets).
  server.registerPrompt(
    "share_assets",
    {
      title: "Show / share Dota assets",
      description: "How to preview, share (gallery link), and record Dota assets so the user can see or pick them.",
    },
    () => ({ messages: [{ role: "user", content: { type: "text", text: SHARING_GUIDE } }] }),
  );
  server.registerPrompt(
    "record_motion",
    {
      title: "Record the game as an animated GIF",
      description: "Record a short clip of the running game (or screen) and show it animated in chat via Read.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Record a short clip of the running Dota game and show it animated in chat.\n\n" +
              SHARING_GUIDE,
          },
        },
      ],
    }),
  );

  return server;
}
