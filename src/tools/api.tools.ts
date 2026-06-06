import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchApi, getClass, getFunction, getEnum, getMethod, apiStats } from "../api/search.js";
import { json, error, guard, ToolResult } from "../util/result.js";

export function registerApiTools(server: McpServer) {
  server.registerTool(
    "lua_api_search",
    {
      title: "Search the Dota VScript API",
      description:
        "Search the Dota 2 Lua (VScript) modding API by name or description across classes, global functions, " +
        "class methods, and enums/constants. Returns ranked matches with signatures.",
      inputSchema: {
        query: z.string().describe("Name fragment or keyword, e.g. 'CreateUnit', 'modifier', 'FindUnitsInRadius'."),
        kind: z.enum(["class", "function", "method", "enum", "all"]).optional(),
        available: z.enum(["server", "client"]).optional().describe("Filter functions/methods by availability."),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    guard(async ({ query, kind, available, limit }): Promise<ToolResult> => {
      const hits = await searchApi(query, { kind, available, limit });
      if (hits.length === 0) {
        const stats = await apiStats();
        return error(
          `No API matches for "${query}". (Indexed: ${stats.classes} classes, ${stats.functions} functions.)`,
        );
      }
      const lines = hits.map((h) => {
        const where = h.owner ? `${h.owner}:${h.name}` : h.name;
        return `[${h.kind}] ${h.signature ?? where}${h.description ? `  — ${h.description}` : ""}`;
      });
      return json({ query, count: hits.length, results: hits }, lines.join("\n"));
    }),
  );

  server.registerTool(
    "lua_api_get",
    {
      title: "Get API details",
      description:
        "Get full details for a class, global function, enum, or a class method. For a method use 'Class:Method' " +
        "or 'Class.Method'. For a class, methods are listed (optionally including inherited ones).",
      inputSchema: {
        name: z.string().describe("e.g. 'CDOTA_BaseNPC', 'CreateUnitByName', 'DOTA_UNIT_TARGET_TEAM', 'CDOTA_BaseNPC:AddAbility'."),
        includeInherited: z.boolean().optional().describe("For classes: include inherited methods (default false)."),
      },
    },
    guard(async ({ name, includeInherited }): Promise<ToolResult> => {
      // Method form: Class:Method or Class.Method
      const methodMatch = name.match(/^(.+?)[.:](.+)$/);
      if (methodMatch) {
        const res = await getMethod(methodMatch[1], methodMatch[2]);
        if (!res) return error(`Method "${name}" not found.`);
        return json({ kind: "method", owner: res.owner, method: res.method }, formatFn(res.method, res.owner));
      }

      const fn = await getFunction(name);
      if (fn) return json({ kind: "function", function: fn }, formatFn(fn));

      const cls = await getClass(name, !!includeInherited);
      if (cls) {
        const header = `class ${cls.name}${cls.extends ? ` extends ${cls.extends}` : ""}${cls.clientName ? ` (client: ${cls.clientName})` : ""}`;
        const desc = cls.description ? `\n${cls.description}\n` : "\n";
        const methods = cls.methods.map((m) => `  ${m.signature}`).join("\n");
        return json(
          { kind: "class", class: cls },
          `${header}${desc}methods (${cls.methods.length}):\n${methods}`,
        );
      }

      const en = await getEnum(name);
      if (en) {
        const body =
          en.kind === "constant"
            ? `constant ${en.name} = ${en.value}`
            : `enum ${en.name}\n` + (en.members ?? []).map((m) => `  ${m.name} = ${m.value}${m.description ? `  // ${m.description}` : ""}`).join("\n");
        return json({ kind: en.kind, enum: en }, body);
      }

      return error(`"${name}" not found in the VScript API. Try lua_api_search to discover the exact name.`);
    }),
  );

  server.registerTool(
    "lua_api_class_methods",
    {
      title: "List class methods",
      description: "List the methods of a VScript class, optionally including inherited methods and filtering by name fragment.",
      inputSchema: {
        className: z.string(),
        includeInherited: z.boolean().optional(),
        filter: z.string().optional().describe("Only methods whose name contains this fragment."),
      },
    },
    guard(async ({ className, includeInherited, filter }): Promise<ToolResult> => {
      const cls = await getClass(className, includeInherited ?? true);
      if (!cls) return error(`Class "${className}" not found.`);
      let methods = cls.methods;
      if (filter) methods = methods.filter((m) => m.name.toLowerCase().includes(filter.toLowerCase()));
      const inheritedFrom = (cls as any).inheritedFrom ?? {};
      const lines = methods.map((m) => `${m.signature}${inheritedFrom[m.name] ? `   (from ${inheritedFrom[m.name]})` : ""}`);
      return json(
        { class: cls.name, count: methods.length, methods },
        `${cls.name} — ${methods.length} methods:\n${lines.join("\n")}`,
      );
    }),
  );
}

function formatFn(m: { signature: string; description?: string; args: { name: string; type: string; description?: string }[]; available?: string }, owner?: string): string {
  const lines = [owner ? `${owner}:${m.signature}` : m.signature];
  if (m.available) lines.push(`available: ${m.available}`);
  if (m.description) lines.push("", m.description);
  if (m.args.length) {
    lines.push("", "params:");
    for (const a of m.args) lines.push(`  ${a.name}: ${a.type}${a.description ? ` — ${a.description}` : ""}`);
  }
  return lines.join("\n");
}
