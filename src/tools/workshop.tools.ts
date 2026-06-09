import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { requireDotaPaths } from "../dota/paths.js";
import { Vpk } from "../dota/vpk.js";
import { searchWorkshop } from "../dota/workshop.js";
import { downloadWorkshopItem, steamcmdWorkshopDir } from "../dota/steamcmd.js";
import { ingestItem, reflibDir } from "../dota/reflib.js";
import { decompilePanorama, isCompiledPanorama, panoramaSourcePath } from "../dota/panorama-decompile.js";
import { pathExists, readTextFile, ensureDir } from "../util/fsx.js";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
    const chosen = files.find((f) => /_dir\.vpk$/i.test(f)) ?? files.find((f) => !/_\d{3}\.vpk$/i.test(f)) ?? files[0];
    if (chosen) return join(itemDir, chosen);
  }
  return undefined;
}

async function titleOf(base: string, id: string): Promise<string | undefined> {
  const pd = join(base, id, "publish_data.txt");
  if (!(await pathExists(pd))) return undefined;
  const m = (await readTextFile(pd)).text.match(/"title"\s*"([^"]*)"/);
  return m ? m[1] : undefined;
}

// All locally-available games: id + the base dir they live under (subscribed or steamcmd).
async function localGames(): Promise<{ id: string; base: string }[]> {
  const out: { id: string; base: string }[] = [];
  const seen = new Set<string>();
  for (const base of await itemBaseDirs()) {
    if (!(await pathExists(base))) continue;
    for (const id of (await readdir(base).catch(() => [])).filter((d) => /^\d+$/.test(d))) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, base });
    }
  }
  return out;
}

