// SQLite index of every asset across the downloaded reference games — a fast, structured
// "find any model/particle/sound/texture by name" store, so search doesn't have to re-scan
// each game's all-files.txt on every query. Uses Node's built-in node:sqlite (Node >= 22.5
// with --experimental-sqlite; stable in Node 24+), so there is no external dependency.
//
// The index is a CACHE derived from the reference library — it can always be rebuilt from
// each game's all-files.txt (see rebuildAssetDb in reflib.ts). DB lives next to the library.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync, StatementSync } from "node:sqlite";

export function assetDbPath(): string {
  if (process.env.DOTA2_ASSETDB) return process.env.DOTA2_ASSETDB;
  // The index is a cache of the reference library, so it lives under the library dir — this
  // keeps it isolated whenever DOTA2_REFLIB_DIR is overridden (e.g. tests, separate corpora).
  // Mirrors reflibDir() without importing it (reflib.ts imports this module).
  const base = process.env.DOTA2_REFLIB_DIR || join(homedir(), ".dota2-workshop-mcp", "reflib");
  return join(base, "assets.db");
}

let db: DatabaseSync | undefined;

function open(): DatabaseSync {
  if (db) return db;
  const p = assetDbPath();
  mkdirSync(join(p, ".."), { recursive: true });
  db = new DatabaseSync(p);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      title TEXT,
      file_count INTEGER,
      indexed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS assets (
      game_id TEXT NOT NULL,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      ext TEXT,
      kind TEXT,
      dir TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_assets_name ON assets(name);
    CREATE INDEX IF NOT EXISTS idx_assets_kind ON assets(kind);
    CREATE INDEX IF NOT EXISTS idx_assets_ext ON assets(ext);
    CREATE INDEX IF NOT EXISTS idx_assets_game ON assets(game_id);
  `);
  return db;
}

/** For tests / explicit teardown. */
export function closeAssetDb(): void {
  db?.close();
  db = undefined;
}

export type AssetKind =
  | "model" | "texture" | "material" | "particle" | "sound" | "soundevent"
  | "map" | "script" | "kv" | "panorama" | "animation" | "other";

/** Classify a VPK inner path into a coarse asset kind (compiled `_c` suffix ignored). */
export function kindForPath(path: string): AssetKind {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const rawExt = dot >= 0 ? lower.slice(dot + 1) : "";
  const ext = rawExt.replace(/_c$/, "");
  switch (ext) {
    case "vmdl": return "model";
    case "vtex": return "texture";
    case "vmat": return "material";
    case "vpcf": return "particle";
    case "vsnd": return "sound";
    case "vsndevts": return "soundevent";
    case "vmap": return "map";
    case "vanim": case "vagrp": case "vseq": case "vphys": case "vmesh": return "animation";
    case "lua": return "script";
  }
  if (lower.startsWith("maps/") && ext === "vpk") return "map";
  if (lower.startsWith("panorama/") || ["xml", "css", "js", "vxml", "vcss", "vjs"].includes(ext)) return "panorama";
  if (lower.startsWith("scripts/") && (ext === "txt" || ext === "kv3")) return "kv";
  return "other";
}

function row(path: string, gameId: string): { game_id: string; path: string; name: string; ext: string; kind: string; dir: string } {
  const name = path.split("/").pop() || path;
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash) : "";
  return { game_id: gameId, path, name, ext, kind: kindForPath(path), dir };
}

/** Replace one game's rows in the index (idempotent upsert). */
export function indexGame(id: string, title: string, paths: string[]): number {
  const d = open();
  const insAsset: StatementSync = d.prepare("INSERT INTO assets (game_id, path, name, ext, kind, dir) VALUES (?, ?, ?, ?, ?, ?)");
  d.exec("BEGIN");
  try {
    d.prepare("DELETE FROM assets WHERE game_id = ?").run(id);
    d.prepare("DELETE FROM games WHERE id = ?").run(id);
    let n = 0;
    for (const p of paths) {
      if (!p) continue;
      const r = row(p, id);
      insAsset.run(r.game_id, r.path, r.name, r.ext, r.kind, r.dir);
      n++;
    }
    d.prepare("INSERT INTO games (id, title, file_count, indexed_at) VALUES (?, ?, ?, ?)").run(id, title, n, new Date().toISOString());
    d.exec("COMMIT");
    return n;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

export function removeGameFromDb(id: string): void {
  const d = open();
  d.prepare("DELETE FROM assets WHERE game_id = ?").run(id);
  d.prepare("DELETE FROM games WHERE id = ?").run(id);
}

export interface AssetSearchHit {
  game_id: string;
  title: string;
  path: string;
  name: string;
  ext: string;
  kind: string;
}

/** Fast structured asset search over the index. */
export function searchAssets(opts: {
  query?: string;
  kind?: string;
  ext?: string;
  id?: string;
  limit?: number;
}): AssetSearchHit[] {
  const d = open();
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.query) {
    // match the full path (superset of name) so this mirrors ref_find's substring semantics
    where.push("a.path LIKE ? ESCAPE '\\'");
    params.push("%" + esc(opts.query) + "%");
  }
  if (opts.kind) { where.push("a.kind = ?"); params.push(opts.kind); }
  if (opts.ext) { where.push("a.ext = ?"); params.push(opts.ext.toLowerCase().replace(/^\./, "")); }
  if (opts.id) { where.push("a.game_id = ?"); params.push(opts.id); }
  const limit = Math.min(opts.limit ?? 100, 1000);
  const sql =
    "SELECT a.game_id, g.title AS title, a.path, a.name, a.ext, a.kind " +
    "FROM assets a LEFT JOIN games g ON g.id = a.game_id " +
    (where.length ? "WHERE " + where.join(" AND ") + " " : "") +
    "ORDER BY a.name LIMIT ?";
  params.push(limit);
  return d.prepare(sql).all(...params) as unknown as AssetSearchHit[];
}

function esc(s: string): string {
  // escape LIKE wildcards in the user query
  return s.replace(/[\\%_]/g, (m) => "\\" + m);
}

export interface AssetDbStats {
  games: number;
  assets: number;
  byKind: Record<string, number>;
  byExt: { ext: string; count: number }[];
  dbPath: string;
}

export function assetDbStats(): AssetDbStats {
  const d = open();
  const games = (d.prepare("SELECT COUNT(*) AS n FROM games").get() as { n: number }).n;
  const assets = (d.prepare("SELECT COUNT(*) AS n FROM assets").get() as { n: number }).n;
  const byKind: Record<string, number> = {};
  for (const r of d.prepare("SELECT kind, COUNT(*) AS n FROM assets GROUP BY kind ORDER BY n DESC").all() as { kind: string; n: number }[]) {
    byKind[r.kind] = r.n;
  }
  const byExt = (d.prepare("SELECT ext, COUNT(*) AS count FROM assets GROUP BY ext ORDER BY count DESC LIMIT 25").all() as { ext: string; count: number }[]);
  return { games, assets, byKind, byExt, dbPath: assetDbPath() };
}

export function indexedGameIds(): Set<string> {
  const d = open();
  return new Set((d.prepare("SELECT id FROM games").all() as { id: string }[]).map((r) => r.id));
}
