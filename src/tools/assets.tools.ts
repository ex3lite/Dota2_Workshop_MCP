import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { join, extname, relative } from "node:path";
import { readdir } from "node:fs/promises";
import { resolveProject } from "../config.js";
import { requireDotaPaths } from "../dota/paths.js";
import { openDotaVpk } from "../dota/vpk.js";
import { parseKV, getWrapperBlock, findPair, blockToObject, listBases, isBlock } from "../kv/index.js";
import { pathExists } from "../util/fsx.js";
import { json, error, guard, ToolResult } from "../util/result.js";

async function walk(dir: string, base: string, out: string[], cap: number, depth = 0): Promise<void> {
  if (out.length >= cap || depth > 8) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= cap) return;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      await walk(full, base, out, cap, depth + 1);
    } else {
      out.push(relative(base, full).replace(/\\/g, "/"));
    }
  }
}

const NPC_BASE_FILES: Record<string, string> = {
  heroes: "scripts/npc/npc_heroes.txt",
  abilities: "scripts/npc/npc_abilities.txt",
  items: "scripts/npc/items.txt",
  units: "scripts/npc/npc_units.txt",
};

export function registerAssetTools(server: McpServer) {
  server.registerTool(
    "assets_list",
    {
      title: "List addon assets",
      description:
        "List the addon's content + compiled game assets, grouped by type (vmap, vpcf, vmat, vmdl, vsndevts, vtex, …). " +
        "These are the assets available to reference from KV/scripts.",
      inputSchema: {
        projectRoot: z.string().optional(),
        type: z.string().optional().describe("Filter to one extension (without dot), e.g. 'vpcf'."),
      },
    },
    guard(async ({ projectRoot, type }): Promise<ToolResult> => {
      const project = await resolveProject(projectRoot);
      const files: string[] = [];
      for (const root of [project.contentDir, project.gameDir]) {
        if (await pathExists(root)) await walk(root, project.root, files, 5000);
      }
      const byExt = new Map<string, string[]>();
      for (const f of files) {
        const ext = extname(f).slice(1).toLowerCase();
        if (!ext) continue;
        if (type && ext !== type.toLowerCase()) continue;
        if (!byExt.has(ext)) byExt.set(ext, []);
        byExt.get(ext)!.push(f);
      }
      const summary = [...byExt.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([ext, list]) => `${ext} (${list.length})`)
        .join(", ");
      const result: Record<string, unknown> = { totalFiles: files.length, byType: Object.fromEntries([...byExt].map(([k, v]) => [k, v.length])) };
      if (type) result.files = byExt.get(type.toLowerCase()) ?? [];
      return json(result, `Assets by type: ${summary}` + (type ? `\n\n${(byExt.get(type.toLowerCase()) ?? []).slice(0, 100).join("\n")}` : ""));
    }),
  );

  server.registerTool(
    "assets_search",
    {
      title: "Search addon assets",
      description: "Search the addon's asset file paths by substring (optionally filtered by extension).",
      inputSchema: {
        projectRoot: z.string().optional(),
        query: z.string(),
        type: z.string().optional(),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    guard(async ({ projectRoot, query, type, limit }): Promise<ToolResult> => {
      const project = await resolveProject(projectRoot);
      const files: string[] = [];
      for (const root of [project.contentDir, project.gameDir]) {
        if (await pathExists(root)) await walk(root, project.root, files, 10000);
      }
      const q = query.toLowerCase();
      let hits = files.filter((f) => f.toLowerCase().includes(q));
      if (type) hits = hits.filter((f) => extname(f).slice(1).toLowerCase() === type.toLowerCase());
      hits = hits.slice(0, limit ?? 60);
      return json({ count: hits.length, files: hits }, hits.join("\n") || `No assets match "${query}".`);
    }),
  );

  server.registerTool(
    "vpk_find",
    {
      title: "Find base-game files (VPK)",
      description: "Search the base Dota content archive (pak01_dir.vpk) for file paths by substring — models, particles, sounds, scripts, etc.",
      inputSchema: { query: z.string(), limit: z.number().int().positive().max(300).optional() },
    },
    guard(async ({ query, limit }): Promise<ToolResult> => {
      const dota = await requireDotaPaths();
      if (!(await pathExists(dota.pak01DirVpk))) return error(`pak01_dir.vpk not found at ${dota.pak01DirVpk}`);
      const vpk = await openDotaVpk(dota.pak01DirVpk);
      const hits = vpk.list(query).slice(0, limit ?? 80);
      return json({ count: hits.length, files: hits }, hits.join("\n") || `No base-game files match "${query}".`);
    }),
  );

  server.registerTool(
    "vpk_read",
    {
      title: "Read a base-game file (VPK)",
      description: "Read a text file from the base Dota content archive (pak01_dir.vpk), e.g. 'scripts/npc/npc_heroes.txt'.",
      inputSchema: { path: z.string(), maxChars: z.number().int().positive().max(200000).optional() },
    },
    guard(async ({ path, maxChars }): Promise<ToolResult> => {
      const dota = await requireDotaPaths();
      const vpk = await openDotaVpk(dota.pak01DirVpk);
      try {
        const txt = await vpk.readText(path);
        const cap = maxChars ?? 20000;
        return json(
          { path, length: txt.length, truncated: txt.length > cap },
          txt.length > cap ? txt.slice(0, cap) + `\n... (${txt.length - cap} more chars; raise maxChars)` : txt,
        );
      } catch (e) {
        return error(`${e instanceof Error ? e.message : e}. Try vpk_find to locate the exact path.`);
      }
    }),
  );

  server.registerTool(
    "base_kv_entry",
    {
      title: "Get a base-game definition",
      description:
        "Read a base-game hero/ability/item/unit definition from the VPK and return one entry by key (e.g. " +
        "'npc_dota_hero_lina'). Useful to see the real fields before overriding/scaffolding. Note: #base includes " +
        "in the base file are reported but not auto-inlined.",
      inputSchema: {
        kind: z.enum(["heroes", "abilities", "items", "units"]),
        key: z.string(),
      },
    },
    guard(async ({ kind, key }): Promise<ToolResult> => {
      const dota = await requireDotaPaths();
      const vpk = await openDotaVpk(dota.pak01DirVpk);
      const file = NPC_BASE_FILES[kind];
      let txt: string;
      try {
        txt = await vpk.readText(file);
      } catch {
        return error(`Could not read ${file} from the VPK.`);
      }
      const doc = parseKV(txt);
      const wrapper = getWrapperBlock(doc);
      const pair = wrapper && findPair(wrapper, key);
      const bases = listBases(doc);
      if (!pair) {
        return json(
          { kind, key, found: false, bases },
          `"${key}" not directly in ${file}.` + (bases.length ? ` It may be in a #base include: ${bases.join(", ")} (read with vpk_read).` : ""),
        );
      }
      const value = isBlock(pair.value) ? blockToObject(pair.value) : pair.value;
      return json({ kind, key, found: true, bases, value }, JSON.stringify({ [key]: value }, null, 2).slice(0, 8000));
    }),
  );
}
