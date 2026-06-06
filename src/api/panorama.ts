// Loader + search for the bundled Panorama JS API (from @moddota/panorama-types).

import { readFile } from "node:fs/promises";
import { resolveDataPath } from "../util/datapath.js";

export interface PanoramaMember {
  name: string;
  kind: "method" | "property";
  signature: string;
  description?: string;
  examples?: string[];
  inheritedFrom?: string;
}

export interface PanoramaInterface {
  name: string;
  description?: string;
  extends?: string[];
  members: PanoramaMember[];
}

export interface PanoramaGlobal {
  name: string;
  type?: string;
  description?: string;
  declared?: boolean;
}

export interface PanoramaData {
  interfaces: PanoramaInterface[];
  globals: PanoramaGlobal[];
  generatedAt?: string;
}

let cache: PanoramaData | undefined;

export async function loadPanorama(): Promise<PanoramaData> {
  if (cache) return cache;
  const file = await resolveDataPath("panorama-api.json");
  cache = JSON.parse(await readFile(file, "utf8")) as PanoramaData;
  return cache;
}

function score(needle: string, name: string, extra?: string): number {
  const n = needle.toLowerCase();
  const nm = name.toLowerCase();
  if (nm === n) return 100;
  if (nm.startsWith(n)) return 80;
  if (nm.includes(n)) return 60;
  if (extra && extra.toLowerCase().includes(n)) return 25;
  return 0;
}

function firstLine(s?: string): string | undefined {
  return s?.split("\n")[0]?.trim();
}

function baseTypeName(type?: string): string | undefined {
  if (!type) return undefined;
  // Strip generics / unions / whitespace: "CDOTA_PanoramaScript_GameEvents" etc.
  const m = type.match(/[A-Za-z_][A-Za-z0-9_]*/);
  return m ? m[0] : undefined;
}

export interface PanoramaHit {
  kind: "global" | "interface" | "member";
  name: string;
  owner?: string;
  signature?: string;
  description?: string;
  score: number;
}

export async function searchPanorama(query: string, limit = 25): Promise<PanoramaHit[]> {
  const data = await loadPanorama();
  const hits: PanoramaHit[] = [];

  for (const g of data.globals) {
    const s = score(query, g.name, g.description);
    if (s > 0) hits.push({ kind: "global", name: g.name, signature: g.type, description: firstLine(g.description), score: s + 5 });
  }
  // Dedupe member hits by owner+name so overloads (and re-found inherited members)
  // occupy one slot, keeping the highest score.
  const memberHits = new Map<string, PanoramaHit>();
  for (const i of data.interfaces) {
    const s = score(query, i.name, i.description);
    if (s > 0) hits.push({ kind: "interface", name: i.name, description: firstLine(i.description), score: s });
    for (const m of i.members) {
      const ms = score(query, m.name, m.signature + " " + (m.description ?? ""));
      if (ms <= 0) continue;
      const key = `${i.name}::${m.name}`;
      const existing = memberHits.get(key);
      if (existing) {
        if (ms > existing.score) existing.score = ms;
      } else {
        memberHits.set(key, { kind: "member", name: m.name, owner: i.name, signature: m.signature, description: firstLine(m.description), score: ms });
      }
    }
  }
  hits.push(...memberHits.values());

  hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return hits.slice(0, limit);
}

export async function getPanoramaInterface(name: string): Promise<PanoramaInterface | undefined> {
  const data = await loadPanorama();
  const lower = name.toLowerCase();
  return data.interfaces.find((i) => i.name.toLowerCase() === lower);
}

/** Resolve any name: a global (-> its interface), an interface, or Owner.member / Owner:member. */
export async function getPanorama(name: string): Promise<
  | { kind: "global"; global: PanoramaGlobal; iface?: PanoramaInterface }
  | { kind: "interface"; iface: PanoramaInterface }
  | { kind: "member"; owner: string; member: PanoramaMember }
  | undefined
> {
  const data = await loadPanorama();

  // Split on the LAST separator so 'Owner.member' resolves correctly even if a prefix has dots.
  const memberMatch = name.match(/^(.+)[.:]([^.:]+)$/);
  if (memberMatch) {
    const ownerName = memberMatch[1];
    const memberName = memberMatch[2];
    const global = data.globals.find((g) => g.name.toLowerCase() === ownerName.toLowerCase());
    const ifaceName = global ? baseTypeName(global.type) : ownerName;
    const iface = data.interfaces.find((i) => i.name.toLowerCase() === (ifaceName ?? "").toLowerCase());
    const member = iface?.members.find((m) => m.name.toLowerCase() === memberName.toLowerCase());
    if (iface && member) return { kind: "member", owner: iface.name, member };
    return undefined;
  }

  const global = data.globals.find((g) => g.name.toLowerCase() === name.toLowerCase());
  if (global) {
    const ifaceName = baseTypeName(global.type);
    const iface = data.interfaces.find((i) => i.name.toLowerCase() === (ifaceName ?? "").toLowerCase());
    return { kind: "global", global, iface };
  }

  const iface = await getPanoramaInterface(name);
  if (iface) return { kind: "interface", iface };

  return undefined;
}

export async function panoramaStats(): Promise<{ interfaces: number; members: number; globals: number; generatedAt?: string }> {
  const data = await loadPanorama();
  return {
    interfaces: data.interfaces.length,
    members: data.interfaces.reduce((n, i) => n + i.members.length, 0),
    globals: data.globals.length,
    generatedAt: data.generatedAt,
  };
}
