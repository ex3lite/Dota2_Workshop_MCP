import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveProject } from "../config.js";
import {
  scaffoldAbility,
  scaffoldModifier,
  scaffoldItem,
  scaffoldUnit,
  scaffoldHero,
  scaffoldPanoramaPanel,
  ScaffoldResult,
} from "../scaffold/scaffolders.js";
import {
  scaffoldNotifications,
  scaffoldNetTableBinding,
  scaffoldRpc,
  scaffoldSaveCodes,
  scaffoldHudPanel,
  scaffoldWaveSystem,
  scaffoldShop,
  scaffoldTalentTree,
} from "../scaffold/systems.js";
import { json, guard, ToolResult } from "../util/result.js";

const numOrStr = z.union([z.string(), z.number()]);
const valuesSchema = z.record(numOrStr).optional().describe("AbilityValues entries (name -> value).");

function renderResult(title: string, r: ScaffoldResult): ToolResult {
  const lines = [title];
  if (r.created.length) lines.push("Created:", ...r.created.map((f) => `  + ${f}`));
  if (r.modified.length) lines.push("Modified:", ...r.modified.map((f) => `  ~ ${f}`));
  if (r.notes.length) lines.push("Notes:", ...r.notes.map((n) => `  • ${n}`));
  return json({ created: r.created, modified: r.modified, notes: r.notes }, lines.join("\n"));
}

