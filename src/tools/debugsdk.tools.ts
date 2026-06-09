// DebugSDK tools: attach/detach the bundled in-game Lua debug module to an addon,
// and drive its `mcp_*` console commands over VConsole — evaluate Lua live and dump
// game state as JSON. The SDK is the deterministic control path for self-testing.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveProject } from "../config.js";
import { getVConsole, ConsoleLine } from "../dota/vconsole.js";
import { attachDebugSdk, detachDebugSdk } from "../dota/debugsdk.js";
import { json, error, guard, ToolResult } from "../util/result.js";

const VCON_HINT = "Could not reach VConsole. Launch the game in -tools mode and ensure the DebugSDK is attached + loaded.";

// Make arbitrary Lua safe to pass as ONE quoted console token: escape backslashes
// (the console tokenizer treats \ as an escape inside a quoted token), collapse newlines,
// and convert double quotes to single quotes (equivalent string delimiters in Lua).
export function quoteLua(code: string): string {
  return '"' + code.replace(/\\/g, "\\\\").replace(/\r?\n/g, " ").replace(/"/g, "'") + '"';
}

export function registerDebugSdkTools(server: McpServer) {
  server.registerTool(
    "addon_attach_debug_sdk",
    {
      title: "Attach the in-game DebugSDK",
      description:
        "Install the MCP DebugSDK (a self-contained Lua module) into the addon: copies mcp_debug.lua into the addon's " +
        "vscripts and wires require(\"mcp_debug\") into the game-mode bootstrap (addon_game_mode.ts for tstl, or the " +
        "compiled .lua otherwise). It registers mcp_* console commands (mcp_ping/state/dump/eval/assert/spawn/gold/" +
        "level/item/event/hud/pause) that dota_lua_eval, dota_debug_dump and dota_selftest drive. Idempotent. After " +
        "attaching: addon_build (tstl) then dota_restart_game.",
      inputSchema: { projectRoot: z.string().optional(), dryRun: z.boolean().optional() },
    },
    guard(async ({ projectRoot, dryRun }): Promise<ToolResult> => {
      const project = await resolveProject(projectRoot);
      const r = await attachDebugSdk(project, dryRun === true);
      const summary = [
        `DebugSDK ${r.dryRun ? "(dry run) " : ""}-> ${project.addonName}`,
        `copied: ${r.copiedTo.join(", ")}`,
        `bootstrap: ${r.bootstrapFile ?? "(none found)"} [${r.bootstrapAction}]`,
        "",
        ...r.instructions,
      ].join("\n");
      return json({ project: project.addonName, ...(r as unknown as Record<string, unknown>) }, summary);
    }),
  );

  server.registerTool(
    "addon_detach_debug_sdk",
    {
      title: "Detach the in-game DebugSDK",
      description: "Remove the MCP DebugSDK: deletes mcp_debug.lua copies and strips the require from the bootstrap. Rebuild/restart to take effect.",
      inputSchema: { projectRoot: z.string().optional() },
    },
    guard(async ({ projectRoot }): Promise<ToolResult> => {
      const project = await resolveProject(projectRoot);
      const r = await detachDebugSdk(project);
      return json(
        { project: project.addonName, ...(r as unknown as Record<string, unknown>) },
        `Detached from ${project.addonName}.\nremoved: ${r.removedFiles.join(", ") || "(none)"}\nbootstrap cleaned: ${r.bootstrapCleaned} (${r.bootstrapFile ?? "none"})`,
      );
    }),
  );

  server.registerTool(
    "dota_lua_eval",
    {
      title: "Evaluate Lua in the running game",
      description:
        "Run a Lua snippet on the server of the RUNNING game via the DebugSDK (mcp_eval) and return the JSON-encoded " +
        "result. Evaluated as an expression first (so `GameRules:GetGameTime()` returns a value), else as a statement. " +
        "Requires the DebugSDK attached + loaded. Tip: prefer single quotes inside Lua strings.",
      inputSchema: {
        code: z.string().describe("Lua expression or statements, e.g. '#HeroList:GetAllHeroes()' or 'GameRules:SetGoldPerTick(50)'."),
        timeoutMs: z.number().int().min(200).max(30000).optional(),
        vconPort: z.number().int().min(1).max(65535).optional(),
      },
    },
    guard(async ({ code, timeoutMs, vconPort }): Promise<ToolResult> => {
      const vc = getVConsole(vconPort);
      try {
        if (!vc.isConnected()) await vc.connect();
      } catch {
        return error(VCON_HINT);
      }
      const test = (l: ConsoleLine) => /\[MCP\] EVAL_(OK|ERR)/.test(l.text);
      const waitP = vc.waitForLine(test, timeoutMs ?? 5000);
      try {
        vc.send(`mcp_eval ${quoteLua(code)}`);
      } catch {
        return error(VCON_HINT);
      }
      const line = await waitP;
      if (!line) return error("No response from DebugSDK (mcp_eval). Is it attached & loaded? Try dota_send_console_command mcp_ping.");
      const ok = /\[MCP\] EVAL_OK/.test(line.text);
      const payload = line.text.replace(/^.*\[MCP\] EVAL_(OK|ERR)\s?/, "");
      let value: unknown = payload;
      if (ok) {
        try {
          value = JSON.parse(payload);
        } catch {
          /* keep raw */
        }
      }
      return json({ ok, code, result: value }, ok ? `=> ${payload}` : `ERROR: ${payload}`);
    }),
  );

  server.registerTool(
    "dota_debug_dump",
    {
      title: "Dump live game state",
      description:
        "Dump a section of the running game's state as JSON via the DebugSDK: 'state' (game time/phase/players), " +
        "'heroes' (per-hero level/hp/pos), 'units' (non-hero NPCs). Requires the DebugSDK attached + loaded.",
      inputSchema: {
        section: z.enum(["state", "heroes", "units", "nettables"]).optional(),
        timeoutMs: z.number().int().min(200).max(30000).optional(),
        vconPort: z.number().int().min(1).max(65535).optional(),
      },
    },
    guard(async ({ section, timeoutMs, vconPort }): Promise<ToolResult> => {
      const sec = section ?? "state";
      const vc = getVConsole(vconPort);
      try {
        if (!vc.isConnected()) await vc.connect();
      } catch {
        return error(VCON_HINT);
      }
      const test = (l: ConsoleLine) => l.text.includes("[MCP] DUMP") && l.text.includes(sec);
      const waitP = vc.waitForLine(test, timeoutMs ?? 5000);
      try {
        vc.send(`mcp_dump ${sec}`);
      } catch {
        return error(VCON_HINT);
      }
      const line = await waitP;
      if (!line) return error(`No DUMP response for "${sec}". Is the DebugSDK attached & loaded?`);
      // Array first: heroes/units dumps are a top-level [..]; an object-first alt would
      // wrongly capture the inner {..},{..} and fail to parse.
      const m = line.text.match(/(\[.*\]|\{.*\})\s*$/);
      let value: unknown = line.text;
      if (m) {
        try {
          value = JSON.parse(m[1]);
        } catch {
          /* keep raw */
        }
      }
      return json({ section: sec, data: value }, typeof value === "string" ? (value as string) : JSON.stringify(value, null, 2));
    }),
  );
}
