import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { requireDotaPaths } from "../dota/paths.js";
import { Vpk } from "../dota/vpk.js";
import { pathExists, readTextFile } from "../util/fsx.js";
import { json, error, guard, ToolResult } from "../util/result.js";

async function itemVpkPath(dir570: string, id: string): Promise<string | undefined> {
  const itemDir = join(dir570, id);
  if (!(await pathExists(itemDir))) return undefined;
  const preferred = join(itemDir, `${id}.vpk`);
  if (await pathExists(preferred)) return preferred;
  const files = (await readdir(itemDir).catch(() => [])).filter((f) => /\.vpk$/i.test(f));
  return files.length ? join(itemDir, files[0]) : undefined;
}

async function titleOf(dir570: string, id: string): Promise<string | undefined> {
  const pd = join(dir570, id, "publish_data.txt");
  if (!(await pathExists(pd))) return undefined;
  const m = (await readTextFile(pd)).text.match(/"title"\s*"([^"]*)"/);
  return m ? m[1] : undefined;
}

export function registerWorkshopTools(server: McpServer) {
  server.registerTool(
    "workshop_list",
    {
      title: "List subscribed custom games",
      description: "List installed/subscribed Dota 2 custom games (Steam Workshop items under content/570) with their id + title — reference games you can study.",
      inputSchema: { query: z.string().optional() },
    },
    guard(async ({ query }): Promise<ToolResult> => {
      const dota = await requireDotaPaths();
      if (!(await pathExists(dota.workshopContentDir))) return error(`No workshop content at ${dota.workshopContentDir}. Subscribe to a custom game in Steam first.`);
      const ids = (await readdir(dota.workshopContentDir)).filter((d) => /^\d+$/.test(d));
      const items = [];
      for (const id of ids) {
        const title = await titleOf(dota.workshopContentDir, id);
        const vpk = await itemVpkPath(dota.workshopContentDir, id);
        if (query && !(`${id} ${title ?? ""}`.toLowerCase().includes(query.toLowerCase()))) continue;
        items.push({ id, title: title ?? "(unknown)", hasVpk: !!vpk });
      }
      return json({ count: items.length, items }, items.map((i) => `  ${i.id}  ${i.title}${i.hasVpk ? "" : "  (no vpk)"}`).join("\n") || "No subscribed custom games found.");
    }),
  );

  server.registerTool(
    "workshop_inspect",
    {
      title: "Inspect a custom game's files",
      description: "Open a subscribed custom game's VPK and inventory it (file counts by type/dir + key script/map/panorama paths) so you can study how it's built.",
      inputSchema: { id: z.string().describe("Workshop item id (from workshop_list)."), filter: z.string().optional().describe("Only list paths containing this substring.") },
    },
    guard(async ({ id, filter }): Promise<ToolResult> => {
      const dota = await requireDotaPaths();
      const vpkPath = await itemVpkPath(dota.workshopContentDir, id);
      if (!vpkPath) return error(`No VPK for workshop item ${id}. Try workshop_list.`);
      const vpk = await Vpk.open(vpkPath);
      const all = [...vpk.entries.keys()];
      if (filter) {
        const hits = all.filter((p) => p.includes(filter.toLowerCase())).slice(0, 200);
        return json({ id, count: hits.length, files: hits }, hits.join("\n") || `No files match "${filter}".`);
      }
      const byExt: Record<string, number> = {}, byTop: Record<string, number> = {};
      for (const p of all) { const e = p.split(".").pop()!; byExt[e] = (byExt[e] || 0) + 1; const t = p.split("/")[0]; byTop[t] = (byTop[t] || 0) + 1; }
      const npc = all.filter((p) => p.startsWith("scripts/npc/") && p.endsWith(".txt"));
      const topVscripts = all.filter((p) => /^scripts\/vscripts\/[^/]+\.lua$/.test(p));
      const maps = all.filter((p) => p.startsWith("maps/") && p.endsWith(".vpk"));
      const summary = [
        `${all.length} files. by type: ${Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 14).map((e) => e[0] + ":" + e[1]).join("  ")}`,
        `by dir: ${Object.entries(byTop).sort((a, b) => b[1] - a[1]).map((e) => e[0] + ":" + e[1]).join("  ")}`,
        `npc kv: ${npc.map((p) => p.split("/").pop()).join(", ")}`,
        `top vscripts: ${topVscripts.map((p) => p.split("/").pop()).join(", ")}`,
        `maps: ${maps.map((p) => p.split("/").pop()).join(", ")}`,
      ].join("\n");
      return json({ id, total: all.length, byExt, byTop, npc, topVscripts, maps }, summary);
    }),
  );

  server.registerTool(
    "workshop_read",
    {
      title: "Read a file from a custom game",
      description: "Read a text file (lua/txt/kv/xml/css/js) from a subscribed custom game's VPK to study its implementation. Use workshop_inspect to find paths.",
      inputSchema: { id: z.string(), path: z.string().describe("e.g. 'scripts/vscripts/game/waves.lua'."), maxChars: z.number().int().positive().max(200000).optional() },
    },
    guard(async ({ id, path, maxChars }): Promise<ToolResult> => {
      const dota = await requireDotaPaths();
      const vpkPath = await itemVpkPath(dota.workshopContentDir, id);
      if (!vpkPath) return error(`No VPK for workshop item ${id}.`);
      const vpk = await Vpk.open(vpkPath);
      try {
        const txt = await vpk.readText(path);
        const cap = maxChars ?? 20000;
        return json({ id, path, length: txt.length, truncated: txt.length > cap }, txt.length > cap ? txt.slice(0, cap) + `\n... (${txt.length - cap} more; raise maxChars)` : txt);
      } catch {
        return error(`"${path}" not found in item ${id}. Use workshop_inspect to list paths.`);
      }
    }),
  );
}
