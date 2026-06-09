// Reference library — a persistent, self-curating store of custom-game source code
// harvested from the Steam Workshop. The MCP can collect games, extract their code
// (lua / KV / panorama), score code quality, classify topics, and search across the
// whole library on demand — a local "how do shipping games do X?" index.
//
// Layout (under reflibDir(), default ~/.dota2-workshop-mcp/reflib, override with
// DOTA2_REFLIB_DIR):
//   index.json                     — { generatedAt, items: ReflibItem[] }
//   items/<id>/meta.json           — full per-item metadata
//   items/<id>/files/<orig/path>   — extracted text source files
//   items/<id>/summary.md          — human-readable summary

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import { ensureDir, pathExists } from "../util/fsx.js";
import { Vpk } from "./vpk.js";
import { decompilePanorama, isCompiledPanorama, panoramaSourcePath } from "./panorama-decompile.js";
import { requireDotaPaths } from "./paths.js";
import { steamcmdWorkshopDir, downloadWorkshopItem } from "./steamcmd.js";
import { searchWorkshop, workshopDetails, WorkshopHit } from "./workshop.js";

export interface ReflibItem {
  id: string;
  title: string;
  subscriptions?: number;
  sizeMB?: number;
  topics: string[];
  score: number; // 0..100 quality estimate
  fileCount: number; // text files EXTRACTED to disk
  totalBytes: number;
  langStats: Record<string, number>; // bytes per extension (extracted text)
  addedAt: string;
  metrics: QualityMetrics;
  inventory?: Inventory; // full file census of the VPK (ALL types)
  assets?: Assets; // notable asset rollups for the "passport"
  notes?: string;
}

// A full census of every file in the game's VPK — not just the text we extract.
export interface Inventory {
  files: number; // total files in the VPK
  bytes: number; // total uncompressed bytes
  byExt: Record<string, { count: number; bytes: number }>; // every extension
  byDir: Record<string, number>; // top-level dir -> file count
}

// Human-meaningful rollups of what a game ships (the "passport").
export interface Assets {
  vscripts: number; // scripts/vscripts/**/*.lua
  npcKv: string[]; // scripts/npc/*.txt
  maps: string[]; // maps/*.vpk
  particles: number; // *.vpcf(_c)
  soundevents: string[]; // *.vsndevts(_c)
  sounds: number; // *.vsnd(_c)
  models: number; // *.vmdl(_c)
  textures: number; // *.vtex(_c)
  materials: number; // *.vmat(_c)
  panorama: { layout: number; styles: number; scripts: number; images: number };
}

export interface ReflibIndex {
  generatedAt: string;
  items: ReflibItem[];
}

export interface QualityMetrics {
  luaFiles: number;
  luaLines: number;
  commentRatio: number; // 0..1 over lua
  avgLineLength: number; // chars
  hasPanorama: boolean;
  hasModifiers: boolean;
  hasAbilities: boolean;
  obfuscated: boolean; // minified / encrypted heuristic
  classyLua: number; // count of class/module patterns
}

// ----- store paths --------------------------------------------------------

export function reflibDir(): string {
  return process.env.DOTA2_REFLIB_DIR || join(homedir(), ".dota2-workshop-mcp", "reflib");
}
function indexPath(): string {
  return join(reflibDir(), "index.json");
}
function itemDir(id: string): string {
  return join(reflibDir(), "items", id);
}

export async function loadIndex(): Promise<ReflibIndex> {
  const p = indexPath();
  if (!(await pathExists(p))) return { generatedAt: new Date().toISOString(), items: [] };
  try {
    return JSON.parse(await readFile(p, "utf8")) as ReflibIndex;
  } catch {
    return { generatedAt: new Date().toISOString(), items: [] };
  }
}

async function saveIndex(index: ReflibIndex): Promise<void> {
  await ensureDir(reflibDir());
  index.generatedAt = new Date().toISOString();
  index.items.sort((a, b) => b.score - a.score || (b.subscriptions ?? 0) - (a.subscriptions ?? 0));
  await writeFile(indexPath(), JSON.stringify(index, null, 2), "utf8");
}

// ----- code extraction + classification ------------------------------------

