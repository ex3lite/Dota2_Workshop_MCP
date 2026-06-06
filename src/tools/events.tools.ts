import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { join } from "node:path";
import { resolveProject } from "../config.js";
import { AddonProject } from "../dota/project.js";
import { readTextFile, writeTextFile, pathExists } from "../util/fsx.js";
import { json, error, guard, ToolResult } from "../util/result.js";

// Upsert one entry into a managed `interface X { ... }` declaration file (TS interface
// merging means a new global .d.ts adds to the engine-provided interface).
async function upsertDecl(
  filePath: string,
  interfaceName: string,
  entryName: string,
  entryType: string,
): Promise<"inserted" | "updated"> {
  const entries = new Map<string, string>();
  if (await pathExists(filePath)) {
    const { text } = await readTextFile(filePath);
    for (const m of text.matchAll(/^\s*([A-Za-z_]\w*)\s*:\s*(.+?);\s*$/gm)) entries.set(m[1], m[2]);
  }
  const action = entries.has(entryName) ? "updated" : "inserted";
  entries.set(entryName, entryType);
  const body = [...entries].map(([k, v]) => `    ${k}: ${v};`).join("\n");
  const content =
    `// Managed by dota2-workshop-mcp — augments ${interfaceName} via TS interface merging.\n` +
    `// Each key is a custom event/table name and its payload type.\n\n` +
    `interface ${interfaceName} {\n${body}\n}\n`;
  await writeTextFile(filePath, content, { encoding: "utf8" });
  return action;
}

function typeLiteral(fields?: Record<string, string>): string {
  if (!fields || Object.keys(fields).length === 0) return "Record<string, never>";
  return "{ " + Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("; ") + " }";
}

function commonDir(project: AddonProject): string {
  return join(project.root, "src", "common");
}

export function registerEventTools(server: McpServer) {
  server.registerTool(
    "scaffold_custom_event",
    {
      title: "Scaffold a custom game event",
      description:
        "Declare a typed custom game event (UI↔server) via interface merging in src/common, and return ready-to-use " +
        "send/subscribe snippets for vscripts (Lua) and Panorama (TS).",
      inputSchema: {
        projectRoot: z.string().optional(),
        name: z.string().describe("Event name, e.g. 'ui_panel_closed'."),
        fields: z.record(z.string()).optional().describe("Payload fields name->TS type, e.g. { PlayerID: 'PlayerID', amount: 'number' }."),
        direction: z.enum(["server_to_client", "client_to_server", "both"]).optional(),
      },
    },
    guard(async ({ projectRoot, name, fields, direction }): Promise<ToolResult> => {
      const project = await resolveProject(projectRoot);
      if (!project.tsVscriptsDir) return error("This project has no src/ (not a TS template); custom-event typing applies to TS templates.");
      const file = join(commonDir(project), "mcp_custom_events.d.ts");
      const action = await upsertDecl(file, "CustomGameEventDeclarations", name, typeLiteral(fields));

      const dir = direction ?? "both";
      const snippets: string[] = [];
      if (dir !== "client_to_server") {
        snippets.push(
          "// vscripts (server) -> send to a player:\n" +
            `CustomGameEventManager.Send_ServerToPlayer(player, "${name}", { ${Object.keys(fields ?? {}).map((k) => `${k}: /* ... */`).join(", ")} });`,
          `// Panorama (client) -> receive:\nGameEvents.Subscribe("${name}", (data) => { $.Msg(data); });`,
        );
      }
      if (dir !== "server_to_client") {
        snippets.push(
          `// Panorama (client) -> send to server:\nGameEvents.SendCustomGameEventToServer("${name}", { ${Object.keys(fields ?? {}).map((k) => `${k}: /* ... */`).join(", ")} });`,
          "// vscripts (server) -> receive:\n" +
            `CustomGameEventManager.RegisterListener("${name}", (_, data) => { print(data.PlayerID); });`,
        );
      }
      return json(
        { event: name, action, file },
        `${action} custom event "${name}" in ${file}\n\n${snippets.join("\n\n")}`,
      );
    }),
  );

  server.registerTool(
    "scaffold_net_table",
    {
      title: "Scaffold a custom net table",
      description:
        "Declare a typed custom net table via interface merging in src/common, and return set (server) / get + " +
        "subscribe (Panorama) snippets.",
      inputSchema: {
        projectRoot: z.string().optional(),
        name: z.string().describe("Net table name, e.g. 'scoreboard'."),
        valueType: z.string().optional().describe("TS type of each keyed value (default '{ [key: string]: any }')."),
      },
    },
    guard(async ({ projectRoot, name, valueType }): Promise<ToolResult> => {
      const project = await resolveProject(projectRoot);
      if (!project.tsVscriptsDir) return error("This project has no src/ (not a TS template).");
      const file = join(commonDir(project), "mcp_net_tables.d.ts");
      const vt = valueType ?? "{ [key: string]: any }";
      const action = await upsertDecl(file, "CustomNetTableDeclarations", name, `{ [key: string]: ${vt} }`);

      const snippets = [
        `// vscripts (server) -> set a value:\nCustomNetTables.SetTableValue("${name}", "someKey", { /* ... */ });`,
        `// Panorama (client) -> read a value:\nconst v = CustomNetTables.GetTableValue("${name}", "someKey");`,
        `// Panorama (client) -> react to changes:\nCustomNetTables.SubscribeNetTableListener("${name}", (table, key, value) => { $.Msg(key, value); });`,
      ];
      return json({ table: name, action, file }, `${action} net table "${name}" in ${file}\n\n${snippets.join("\n\n")}`);
    }),
  );
}