// Which VPK entries are searchable text (incl. compiled panorama we decompile on the fly).
function grepFilter(path: string, wantExt: string | null): boolean {
  if (wantExt) {
    if (path.endsWith("." + wantExt)) return true;
    if (wantExt === "css" && path.endsWith(".vcss_c")) return true;
    if (wantExt === "js" && path.endsWith(".vjs_c")) return true;
    if (wantExt === "xml" && path.endsWith(".vxml_c")) return true;
    return false;
  }
  return /\.(lua|txt|kv3|xml|css|js|vcss_c|vjs_c|vxml_c)$/i.test(path) && (path.startsWith("scripts/") || path.startsWith("panorama/"));
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
        "the external equivalent of SteamUGC.SubscribeItem). SteamCMD auto-installs on first use (Windows). By default " +
        "it then EXTRACTS the code (lua/KV/panorama) to disk and DECOMPILES the compiled Panorama (.vcss_c/.vjs_c/" +
        ".vxml_c → CSS/JS/XML) into the reference library, so the files are immediately browsable and searchable " +
        "(ref_search / ref_get / ref_recipe). Pass extract:false to only download the raw VPK.",
      inputSchema: {
        id: z.string().describe("Workshop published-file id (from workshop_search)."),
        extract: z.boolean().optional().describe("Extract + decompile into the reference library after download (default true)."),
      },
    },
    guard(async ({ id, extract }): Promise<ToolResult> => {
      const res = await downloadWorkshopItem(id);
      if (!res.ok) {
        return error(`Download of ${id} did not complete.\n${res.log.slice(-1200)}`);
      }
      const vpk = await resolveVpk(id);
      // Auto-extract + decompile panorama into the reference library (unless opted out).
      if (extract !== false && vpk) {
        try {
          const item = await ingestItem(id, undefined);
          return json(
            { id, path: res.path, vpk, ok: true, extracted: { files: item.fileCount, dir: join(reflibDir(), "items", id, "files"), topics: item.topics, score: item.score } },
            `Downloaded ${id} -> ${res.path}\n` +
              `Extracted ${item.fileCount} files (panorama decompiled) -> ${join(reflibDir(), "items", id, "files")}\n` +
              `Quality ${item.score}/100, topics: ${item.topics.join(", ") || "—"}.\n` +
              `Search it: ref_search query="..." id="${id}"  ·  raw VPK: workshop_inspect id="${id}".`,
          );
        } catch (e) {
          return json(
            { id, path: res.path, vpk, ok: true, extractError: e instanceof Error ? e.message : String(e) },
            `Downloaded ${id} -> ${res.path}\n(extract failed: ${e instanceof Error ? e.message : e}) — read the raw VPK with workshop_inspect / workshop_read.`,
          );
        }
      }
      return json(
        { id, path: res.path, vpk, ok: true, extracted: false },
        `Downloaded ${id} -> ${res.path}\n${vpk ? 'Inspect it: workshop_inspect id="' + id + '"' : "(no .vpk found in the item)"}`,
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
      description:
        "Read a text file (lua/txt/kv/xml/css/js) from a local custom game's VPK to study its implementation. " +
        "Published games ship Panorama COMPILED (.vcss_c/.vjs_c/.vxml_c) — this tool auto-decompiles them back to " +
        "source, and if you ask for a panorama .css/.js/.xml that isn't present it falls back to the compiled form. " +
        "Use workshop_inspect to find paths.",
      inputSchema: { id: z.string(), path: z.string().describe("e.g. 'scripts/vscripts/game/waves.lua' or 'panorama/styles/custom_game/hud.css'."), maxChars: z.number().int().positive().max(200000).optional() },
    },
    guard(async ({ id, path, maxChars }): Promise<ToolResult> => {
      const vpkPath = await resolveVpk(id);
      if (!vpkPath) return error(`No local VPK for ${id}. Download it first: workshop_download id="${id}".`);
      const vpk = await Vpk.open(vpkPath);
      // Resolve compiled panorama: read the .v*_c directly, or fall back to it when a
      // panorama source path (.css/.js/.xml) isn't shipped but the compiled one is.
      let readPath = path;
      let decompiled = false;
      if (isCompiledPanorama(path)) {
        decompiled = true;
      } else if (/^panorama\/.*\.(css|js|xml)$/i.test(path) && !vpk.entries.has(path.toLowerCase())) {
        const compiled = path.replace(/\.css$/i, ".vcss_c").replace(/\.js$/i, ".vjs_c").replace(/\.xml$/i, ".vxml_c");
        if (vpk.entries.has(compiled.toLowerCase())) {
          readPath = compiled;
          decompiled = true;
        }
      }
      try {
        const txt = decompiled ? decompilePanorama(await vpk.read(readPath), readPath) : await vpk.readText(readPath);
        const cap = maxChars ?? 20000;
        const head = decompiled && readPath !== path ? `(decompiled from ${readPath})\n` : "";
        const body = txt.length > cap ? txt.slice(0, cap) + `\n... (${txt.length - cap} more; raise maxChars)` : txt;
        return json({ id, path, readPath, decompiled, length: txt.length, truncated: txt.length > cap }, head + body);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Distinguish a genuinely-missing path from a real read/decompile failure.
        if (/Not found in VPK/i.test(msg)) return error(`"${path}" not found in ${id}. Use workshop_inspect to list paths.`);
        return error(`Failed to read "${path}" from ${id}: ${msg}`);
      }
    }),
  );

  server.registerTool(
    "workshop_grep",
    {
      title: "Search code across downloaded games",
      description:
        "Full-text search the CODE of locally-available custom games (Steam-subscribed + SteamCMD-downloaded) straight " +
        "from their VPKs — lua / KV / panorama (compiled .vcss_c/.vjs_c/.vxml_c are decompiled on the fly). Returns the " +
        "game + file + line + snippet for each match. Scope to one game with `id`, or search ALL local games (omit id; " +
        "slower). Filter to one extension with `ext` (e.g. 'lua') to go faster. " +
        "Use this to find how downloaded games do X without ingesting them first; for a curated, quality-ranked library " +
        "use ref_search instead.",
      inputSchema: {
        query: z.string().describe("Substring (or a regex with regex:true) to find in the code."),
        id: z.string().optional().describe("Restrict to one workshop id; omit to search every local game."),
        regex: z.boolean().optional(),
        ext: z.string().optional().describe("Only search this extension: lua/txt/kv3/xml/css/js (much faster)."),
        limit: z.number().int().positive().max(300).optional().describe("Max total matches (default 60)."),
        maxPerGame: z.number().int().positive().max(50).optional().describe("Max matches per game (default 6)."),
      },
    },
    guard(async ({ query, id, regex, ext, limit, maxPerGame }): Promise<ToolResult> => {
      const cap = limit ?? 60;
      const perGame = maxPerGame ?? 6;
      const wantExt = ext ? ext.toLowerCase().replace(/^\./, "") : null;
      let re: RegExp | undefined;
      if (regex) {
        try {
          re = new RegExp(query, "i");
        } catch (e) {
          return error(`Invalid regex: ${e instanceof Error ? e.message : e}`);
        }
      }
      const needle = query.toLowerCase();

      // Resolve targets: one game, or all local games.
      const all = await localGames();
      const targets = id ? all.filter((g) => g.id === id) : all;
      if (id && !targets.length) return error(`No local game ${id}. Download it first: workshop_download id="${id}".`);
      if (!targets.length) return error("No local custom games found. Use workshop_download or ref_harvest first.");

      const hits: { id: string; title: string; path: string; line: number; snippet: string }[] = [];
      const scanned: string[] = [];
      const skipped: string[] = [];
      for (const g of targets) {
        if (hits.length >= cap) break;
        const vpkPath = await resolveVpk(g.id);
        if (!vpkPath) {
          skipped.push(g.id);
          continue;
        }
        let vpk: Vpk;
        try {
          vpk = await Vpk.open(vpkPath);
        } catch {
          skipped.push(g.id);
          continue;
        }
        scanned.push(g.id);
        const title = (await titleOf(g.base, g.id)) ?? g.id;
        let n = 0;
        for (const key of vpk.entries.keys()) {
          if (n >= perGame || hits.length >= cap) break;
          if (!grepFilter(key, wantExt)) continue;
          let text: string;
          try {
            text = isCompiledPanorama(key) ? decompilePanorama(await vpk.read(key), key) : await vpk.readText(key);
          } catch {
            continue;
          }
          const idx = re ? text.search(re) : text.toLowerCase().indexOf(needle);
          if (idx < 0) continue;
          const matchLen = re ? (text.match(re)?.[0].length ?? query.length) : needle.length;
          const line = text.slice(0, idx).split(/\n/).length;
          const snippet = text.slice(Math.max(0, idx - 50), idx + matchLen + 90).replace(/\s+/g, " ").trim();
          hits.push({ id: g.id, title, path: isCompiledPanorama(key) ? panoramaSourcePath(key) : key, line, snippet });
          n++;
        }
      }

      if (!hits.length) {
        return json(
          { query, scanned: scanned.length, hits: [] },
          `No matches for ${re ? "/" + query + "/" : '"' + query + '"'} across ${scanned.length} local game(s).` +
            (id ? "" : " (Try scoping with id, or ext to widen file types.)"),
        );
      }
      const lines = hits.map((h) => `  ${h.title} (${h.id})  ${h.path}:${h.line}\n      ${h.snippet}`);
      return json(
        { query, scanned: scanned.length, count: hits.length, hits },
        `${hits.length} match(es) across ${scanned.length} game(s)${skipped.length ? ` (${skipped.length} unreadable)` : ""}:\n` + lines.join("\n"),
      );
    }),
  );

  server.registerTool(
    "panorama_decompile",
    {
      title: "Decompile a game's Panorama UI",
      description:
        "Recover Panorama UI source (CSS/JS/XML) from a local custom game's COMPILED resources (.vcss_c/.vjs_c/" +
        ".vxml_c). With `path`, returns one decompiled file. Without `path`, lists the panorama tree; pass `outDir` to " +
        "dump the whole decompiled tree to disk (as .css/.js/.xml) for offline study of how a shipping game's UI/" +
        "animations are built.",
      inputSchema: {
        id: z.string().describe("Workshop id of a locally-available game (workshop_download/ref_harvest first)."),
        path: z.string().optional().describe("A single panorama file, e.g. 'panorama/styles/custom_game/hud.vcss_c' (or the .css form)."),
        outDir: z.string().optional().describe("Write the whole decompiled panorama tree here (absolute path)."),
        maxChars: z.number().int().positive().max(200000).optional(),
        limit: z.number().int().positive().max(5000).optional().describe("Max files to dump (default 1000)."),
      },
    },
    guard(async ({ id, path, outDir, maxChars, limit }): Promise<ToolResult> => {
      const vpkPath = await resolveVpk(id);
      if (!vpkPath) return error(`No local VPK for ${id}. Download it first: workshop_download id="${id}".`);
      const vpk = await Vpk.open(vpkPath);

      // Single-file mode.
      if (path) {
        const lower = path.toLowerCase();
        const compiledKey = isCompiledPanorama(lower)
          ? lower
          : lower.replace(/\.css$/i, ".vcss_c").replace(/\.js$/i, ".vjs_c").replace(/\.xml$/i, ".vxml_c");
        let src: string;
        let readKey: string;
        let decompiled = false;
        if (vpk.entries.has(compiledKey)) {
          readKey = compiledKey;
          src = decompilePanorama(await vpk.read(compiledKey), compiledKey);
          decompiled = true;
        } else if (vpk.entries.has(lower)) {
          // Some games ship uncompiled source panorama — read it directly.
          readKey = lower;
          src = await vpk.readText(lower);
        } else {
          return error(`"${path}" (looked for ${compiledKey}) not in ${id}.`);
        }
        const cap = maxChars ?? 20000;
        return json(
          { id, path, readKey, decompiled, source: panoramaSourcePath(readKey), length: src.length },
          src.length > cap ? src.slice(0, cap) + `\n... (${src.length - cap} more; raise maxChars)` : src,
        );
      }

      // Tree mode: list (and optionally dump) all compiled panorama.
      const compiled = [...vpk.entries.keys()].filter((k) => k.startsWith("panorama/") && isCompiledPanorama(k)).sort();
      if (!compiled.length) return json({ id, count: 0 }, `No compiled panorama in ${id}.`);
      if (!outDir) {
        const sources = compiled.map(panoramaSourcePath);
        return json({ id, count: compiled.length, files: sources }, `${compiled.length} panorama files. Pass outDir to dump them, or path=<one> to view.\n` + sources.slice(0, 80).join("\n") + (sources.length > 80 ? `\n... (${sources.length - 80} more)` : ""));
      }
      const cap = limit ?? 1000;
      let written = 0;
      for (const key of compiled.slice(0, cap)) {
        try {
          const src = decompilePanorama(await vpk.read(key), key);
          if (src.length < 4) continue;
          const out = join(outDir, ...panoramaSourcePath(key).split("/"));
          await ensureDir(dirname(out));
          await writeFile(out, src, "utf8");
          written++;
        } catch {
          /* skip unreadable */
        }
      }
      return json({ id, outDir, written, total: compiled.length }, `Decompiled ${written}/${compiled.length} panorama files into ${outDir}.`);
    }),
  );
}