// Text source paths worth keeping (skip binary/compiled assets). Published VPKs ship
// Panorama COMPILED (.vxml_c/.vcss_c/.vjs_c) — we keep those and recover the embedded
// source (see decompilePanorama), since the UI/animation CSS is the high-value part.
function shouldKeep(path: string): boolean {
  if (/\.lua$/i.test(path) && path.startsWith("scripts/vscripts/")) return true;
  if (/scripts\/npc\/.*\.txt$/i.test(path)) return true;
  if (/scripts\/.*\.(txt|kv3)$/i.test(path)) return true;
  if (/^panorama\/.*\.(vxml_c|vcss_c|vjs_c|xml|css|js)$/i.test(path)) return true;
  return false;
}

const TOPIC_RULES: { topic: string; re: RegExp }[] = [
  { topic: "tower-defense", re: /\b(tower\s*defense|towerdef|\btd\b|wave|creep\s*spawn|maze|gemtd)/i },
  { topic: "auto-chess", re: /\b(underlord|autochess|auto\s*chess|chess|bench|tier\s*up|combine\s*units)/i },
  { topic: "arpg", re: /\b(dungeon|loot|inventory|rarity|epic|legendary|crafting|rpg)/i },
  { topic: "arena", re: /\b(overthrow|arena|deathmatch|free\s*for\s*all|ffa|kill\s*streak)/i },
  { topic: "survival", re: /\b(survival|wave\s*survival|horde|endless|night\s*and\s*day)/i },
  { topic: "moba", re: /\b(lane|tower|barracks|ancient|aegis|roshan)/i },
  { topic: "minigame", re: /\b(minigame|parkour|hide\s*and\s*seek|race|trivia)/i },
  { topic: "ui-heavy", re: /panorama\/layout\/custom_game\//i },
  { topic: "backend", re: /\b(CreateHTTPRequest|json\.encode|api\/|leaderboard|savecode|save\s*code)/i },
];

function classifyTopics(files: { path: string; text: string }[]): string[] {
  const blob = files.map((f) => f.path + "\n" + f.text.slice(0, 4000)).join("\n").toLowerCase();
  const topics = new Set<string>();
  for (const { topic, re } of TOPIC_RULES) if (re.test(blob)) topics.add(topic);
  return [...topics];
}

/** Pure quality heuristic over extracted files. Exported for unit testing. */
export function scoreQuality(files: { path: string; text: string }[]): { score: number; metrics: QualityMetrics } {
  const lua = files.filter((f) => /\.lua$/i.test(f.path));
  let luaLines = 0;
  let commentLines = 0;
  let charTotal = 0;
  let lineTotal = 0;
  let longLineFiles = 0;
  let classy = 0;
  for (const f of lua) {
    const lines = f.text.split(/\r?\n/);
    luaLines += lines.length;
    let maxLen = 0;
    for (const line of lines) {
      const t = line.trim();
      lineTotal++;
      charTotal += line.length;
      if (line.length > maxLen) maxLen = line.length;
      if (t.startsWith("--")) commentLines++;
    }
    if (maxLen > 2000) longLineFiles++; // minified / aeslua-encrypted single lines
    if (/(\bclass\b|setmetatable|__index|:new\s*\(|RegisterAbility|RegisterModifier|LinkLuaModifier)/.test(f.text)) classy++;
  }
  const commentRatio = lineTotal ? commentLines / lineTotal : 0;
  const avgLineLength = lineTotal ? charTotal / lineTotal : 0;
  const obfuscated = lua.length > 0 && (longLineFiles / lua.length > 0.3 || avgLineLength > 200 || files.some((f) => /aeslua|loadstring\(.{200,}/i.test(f.text)));
  const metrics: QualityMetrics = {
    luaFiles: lua.length,
    luaLines,
    commentRatio: Number(commentRatio.toFixed(3)),
    avgLineLength: Math.round(avgLineLength),
    hasPanorama: files.some((f) => /^panorama\//i.test(f.path)),
    hasModifiers: files.some((f) => /modifier/i.test(f.path) || /LinkLuaModifier/.test(f.text)),
    hasAbilities: files.some((f) => /abilit/i.test(f.path)),
    obfuscated,
    classyLua: classy,
  };

  // Score: reward substance + structure + readability; penalize obfuscation/triviality.
  let score = 0;
  score += Math.min(30, metrics.luaFiles * 1.5); // breadth of code
  score += Math.min(20, metrics.luaLines / 500); // volume (cap ~10k lines)
  score += Math.min(15, metrics.commentRatio * 100); // documented
  score += Math.min(10, classy * 1.5); // structured (classes/modules/registrations)
  if (metrics.hasPanorama) score += 8;
  if (metrics.hasModifiers) score += 5;
  if (metrics.hasAbilities) score += 4;
  if (avgLineLength > 0 && avgLineLength < 80) score += 5; // readable
  if (obfuscated) score -= 40;
  if (metrics.luaFiles === 0) score -= 20; // no studyable lua
  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, metrics };
}

// ----- vpk resolution ------------------------------------------------------

export async function resolveVpk(id: string): Promise<string | undefined> {
  const dota = await requireDotaPaths();
  for (const base of [dota.workshopContentDir, steamcmdWorkshopDir()]) {
    const dir = join(base, id);
    if (!(await pathExists(dir))) continue;
    const preferred = join(dir, id + ".vpk");
    if (await pathExists(preferred)) return preferred;
    const files = (await readdir(dir).catch(() => [])).filter((f) => /\.vpk$/i.test(f));
    // Prefer a directory VPK (Vpk.open needs *_dir.vpk to resolve split archives); never
    // pick a split part (_NNN.vpk) unless it's the only candidate.
    const chosen = files.find((f) => /_dir\.vpk$/i.test(f)) ?? files.find((f) => !/_\d{3}\.vpk$/i.test(f)) ?? files[0];
    if (chosen) return join(dir, chosen);
  }
  return undefined;
}

// ----- full inventory + asset passport -------------------------------------

/** Census EVERY file in the VPK (all types), with sizes — the basis of the passport. */
function buildInventory(vpk: Vpk): Inventory {
  const byExt: Record<string, { count: number; bytes: number }> = {};
  const byDir: Record<string, number> = {};
  let files = 0;
  let bytes = 0;
  for (const [path, e] of vpk.entries) {
    files++;
    const size = (e.length || 0) + (e.preload?.length || 0);
    bytes += size;
    const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "(none)";
    (byExt[ext] ??= { count: 0, bytes: 0 }).count++;
    byExt[ext].bytes += size;
    const top = path.split("/")[0];
    byDir[top] = (byDir[top] || 0) + 1;
  }
  return { files, bytes, byExt, byDir };
}

/** Roll the file list up into human-meaningful asset categories for the passport. */
function buildAssets(paths: string[]): Assets {
  const base = (p: string) => p.split("/").pop() || p;
  const count = (re: RegExp) => paths.filter((p) => re.test(p)).length;
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  return {
    vscripts: count(/^scripts\/vscripts\/.*\.lua$/i),
    // Only the top-level npc KV files (npc_*_custom.txt …), not the per-hero subfolder files.
    npcKv: uniq(paths.filter((p) => /^scripts\/npc\/[^/]+\.txt$/i.test(p)).map(base)),
    maps: uniq(paths.filter((p) => /^maps\/.*\.vpk$/i.test(p)).map(base)),
    particles: count(/\.vpcf(_c)?$/i),
    soundevents: uniq(paths.filter((p) => /\.vsndevts(_c)?$/i.test(p)).map(base)),
    sounds: count(/\.vsnd(_c)?$/i),
    models: count(/\.vmdl(_c)?$/i),
    textures: count(/\.vtex(_c)?$/i),
    materials: count(/\.vmat(_c)?$/i),
    panorama: {
      layout: count(/^panorama\/layout\/.*\.(xml|vxml_c)$/i),
      styles: count(/^panorama\/styles\/.*\.(css|vcss_c)$/i),
      scripts: count(/^panorama\/scripts\/.*\.(js|vjs_c)$/i),
      images: count(/^panorama\/images\//i),
    },
  };
}

// ----- harvest / index a single item ---------------------------------------

export interface HarvestOptions {
  maxFiles?: number;
  maxBytesPerFile?: number;
  maxTotalBytes?: number;
}

export async function ingestItem(
  id: string,
  hit: WorkshopHit | undefined,
  opts: HarvestOptions = {},
): Promise<ReflibItem> {
  const maxFiles = opts.maxFiles ?? 600;
  const maxBytesPerFile = opts.maxBytesPerFile ?? 256_000;
  const maxTotalBytes = opts.maxTotalBytes ?? 8_000_000;

  const vpkPath = await resolveVpk(id);
  if (!vpkPath) throw new Error(`No local VPK for ${id}. Download it first (workshop_download / harvest download:true).`);
  const vpk = await Vpk.open(vpkPath);
  const allPaths = [...vpk.entries.keys()].sort();
  const keep = allPaths.filter(shouldKeep);

  const dest = itemDir(id);
  await rm(join(dest, "files"), { recursive: true, force: true }).catch(() => {});
  await ensureDir(join(dest, "files"));

  // Full census of EVERY file (models/particles/sounds/textures/maps/…), plus a flat
  // path index so we can search any asset by name later (ref_find) without reopening VPKs.
  const inventory = buildInventory(vpk);
  const assets = buildAssets(allPaths);
  await writeFile(join(dest, "all-files.txt"), allPaths.join("\n"), "utf8");

  const extracted: { path: string; text: string }[] = [];
  let totalBytes = 0;
  let written = 0;
  for (const p of keep) {
    if (written >= maxFiles || totalBytes >= maxTotalBytes) break;
    let text: string;
    let storePath = p;
    try {
      if (isCompiledPanorama(p)) {
        text = decompilePanorama(await vpk.read(p), p);
        if (text.length < 8) continue; // nothing recoverable
        storePath = panoramaSourcePath(p);
      } else {
        text = await vpk.readText(p);
      }
    } catch {
      continue;
    }
    if (text.length > maxBytesPerFile) text = text.slice(0, maxBytesPerFile) + "\n-- ...(truncated by reflib)...";
    const outPath = join(dest, "files", ...storePath.split("/"));
    await ensureDir(dirname(outPath));
    await writeFile(outPath, text, "utf8");
    extracted.push({ path: storePath, text });
    totalBytes += text.length;
    written++;
  }

  const { score, metrics } = scoreQuality(extracted);
  const topics = classifyTopics(extracted);
  const langStats: Record<string, number> = {};
  for (const f of extracted) {
    const ext = (f.path.split(".").pop() || "?").toLowerCase();
    langStats[ext] = (langStats[ext] || 0) + f.text.length;
  }

  let title = hit?.title;
  let subscriptions = hit?.subscriptions;
  let sizeMB = hit?.fileSizeMB;
  if (!title || subscriptions == null) {
    const det = (await workshopDetails([id]).catch(() => []))[0];
    if (det) {
      title = title ?? det.title;
      subscriptions = subscriptions ?? det.subscriptions;
      sizeMB = sizeMB ?? det.fileSizeMB;
    }
  }

  const item: ReflibItem = {
    id,
    title: title ?? "(unknown)",
    subscriptions,
    sizeMB,
    topics,
    score,
    fileCount: extracted.length,
    totalBytes,
    langStats,
    addedAt: new Date().toISOString(),
    metrics,
    inventory,
    assets,
  };

  await writeFile(join(dest, "meta.json"), JSON.stringify(item, null, 2), "utf8");
  const topExt = Object.entries(inventory.byExt)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 16)
    .map(([e, v]) => `${e}:${v.count}`)
    .join("  ");
  await writeFile(
    join(dest, "summary.md"),
    `# ${item.title} (${id}) — passport\n\n` +
      `- quality score: **${score}/100** · topics: ${topics.join(", ") || "—"}\n` +
      `- VPK: **${inventory.files} files**, ${Math.round(inventory.bytes / 1048576)} MB\n` +
      `- extracted (searchable text): ${extracted.length} files (${Math.round(totalBytes / 1024)} KB)\n\n` +
      `## Contents\n` +
      `- vscripts (lua): ${assets.vscripts}\n` +
      `- models: ${assets.models} · particles: ${assets.particles} · textures: ${assets.textures} · materials: ${assets.materials} · sounds: ${assets.sounds}\n` +
      `- panorama: ${assets.panorama.layout} layout / ${assets.panorama.styles} styles / ${assets.panorama.scripts} scripts / ${assets.panorama.images} images\n` +
      `- npc KV: ${assets.npcKv.join(", ") || "—"}\n` +
      `- soundevents: ${assets.soundevents.join(", ") || "—"}\n` +
      `- maps: ${assets.maps.join(", ") || "—"}\n\n` +
      `## File census (top types)\n${topExt}\n\n` +
      `## Top extracted files\n` +
      extracted.slice(0, 40).map((f) => `- ${f.path}`).join("\n"),
    "utf8",
  );

  // Upsert into the index.
  const index = await loadIndex();
  index.items = index.items.filter((i) => i.id !== id);
  index.items.push(item);
  await saveIndex(index);
  return item;
}

export interface HarvestSummary {
  query?: string;
  considered: { id: string; title: string }[];
  ingested: ReflibItem[];
  skipped: { id: string; title: string; reason: string }[];
}

export async function harvest(args: {
  query?: string;
  ids?: string[];
  limit?: number;
  download?: boolean;
  minSubscriptions?: number;
}): Promise<HarvestSummary> {
  const limit = args.limit ?? 5;
  let candidates: WorkshopHit[] = [];
  if (args.ids?.length) {
    candidates = await workshopDetails(args.ids).catch(() => args.ids!.map((id) => ({ id, title: "(unknown)" })));
    if (!candidates.length) candidates = args.ids.map((id) => ({ id, title: "(unknown)" }));
  } else if (args.query) {
    candidates = await searchWorkshop(args.query, Math.max(limit * 2, limit));
  }
  if (args.minSubscriptions) candidates = candidates.filter((c) => (c.subscriptions ?? 0) >= args.minSubscriptions!);
  candidates = candidates.slice(0, limit);

  const summary: HarvestSummary = { query: args.query, considered: candidates.map((c) => ({ id: c.id, title: c.title })), ingested: [], skipped: [] };
  for (const c of candidates) {
    try {
      let vpk = await resolveVpk(c.id);
      if (!vpk && args.download) {
        const dl = await downloadWorkshopItem(c.id);
        if (!dl.ok) {
          summary.skipped.push({ id: c.id, title: c.title, reason: "download failed" });
          continue;
        }
        vpk = await resolveVpk(c.id);
      }
      if (!vpk) {
        summary.skipped.push({ id: c.id, title: c.title, reason: "not downloaded (pass download:true)" });
        continue;
      }
      const item = await ingestItem(c.id, c);
      summary.ingested.push(item);
    } catch (err) {
      summary.skipped.push({ id: c.id, title: c.title, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return summary;
}

// ----- search / read / list / curate ---------------------------------------

export interface RefSearchHit {
  id: string;
  title: string;
  path: string;
  line: number;
  snippet: string;
  score: number;
}

export async function searchLibrary(query: string, opts: { topic?: string; limit?: number; id?: string } = {}): Promise<RefSearchHit[]> {
  const index = await loadIndex();
  const q = query.toLowerCase();
  const limit = opts.limit ?? 30;
  let items = index.items;
  if (opts.id) items = items.filter((i) => i.id === opts.id);
  if (opts.topic) items = items.filter((i) => i.topics.includes(opts.topic!));

  const hits: RefSearchHit[] = [];
  for (const item of items) {
    const filesDir = join(itemDir(item.id), "files");
    if (!(await pathExists(filesDir))) continue;
    for (const rel of await walk(filesDir)) {
      let text: string;
      try {
        text = await readFile(rel, "utf8");
      } catch {
        continue;
      }
      const lower = text.toLowerCase();
      let idx = lower.indexOf(q);
      while (idx >= 0 && hits.length < limit * 4) {
        const line = text.slice(0, idx).split(/\n/).length;
        const start = Math.max(0, idx - 50);
        const snippet = text.slice(start, idx + q.length + 80).replace(/\s+/g, " ").trim();
        hits.push({
          id: item.id,
          title: item.title,
          path: rel.slice(filesDir.length + 1).replace(/\\/g, "/"),
          line,
          snippet,
          score: item.score,
        });
        idx = lower.indexOf(q, idx + q.length);
        if (hits.filter((h) => h.id === item.id).length >= 5) break; // cap per item
      }
    }
  }
  // Prefer hits from higher-quality items.
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

export async function readLibraryFile(id: string, path: string, maxChars = 20_000): Promise<{ text: string; truncated: boolean; length: number }> {
  const full = join(itemDir(id), "files", ...path.split("/"));
  if (!(await pathExists(full))) throw new Error(`Not in library: ${id}/${path}. Use ref_inspect to list files.`);
  const text = await readFile(full, "utf8");
  return text.length > maxChars
    ? { text: text.slice(0, maxChars) + `\n... (${text.length - maxChars} more chars; raise maxChars)`, truncated: true, length: text.length }
    : { text, truncated: false, length: text.length };
}

export async function listLibraryFiles(id: string, filter?: string): Promise<string[]> {
  const filesDir = join(itemDir(id), "files");
  if (!(await pathExists(filesDir))) return [];
  const all = (await walk(filesDir)).map((f) => f.slice(filesDir.length + 1).replace(/\\/g, "/"));
  return (filter ? all.filter((p) => p.toLowerCase().includes(filter.toLowerCase())) : all).sort();
}

/** The full passport (meta.json incl. inventory + assets) for one game. */
export async function getPassport(id: string): Promise<ReflibItem | undefined> {
  const p = join(itemDir(id), "meta.json");
  if (!(await pathExists(p))) return undefined;
  try {
    return JSON.parse(await readFile(p, "utf8")) as ReflibItem;
  } catch {
    return undefined;
  }
}

export interface FileHit {
  id: string;
  title: string;
  path: string;
}

/**
 * Search file PATHS (any asset type — models/particles/sounds/textures/maps/…) across
 * the whole library, using each game's all-files.txt index. The "find any file by name"
 * complement to searchLibrary (which searches text CONTENT).
 */
export async function findFiles(query: string, opts: { topic?: string; id?: string; ext?: string; limit?: number } = {}): Promise<FileHit[]> {
  const index = await loadIndex();
  let items = index.items;
  if (opts.id) items = items.filter((i) => i.id === opts.id);
  if (opts.topic) items = items.filter((i) => i.topics.includes(opts.topic!));
  const q = query.toLowerCase();
  const ext = opts.ext ? opts.ext.toLowerCase().replace(/^\./, "") : null;
  const limit = opts.limit ?? 80;
  const hits: FileHit[] = [];
  for (const it of items) {
    if (hits.length >= limit) break;
    let paths: string[];
    try {
      paths = (await readFile(join(itemDir(it.id), "all-files.txt"), "utf8")).split("\n");
    } catch {
      continue;
    }
    for (const p of paths) {
      if (hits.length >= limit) break;
      if (!p) continue;
      if (ext && !p.toLowerCase().endsWith("." + ext)) continue;
      if (!p.toLowerCase().includes(q)) continue;
      hits.push({ id: it.id, title: it.title, path: p });
    }
  }
  return hits;
}

export interface CurateResult {
  removed: { id: string; title: string; score: number; reason: string }[];
  kept: number;
}

export async function curateLibrary(opts: { minScore?: number; dryRun?: boolean } = {}): Promise<CurateResult> {
  const minScore = opts.minScore ?? 20;
  const index = await loadIndex();
  const removed: CurateResult["removed"] = [];
  const keep: ReflibItem[] = [];
  for (const item of index.items) {
    if (item.score < minScore || item.metrics.obfuscated) {
      removed.push({ id: item.id, title: item.title, score: item.score, reason: item.metrics.obfuscated ? "obfuscated" : `score < ${minScore}` });
      if (!opts.dryRun) await rm(itemDir(item.id), { recursive: true, force: true }).catch(() => {});
    } else {
      keep.push(item);
    }
  }
  if (!opts.dryRun) {
    index.items = keep;
    await saveIndex(index);
  }
  return { removed, kept: keep.length };
}

export async function libraryStats(): Promise<{ count: number; totalBytes: number; byTopic: Record<string, number>; dir: string }> {
  const index = await loadIndex();
  const byTopic: Record<string, number> = {};
  let totalBytes = 0;
  for (const i of index.items) {
    totalBytes += i.totalBytes;
    for (const t of i.topics) byTopic[t] = (byTopic[t] || 0) + 1;
  }
  return { count: index.items.length, totalBytes, byTopic, dir: reflibDir() };
}
