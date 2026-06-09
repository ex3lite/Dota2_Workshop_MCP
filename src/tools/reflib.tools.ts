// Reference-library tools — collect custom games into a persistent, searchable,
// self-scoring local code library, then search/read/curate it on demand. The "how do
// shipping games do X?" index, kept around between sessions.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import {
  harvest,
  loadIndex,
  searchLibrary,
  readLibraryFile,
  listLibraryFiles,
  curateLibrary,
  libraryStats,
  getPassport,
  findFiles,
} from "../dota/reflib.js";
import { resolveDataPath } from "../util/datapath.js";
import { json, error, guard, ToolResult } from "../util/result.js";

interface Pattern {
  name: string;
  category: string;
  summary: string;
  technique?: string;
  api?: string;
  source?: string;
}

export function registerReflibTools(server: McpServer) {
  server.registerTool(
    "ref_harvest",
    {
      title: "Harvest reference games into the library",
      description:
        "Collect custom games into the persistent reference library: search the Workshop by `query` (or pass explicit " +
        "`ids`), optionally download missing ones (download:true, via SteamCMD), extract their code (lua/KV/panorama), " +
        "score code quality, classify topics, and index it all. Returns what was ingested with scores. The library " +
        "lives under ~/.dota2-workshop-mcp/reflib (override DOTA2_REFLIB_DIR).",
      inputSchema: {
        query: z.string().optional().describe("Workshop search text, e.g. 'tower defense'."),
        ids: z.array(z.string()).optional().describe("Explicit workshop ids to ingest instead of searching."),
        limit: z.number().int().positive().max(20).optional().describe("Max games to ingest (default 5)."),
        download: z.boolean().optional().describe("Download missing games via SteamCMD before ingesting (default false)."),
        minSubscriptions: z.number().int().optional().describe("Skip games below this subscriber count."),
      },
    },
    guard(async ({ query, ids, limit, download, minSubscriptions }): Promise<ToolResult> => {
      if (!query && !(ids && ids.length)) return error("Provide `query` or `ids`.");
      const s = await harvest({ query, ids, limit, download, minSubscriptions });
      const lines = [
        `Considered ${s.considered.length}, ingested ${s.ingested.length}, skipped ${s.skipped.length}.`,
        ...s.ingested.map((i) => `  + ${i.id}  ${i.title}  [score ${i.score}/100, ${i.fileCount} files, topics: ${i.topics.join(",") || "—"}]`),
        ...s.skipped.map((k) => `  - ${k.id}  ${k.title}  (skipped: ${k.reason})`),
      ];
      return json(s as unknown as Record<string, unknown>, lines.join("\n"));
    }),
  );

  server.registerTool(
    "ref_harvest_top",
    {
      title: "Auto-harvest top games across genres",
      description:
        "Crawl the Workshop across many genres (tower defense, arena, auto chess, arpg, survival, custom hero, moba, " +
        "hook, minigame, boss) and harvest the top games of each into the reference library — the one-call way to " +
        "build/refresh a broad corpus. Pass download:true to fetch missing games via SteamCMD (can be large/slow).",
      inputSchema: {
        perGenre: z.number().int().positive().max(8).optional().describe("Top games per genre (default 2)."),
        download: z.boolean().optional().describe("Download missing games via SteamCMD (default false)."),
        minSubscriptions: z.number().int().optional(),
      },
    },
    guard(async ({ perGenre, download, minSubscriptions }): Promise<ToolResult> => {
      const GENRES = ["tower defense", "arena", "auto chess", "rpg dungeon", "survival horde", "custom hero", "moba", "pudge hook", "minigame", "boss fight"];
      const per = perGenre ?? 2;
      const ingested: string[] = [];
      const skipped: string[] = [];
      const seen = new Set<string>();
      for (const g of GENRES) {
        const s = await harvest({ query: g, limit: per, download, minSubscriptions });
        for (const it of s.ingested) {
          if (seen.has(it.id)) continue;
          seen.add(it.id);
          ingested.push(`${it.id} ${it.title} [score ${it.score}, ${g}]`);
        }
        for (const k of s.skipped) skipped.push(`${k.id} ${k.title} (${k.reason})`);
      }
      const lines = [
        `Crawled ${GENRES.length} genres × top ${per}. Ingested ${ingested.length}, skipped ${skipped.length}.`,
        ...ingested.map((x) => `  + ${x}`),
        ...(skipped.length ? ["skipped:", ...skipped.slice(0, 20).map((x) => `  - ${x}`)] : []),
      ];
      return json({ genres: GENRES, perGenre: per, ingestedCount: ingested.length, ingested, skipped }, lines.join("\n"));
    }),
  );

  server.registerTool(
    "ref_list",
    {
      title: "List the reference library",
      description: "List indexed reference games (best-quality first) with score, topics and file counts. Filter by topic.",
      inputSchema: { topic: z.string().optional().describe("Filter by classified topic (tower-defense, auto-chess, arpg, arena, ui-heavy, backend, …).") },
    },
    guard(async ({ topic }): Promise<ToolResult> => {
      const index = await loadIndex();
      let items = index.items;
      if (topic) items = items.filter((i) => i.topics.includes(topic));
      if (!items.length) return json({ count: 0, items: [] }, topic ? `No library items with topic "${topic}".` : "Library is empty. Use ref_harvest.");
      const lines = items.map(
        (i) => `  ${i.id}  ${i.title}\n     score ${i.score}/100 · ${i.fileCount} files · lua ${i.metrics.luaFiles}f/${i.metrics.luaLines}L · topics: ${i.topics.join(", ") || "—"}${i.metrics.obfuscated ? " · OBFUSCATED" : ""}`,
      );
      return json({ count: items.length, items }, lines.join("\n"));
    }),
  );

  server.registerTool(
    "ref_search",
    {
      title: "Search across reference code",
      description:
        "Full-text search across all extracted reference code (lua/KV/panorama). Returns matching file + line + " +
        "snippet, ranked so higher-quality games come first. Narrow with topic or a specific id. This is the fast way " +
        "to find 'how does a shipping game do X'.",
      inputSchema: {
        query: z.string().describe("Substring to find in the code, e.g. 'CreateUnitByName' or 'SpawnWave'."),
        topic: z.string().optional(),
        id: z.string().optional().describe("Restrict to one game's code."),
        limit: z.number().int().positive().max(80).optional(),
      },
    },
    guard(async ({ query, topic, id, limit }): Promise<ToolResult> => {
      const hits = await searchLibrary(query, { topic, id, limit });
      if (!hits.length) return error(`No matches for "${query}" in the library. (Harvest more with ref_harvest, or broaden the query.)`);
      const lines = hits.map((h) => `  [${h.score}] ${h.title} (${h.id})  ${h.path}:${h.line}\n      ${h.snippet}`);
      return json({ query, count: hits.length, results: hits }, lines.join("\n"));
    }),
  );

  server.registerTool(
    "ref_passport",
    {
      title: "Game passport (full contents census)",
      description:
        "Show a reference game's 'passport' — a full census of EVERYTHING it ships (not just lua): file counts by " +
        "type, total size, and rollups for vscripts, models, particles, textures, materials, sounds, panorama " +
        "(layout/styles/scripts/images), npc KV files, soundevents and maps — plus the quality score and topics. " +
        "The fast way to size up a game before diving in.",
      inputSchema: { id: z.string() },
    },
    guard(async ({ id }): Promise<ToolResult> => {
      const p = await getPassport(id);
      if (!p) return error(`No passport for ${id}. Unpack it first: workshop_download id="${id}" (or ref_harvest ids=["${id}"]).`);
      const inv = p.inventory;
      const a = p.assets;
      const lines = [
        `${p.title} (${id})`,
        `quality ${p.score}/100 · topics: ${p.topics.join(", ") || "—"}${p.subscriptions != null ? ` · ${p.subscriptions.toLocaleString()} subs` : ""}`,
        inv ? `VPK: ${inv.files} files, ${Math.round(inv.bytes / 1048576)} MB` : "",
        `extracted (searchable text): ${p.fileCount} files`,
        "",
        "contents:",
        a ? `  vscripts(lua): ${a.vscripts}   models: ${a.models}   particles: ${a.particles}   textures: ${a.textures}   materials: ${a.materials}   sounds: ${a.sounds}` : "",
        a ? `  panorama: ${a.panorama.layout} layout / ${a.panorama.styles} styles / ${a.panorama.scripts} scripts / ${a.panorama.images} images` : "",
        a ? `  npc KV: ${a.npcKv.join(", ") || "—"}` : "",
        a ? `  soundevents: ${a.soundevents.join(", ") || "—"}` : "",
        a ? `  maps: ${a.maps.join(", ") || "—"}` : "",
        "",
        inv
          ? "by type: " +
            Object.entries(inv.byExt)
              .sort((x, y) => y[1].count - x[1].count)
              .slice(0, 18)
              .map(([e, v]) => `${e}:${v.count}`)
              .join("  ")
          : "(no inventory — re-unpack to build the passport)",
      ].filter((x) => x !== "");
      return json(p as unknown as Record<string, unknown>, lines.join("\n"));
    }),
  );

  server.registerTool(
    "ref_find",
    {
      title: "Find any file by name across the library",
      description:
        "Search file PATHS across ALL unpacked games — ANY asset type (models, particles, textures, sounds, " +
        "materials, maps, panorama, lua, KV), not just code. e.g. find which games have a 'phoenix' particle, a " +
        "'tower' model, or a 'shop.css'. Filter with ext (e.g. 'vpcf', 'vmdl_c'), topic, or a single id. This is the " +
        "path-search complement to ref_search (which searches text content).",
      inputSchema: {
        query: z.string().describe("Substring to find in file paths, e.g. 'phoenix', 'tower', 'shop'."),
        ext: z.string().optional().describe("Only this extension, e.g. 'vpcf' (particles), 'vmdl_c' (models), 'css'."),
        topic: z.string().optional(),
        id: z.string().optional().describe("Restrict to one game."),
        limit: z.number().int().positive().max(300).optional(),
      },
    },
    guard(async ({ query, ext, topic, id, limit }): Promise<ToolResult> => {
      const hits = await findFiles(query, { ext, topic, id, limit });
      if (!hits.length) return error(`No files matching "${query}"${ext ? ` (.${ext})` : ""} in the library. (ref_harvest more games, or broaden the query.)`);
      const lines = hits.map((h) => `  ${h.title} (${h.id})  ${h.path}`);
      return json({ query, count: hits.length, results: hits }, lines.join("\n"));
    }),
  );

  server.registerTool(
    "ref_inspect",
    {
      title: "List a reference game's files",
      description: "List the extracted source files for one library game (filter by substring) — find a path to read with ref_get.",
      inputSchema: { id: z.string(), filter: z.string().optional() },
    },
    guard(async ({ id, filter }): Promise<ToolResult> => {
      const files = await listLibraryFiles(id, filter);
      if (!files.length) return error(`No files for ${id}${filter ? ` matching "${filter}"` : ""}. Harvest it first with ref_harvest ids=["${id}"].`);
      return json({ id, count: files.length, files }, files.join("\n"));
    }),
  );

  server.registerTool(
    "ref_get",
    {
      title: "Read a reference file",
      description: "Read one extracted source file from a library game (use ref_inspect/ref_search to find the path).",
      inputSchema: { id: z.string(), path: z.string(), maxChars: z.number().int().positive().max(200000).optional() },
    },
    guard(async ({ id, path, maxChars }): Promise<ToolResult> => {
      try {
        const r = await readLibraryFile(id, path, maxChars);
        return json({ id, path, length: r.length, truncated: r.truncated }, r.text);
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }),
  );

  server.registerTool(
    "ref_curate",
    {
      title: "Curate (prune) the library",
      description:
        "Remove low-quality or obfuscated games from the library (score below minScore, default 20). Pass dryRun:true " +
        "to preview what would be removed without deleting.",
      inputSchema: { minScore: z.number().int().min(0).max(100).optional(), dryRun: z.boolean().optional() },
    },
    guard(async ({ minScore, dryRun }): Promise<ToolResult> => {
      const r = await curateLibrary({ minScore, dryRun });
      const lines = [
        `${dryRun ? "[dry run] " : ""}removed ${r.removed.length}, kept ${r.kept}.`,
        ...r.removed.map((x) => `  - ${x.id}  ${x.title}  (${x.reason}, score ${x.score})`),
      ];
      return json(r as unknown as Record<string, unknown>, lines.join("\n"));
    }),
  );

  server.registerTool(
    "ref_recipe",
    {
      title: "Recipe: patterns + reference code for a topic",
      description:
        "Bridge the design knowledge to runnable references: for a topic/keyword, return the matching dota_patterns " +
        "(with the technique + the game it came from) AND the exact files in the reference library that implement it " +
        "(ready to open with ref_get). The fast path from 'how do I do X?' to real code. E.g. 'save code', 'wave', " +
        "'toast', 'talent', 'shop', 'rpc', 'leaderboard'.",
      inputSchema: { query: z.string(), limit: z.number().int().positive().max(40).optional() },
    },
    guard(async ({ query, limit }): Promise<ToolResult> => {
      const q = query.toLowerCase();
      // 1) Matching patterns from the KB.
      const data = JSON.parse(await readFile(await resolveDataPath("patterns.json"), "utf8")) as { patterns: Pattern[] };
      const patterns = data.patterns.filter((p) => JSON.stringify(p).toLowerCase().includes(q));
      // 2) Matching reference code.
      const refs = await searchLibrary(query, { limit: limit ?? 20 });

      if (!patterns.length && !refs.length) {
        return error(`No patterns or reference code match "${query}". Try a broader term, or ref_harvest to grow the library.`);
      }
      const lines: string[] = [];
      if (patterns.length) {
        lines.push(`PATTERNS (${patterns.length}):`);
        for (const p of patterns) lines.push(`  [${p.category}] ${p.name}\n     ${p.summary}${p.technique ? `\n     how: ${p.technique}` : ""}${p.source ? `\n     seen in: ${p.source}` : ""}`);
      }
      if (refs.length) {
        lines.push("", `REFERENCE CODE (${refs.length}) — open with ref_get:`);
        for (const h of refs) lines.push(`  [${h.score}] ${h.title} (${h.id})  ${h.path}:${h.line}\n     ${h.snippet}`);
      } else {
        lines.push("", "REFERENCE CODE: none in the local library yet — run ref_harvest to collect games, then re-run.");
      }
      return json({ query, patterns, references: refs }, lines.join("\n"));
    }),
  );

  server.registerTool(
    "ref_stats",
    {
      title: "Reference library stats",
      description: "Summarize the reference library: item count, size, topic breakdown, and where it's stored on disk.",
      inputSchema: {},
    },
    guard(async (): Promise<ToolResult> => {
      const s = await libraryStats();
      const summary = [
        `${s.count} games · ${Math.round(s.totalBytes / 1024)} KB extracted`,
        `dir: ${s.dir}`,
        `topics: ${Object.entries(s.byTopic).map(([t, n]) => `${t}:${n}`).join("  ") || "—"}`,
      ].join("\n");
      return json(s as unknown as Record<string, unknown>, summary);
    }),
  );
}
