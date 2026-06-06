import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { requireDotaPaths } from "../dota/paths.js";
import { Vpk } from "../dota/vpk.js";
import { searchWorkshop } from "../dota/workshop.js";
import { downloadWorkshopItem, steamcmdWorkshopDir } from "../dota/steamcmd.js";
import { pathExists, readTextFile } from "../util/fsx.js";
import { json, error, guard, ToolResult } from "../util/result.js";

// Item files may live in the Steam client's subscribed dir OR the SteamCMD download dir.
async function itemBaseDirs(): Promise<string[]> {
  const dota = await requireDotaPaths();
  return [dota.workshopContentDir, steamcmdWorkshopDir()];
}

async function resolveVpk(id: string): Promise<string | undefined> {
  for (const base of await itemBaseDirs()) {
    const itemDir = join(base, id);
    if (!(await pathExists(itemDir))) continue;
    const preferred = join(itemDir, id + ".vpk");
    if (await pathExists(preferred)) return preferred;
    const files = (await readdir(itemDir).catch(() => [])).filter((f) => /\.vpk$/i.test(f));
    if (files.length) return join(itemDir, files[0]);
  }
  return undefined;
}

async function titleOf(base: string, id: string): Promise<string | undefined> {
  const pd = join(base, id, "publish_data.txt");
  if (!(await pathExists(pd))) return undefined;
  const m = (await readTextFile(pd)).text.match(/"title"\s*"([^"]*)"/);
  return m ? m[1] : undefined;
}

export function registerWorkshopTools(server: McpServer) {
  server.registerTool(
    "workshop_search",
    {
      title: "Search custom games by name",
      description:
        "Search Dota 2 custom games on the Steam Workshop by name (the external equivalent of the client's " +
        "SteamUGC query). Returns published-file ids, titles and subscriber counts — feed an id to workshop_download.",
      inputSchema: { query: z.string(), limit: z.number().int().positive().max(30).optional() },
    },
    guard(async ({ query, limit }): Promise<ToolResult> => {
      const hits = await searchWorkshop(query, limit ?? 12);
      if (!hits.length) return error(`No custom games found for "${query}".`);
      const lines = hits.map((h) => `  ${h.id}  ${h.title}${h.subscriptions != null ? `  (${h.subscriptions.toLocaleString()} subs` : ""}${h.fileSizeMB ? `, ${h.fileSizeMB}MB)` : h.subscriptions != null ? ")" : ""}`);
      return json({ query, count: hits.length, results: hits }, lines.join("\n"));
    }),
  );

  server.registerTool(
    "workshop_download",
    {
      title: "Download a custom game (outside the game)",
      description:
        "Download a custom game's files by workshop id using SteamCMD (anonymous — works for Dota app 570; this is " +
        "the external equivalent of SteamUGC.SubscribeItem). SteamCMD auto-installs on first use (Windows). After " +
        "downloading, study it with workshop_inspect / workshop_read.",
      inputSchema: { id: z.string().describe("Workshop published-file id (from workshop_search).") },
    },
    guard(async ({ id }): Promise<ToolResult> => {
      const res = await downloadWorkshopItem(id);
      if (!res.ok) {
        return error(`Download of ${id} did not complete.\n${res.log.slice(-1200)}`);
      }
      const vpk = await resolveVpk(id);
      return json(
        { id, path: res.path, vpk, ok: true },
        `Downloaded ${id} -> ${res.path}\n${vpk ? "Inspect it: workshop_inspect id=\"" + id + "\"" : "(no .vpk found in the item)"}`,
      );
    }),
  );

  server.registerTool(
    "workshop_list",
    {
      title: "List local custom games",
      description: "List custom games available locally — both Steam-subscribed (content/570) and SteamCMD-downloaded — with id + title.",
      inputSchema: { query: z.string().optional() },
    },
    guard(async ({ query }): Promise<ToolResult> => {
      const bases = await itemBaseDirs();
      const seen = new Set<string>();
      const items: { id: string; title: string; source: string }[] = [];
      for (const base of bases) {
        if (!(await pathExists(base))) continue;
        for (const id of (await readdir(base)).filter((d) => /^\d+$/.test(d))) {
          if (seen.has(id)) continue;
          seen.add(id);
          const title = (await titleOf(base, id)) ?? "(unknown)";
          if (query && !(`${id} ${title}`.toLowerCase().includes(query.toLowerCase()))) continue;
          items.push({ id, title, source: base.includes("steamcmd") ? "steamcmd" : "subscribed" });
        }
      }
      return json({ count: items.length, items }, items.map((i) => `  ${i.id}  ${i.title}  [${i.source}]`).join("\n") || "No local custom games. Use workshop_search + workshop_download.");
    }),
  );

  server.registerTool(
    "workshop_inspect",
    {
      title: "Inspect a custom game's files",
      description: "Open a local custom game's VPK and inventory it (file counts by type/dir + key script/map/panorama paths) to study how it's built.",
      inputSchema: { id: z.string(), filter: z.string().optional().describe("Only list paths containing this substring.") },
    },
    guard(async ({ id, filter }): Promise<ToolResult> => {
      const vpkPath = await resolveVpk(id);
      if (!vpkPath) return error(`No local VPK for ${id}. Download it first: workshop_download id="${id}".`);
      const vpk = await Vpk.open(vpkPath);
      const all = [...vpk.entries.keys()];
      if (filter) {
        const hits = all.filter((p) => p.includes(filter.toLowerCase())).slice(0, 200);
        return json({ id, count: hits.length, files: hits }, hits.join("\n") || `No files match "${filter}".`);
      }
      const byExt: Record<string, number> = {}, byTop: Record<string, number> = {};
      for (const p of all) { const e = p.split(".").pop()!; byExt[e] = (byExt[e] || 0) + 1; byTop[p.split("/")[0]] = (byTop[p.split("/")[0]] || 0) + 1; }
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
      description: "Read a text file (lua/txt/kv/xml/css/js) from a local custom game's VPK to study its implementation. Use workshop_inspect to find paths.",
      inputSchema: { id: z.string(), path: z.string().describe("e.g. 'scripts/vscripts/game/waves.lua'."), maxChars: z.number().int().positive().max(200000).optional() },
    },
    guard(async ({ id, path, maxChars }): Promise<ToolResult> => {
      const vpkPath = await resolveVpk(id);
      if (!vpkPath) return error(`No local VPK for ${id}. Download it first: workshop_download id="${id}".`);
      const vpk = await Vpk.open(vpkPath);
      try {
        const txt = await vpk.readText(path);
        const cap = maxChars ?? 20000;
        return json({ id, path, length: txt.length, truncated: txt.length > cap }, txt.length > cap ? txt.slice(0, cap) + `\n... (${txt.length - cap} more; raise maxChars)` : txt);
      } catch {
        return error(`"${path}" not found in ${id}. Use workshop_inspect to list paths.`);
      }
    }),
  );
}
