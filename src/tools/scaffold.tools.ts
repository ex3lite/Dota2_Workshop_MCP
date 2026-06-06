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
}