export function registerScaffoldTools(server: McpServer) {
  server.registerTool(
    "scaffold_ability",
    {
      title: "Scaffold an ability",
      description:
        "Create a new Lua/TypeScript ability: source file (TS @registerAbility for a TS template, else raw Lua), " +
        "the npc_abilities_custom.txt KV block (with BaseClass/ScriptFile/AbilityBehavior/AbilityValues), and " +
        "localization tokens. Language defaults to the project type.",
      inputSchema: {
        projectRoot: z.string().optional(),
        name: z.string().describe("Ability internal name = class name, e.g. 'my_hero_fireball'."),
        behavior: z.enum(["no_target", "point", "unit_target", "passive", "channeled"]).optional(),
        lang: z.enum(["ts", "lua"]).optional(),
        subPath: z.string().optional().describe("Subfolder under abilities/, e.g. 'heroes/my_hero'."),
        texture: z.string().optional(),
        castRange: numOrStr.optional(),
        castPoint: numOrStr.optional(),
        cooldown: numOrStr.optional(),
        manaCost: numOrStr.optional(),
        values: valuesSchema,
        displayName: z.string().optional(),
        description: z.string().optional(),
        overwrite: z.boolean().optional(),
      },
    },
    guard(async (args): Promise<ToolResult> => {
      const project = await resolveProject(args.projectRoot);
      const r = await scaffoldAbility(project, args as any);
      return renderResult(`Scaffolded ability "${args.name}".`, r);
    }),
  );

  server.registerTool(
    "scaffold_modifier",
    {
      title: "Scaffold a modifier",
      description:
        "Create a new modifier (TS @registerModifier for a TS template, else raw Lua with LinkLuaModifier). " +
        "Includes DeclareFunctions/OnCreated/CheckState stubs.",
      inputSchema: {
        projectRoot: z.string().optional(),
        name: z.string().describe("Modifier name, conventionally 'modifier_*'."),
        lang: z.enum(["ts", "lua"]).optional(),
        subPath: z.string().optional(),
        displayName: z.string().optional(),
        description: z.string().optional(),
        overwrite: z.boolean().optional(),
      },
    },
    guard(async (args): Promise<ToolResult> => {
      const project = await resolveProject(args.projectRoot);
      const r = await scaffoldModifier(project, args as any);
      return renderResult(`Scaffolded modifier "${args.name}".`, r);
    }),
  );

  server.registerTool(
    "scaffold_item",
    {
      title: "Scaffold an item",
      description: "Create a new item (item_lua) with source file, npc_items_custom.txt KV block, and localization tokens.",
      inputSchema: {
        projectRoot: z.string().optional(),
        name: z.string().describe("Item name, must start with 'item_'."),
        lang: z.enum(["ts", "lua"]).optional(),
        subPath: z.string().optional(),
        cost: numOrStr.optional(),
        shopTags: z.string().optional(),
        quality: z.string().optional(),
        texture: z.string().optional(),
        values: valuesSchema,
        displayName: z.string().optional(),
        description: z.string().optional(),
        overwrite: z.boolean().optional(),
      },
    },
    guard(async (args): Promise<ToolResult> => {
      const project = await resolveProject(args.projectRoot);
      const r = await scaffoldItem(project, args as any);
      return renderResult(`Scaffolded item "${args.name}".`, r);
    }),
  );

  server.registerTool(
    "scaffold_unit",
    {
      title: "Scaffold a unit",
      description: "Create a new unit (npc_units_custom.txt) with sensible creature defaults and a localization display-name token.",
      inputSchema: {
        projectRoot: z.string().optional(),
        name: z.string().describe("Unit key, e.g. 'npc_dota_my_creep'."),
        model: z.string().optional(),
        baseClass: z.string().optional().describe("Default 'npc_dota_creature'."),
        displayName: z.string().optional(),
        fields: z.record(numOrStr).optional().describe("Override/extra KV fields."),
        overwrite: z.boolean().optional(),
      },
    },
    guard(async (args): Promise<ToolResult> => {
      const project = await resolveProject(args.projectRoot);
      const r = await scaffoldUnit(project, args as any);
      return renderResult(`Scaffolded unit "${args.name}".`, r);
    }),
  );

  server.registerTool(
    "scaffold_hero",
    {
      title: "Scaffold a hero (override)",
      description:
        "Create a custom hero by overriding an existing one (the only supported way in custom games). Writes an " +
        "override_hero block with your ability list/fields to npc_heroes_custom.txt.",
      inputSchema: {
        projectRoot: z.string().optional(),
        name: z.string().describe("Custom hero key, e.g. 'npc_dota_hero_my_custom'."),
        overrideHero: z.string().describe("Existing hero to base on, e.g. 'npc_dota_hero_lina'."),
        abilities: z.array(z.string()).optional().describe("Ability names mapped to Ability1..N."),
        displayName: z.string().optional(),
        fields: z.record(numOrStr).optional(),
        overwrite: z.boolean().optional(),
      },
    },
    guard(async (args): Promise<ToolResult> => {
      const project = await resolveProject(args.projectRoot);
      const r = await scaffoldHero(project, args as any);
      return renderResult(`Scaffolded hero "${args.name}".`, r);
    }),
  );

  server.registerTool(
    "scaffold_panorama_panel",
    {
      title: "Scaffold a Panorama panel",
      description:
        "Create a Panorama UI panel: layout .xml + styles .css under content/panorama/.../custom_game, plus a TS " +
        "script under src/panorama (TS template). Reminds you to register it in the UI manifest.",
      inputSchema: {
        projectRoot: z.string().optional(),
        name: z.string().describe("Panel name (used for file names and ids)."),
        overwrite: z.boolean().optional(),
      },
    },
    guard(async (args): Promise<ToolResult> => {
      const project = await resolveProject(args.projectRoot);
      const r = await scaffoldPanoramaPanel(project, args as any);
      return renderResult(`Scaffolded panorama panel "${args.name}".`, r);
    }),
  );

  // ---- systems scaffolders (distilled from shipping games) ----------------
  server.registerTool(
    "scaffold_notifications",
    {
      title: "Scaffold a notification/toast system",
      description:
        "Generate a reusable toast / kill-feed bus distilled from shipping games: a Panorama panel (XML+CSS+JS) with " +
        "the pop-in scale-overshoot animation + upward-growing stack + fly-out, and a server-side `Notifications` Lua " +
        "module (Notifications:All/ToPlayer/ToTeam/Good/Bad) that drives it via custom game events. See the " +
        "panorama/animations-cookbook + hud-ux-patterns docs.",
      inputSchema: {
        projectRoot: z.string().optional(),
        name: z.string().optional().describe("Base name for the files (default 'mcp_notifications')."),
        overwrite: z.boolean().optional(),
      },
    },
    guard(async (args): Promise<ToolResult> => {
      const project = await resolveProject(args.projectRoot);
      const r = await scaffoldNotifications(project, args as any);
      return renderResult("Scaffolded notification system.", r);
    }),
  );

  server.registerTool(
    "scaffold_nettable_binding",
    {
      title: "Scaffold net-table sync helpers",
      description:
        "Generate the net-table glue used by polished games: a client JS helper (prime-and-subscribe — avoids the " +
        "'UI misses the first value' bug — plus a whole-table variant) and a server `NetSync` Lua module with a " +
        "frame-debounced writer (collapses many same-frame writes into one push). See scripting/custom-game-architecture.",
      inputSchema: {
        projectRoot: z.string().optional(),
        table: z.string().optional().describe("Example net-table name to reference in the generated comments."),
        overwrite: z.boolean().optional(),
      },
    },
    guard(async (args): Promise<ToolResult> => {
      const project = await resolveProject(args.projectRoot);
      const r = await scaffoldNetTableBinding(project, args as any);
      return renderResult("Scaffolded net-table sync helpers.", r);
    }),
  );

  server.registerTool(
    "scaffold_rpc",
    {
      title: "Scaffold an RPC layer (client⇄server)",
      description:
        "Generate request/response RPC over Dota's one-way custom events: a client helper (correlation-id, optional " +
        "timeout) and a server `Rpc` Lua router that runs handlers in coroutine.wrap+xpcall (so they can yield on " +
        "HTTP for a backend, and crashes don't kill the listener) and replies by id. See the dota_patterns KB.",
      inputSchema: { projectRoot: z.string().optional(), overwrite: z.boolean().optional() },
    },
    guard(async (args): Promise<ToolResult> => {
      const project = await resolveProject(args.projectRoot);
      const r = await scaffoldRpc(project, args as any);
      return renderResult("Scaffolded RPC layer.", r);
    }),
  );

  server.registerTool(
    "scaffold_save_codes",
    {
      title: "Scaffold a save/load code system",
      description:
        "Generate a persistence system distilled from shipping games: a self-contained `SaveCodes` Lua module that " +
        "encodes a flat map of integer fields into a shareable, checksum-protected code (pure-Lua URL-safe base64, no " +
        "deps) and decodes/validates it — plus an HTTP-backend variant using the net-table-delivered server-key " +
        "pattern for server-authoritative persistence. See the dota_patterns KB + scripting/custom-game-architecture.",
      inputSchema: {
        projectRoot: z.string().optional(),
        fields: z.array(z.string()).optional().describe("Ordered integer save fields (default level, gold, wins, unlocks)."),
        overwrite: z.boolean().optional(),
      },
    },
    guard(async (args): Promise<ToolResult> => {
      const project = await resolveProject(args.projectRoot);
      const r = await scaffoldSaveCodes(project, args as any);
      return renderResult("Scaffolded save-code system.", r);
    }),
  );

  server.registerTool(
    "scaffold_hud_panel",
    {
      title: "Scaffold an animated HUD panel",
      description:
        "Create a Panorama panel preloaded with the reusable micro-interactions from the cookbook: a class-driven " +
        "fly-in, GPU-cheap hover pop, an infinite rarity glow, a gradient title, and a net-table binding example " +
        "(XML + CSS + JS). A richer alternative to scaffold_panorama_panel for HUD work.",
      inputSchema: {
        projectRoot: z.string().optional(),
        name: z.string().describe("Panel name (file names + ids)."),
        overwrite: z.boolean().optional(),
      },
    },
    guard(async (args): Promise<ToolResult> => {
      const project = await resolveProject(args.projectRoot);
      const r = await scaffoldHudPanel(project, args as any);
      return renderResult(`Scaffolded HUD panel "${args.name}".`, r);
    }),
  );

  server.registerTool(
    "scaffold_wave_system",
    {
      title: "Scaffold a wave/round spawner",
      description:
        "Generate a declarative, data-driven wave/round spawner (survival/horde/arena) distilled from shipping games: " +
        "a `Waves` Lua module with a tunable WAVES table, a boss every N rounds, prep timers, live round-state on a " +
        "net table, and clear/leak callbacks — spawns at a named map entity. For tower-defense pathing use scaffold_td.",
      inputSchema: { projectRoot: z.string().optional(), overwrite: z.boolean().optional() },
    },
    guard(async (args): Promise<ToolResult> => {
      const project = await resolveProject(args.projectRoot);
      const r = await scaffoldWaveSystem(project, args as any);
      return renderResult("Scaffolded wave system.", r);
    }),
  );

  server.registerTool(
    "scaffold_shop",
    {
      title: "Scaffold a shop / store",
      description:
        "Generate an in-game shop: a Panorama grid panel (item cards with hover pop, item icons, cost, native " +
        "tooltips) that reads its catalog from a net table, plus a server `Shop` Lua module that publishes the " +
        "catalog and validates purchases (gold check + grant) replying via a custom event. Edit Shop.ITEMS to set " +
        "the catalog.",
      inputSchema: { projectRoot: z.string().optional(), overwrite: z.boolean().optional() },
    },
    guard(async (args): Promise<ToolResult> => {
      const project = await resolveProject(args.projectRoot);
      const r = await scaffoldShop(project, args as any);
      return renderResult("Scaffolded shop.", r);
    }),
  );

  server.registerTool(
    "scaffold_talent_tree",
    {
      title: "Scaffold a talent / upgrade tree",
      description:
        "Generate a tiered talent/upgrade tree: a Panorama panel rendering tiers of nodes with locked/available/" +
        "picked states (rarity glow on available), and a server `TalentTree` Lua module that validates picks (points " +
        "+ prerequisites), applies effects (hook in :Apply), and syncs per-player state via a net table. Edit " +
        "TalentTree.NODES to design the tree.",
      inputSchema: { projectRoot: z.string().optional(), overwrite: z.boolean().optional() },
    },
    guard(async (args): Promise<ToolResult> => {
      const project = await resolveProject(args.projectRoot);
      const r = await scaffoldTalentTree(project, args as any);
      return renderResult("Scaffolded talent tree.", r);
    }),
  );
}
