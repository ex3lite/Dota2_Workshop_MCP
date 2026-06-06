// Search + lookup over the bundled Dota 2 VScript API.

import { ApiClass, ApiEnum, ApiFunction, loadApi } from "./loader.js";

export type ApiKind = "class" | "function" | "method" | "enum" | "all";

export interface SearchHit {
  kind: "class" | "function" | "method" | "enum" | "constant";
  name: string;
  /** For methods: the owning class. */
  owner?: string;
  signature?: string;
  description?: string;
  available?: string;
  score: number;
}

function score(needle: string, haystackName: string, description?: string, signature?: string): number {
  const n = needle.toLowerCase();
  const name = haystackName.toLowerCase();
  if (name === n) return 100;
  if (name.startsWith(n)) return 80;
  if (name.includes(n)) return 60;
  if (signature && signature.toLowerCase().includes(n)) return 40;
  if (description && description.toLowerCase().includes(n)) return 20;
  return 0;
}

function firstLine(s?: string): string | undefined {
  return s?.split("\n")[0]?.trim();
}

export async function searchApi(
  query: string,
  opts: { kind?: ApiKind; limit?: number; available?: string } = {},
): Promise<SearchHit[]> {
  const api = await loadApi();
  const kind = opts.kind ?? "all";
  const limit = opts.limit ?? 25;
  const hits: SearchHit[] = [];

  if (kind === "all" || kind === "class") {
    for (const c of api.classes) {
      const s = score(query, c.name, c.description);
      if (s > 0) hits.push({ kind: "class", name: c.name, description: firstLine(c.description), score: s });
    }
  }

  if (kind === "all" || kind === "function") {
    for (const f of api.functions) {
      if (opts.available && f.available && f.available !== "both" && f.available !== opts.available) continue;
      const s = score(query, f.name, f.description, f.signature);
      if (s > 0)
        hits.push({
          kind: "function",
          name: f.name,
          signature: f.signature,
          description: firstLine(f.description),
          available: f.available,
          score: s,
        });
    }
  }

  if (kind === "all" || kind === "method") {
    for (const c of api.classes) {
      for (const m of c.methods) {
        if (opts.available && m.available && m.available !== "both" && m.available !== opts.available) continue;
        const s = score(query, m.name, m.description, m.signature);
        if (s > 0)
          hits.push({
            kind: "method",
            name: m.name,
            owner: c.name,
            signature: m.signature,
            description: firstLine(m.description),
            available: m.available,
            score: s,
          });
      }
    }
  }

  if (kind === "all" || kind === "enum") {
    for (const e of api.enums) {
      let s = score(query, e.name, undefined);
      // Also match on member names (e.g. searching "DOTA_UNIT_TARGET_HERO").
      let matchedMember: string | undefined;
      if (e.members) {
        for (const m of e.members) {
          const ms = score(query, m.name);
          if (ms > s) {
            s = Math.max(s, ms - 5);
            matchedMember = m.name;
          }
        }
      }
      if (s > 0)
        hits.push({
          kind: e.kind === "constant" ? "constant" : "enum",
          name: e.name,
          description: matchedMember ? `member: ${matchedMember}` : undefined,
          score: s,
        });
    }
  }

  hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return hits.slice(0, limit);
}

export async function getClass(name: string, includeInherited = false): Promise<(ApiClass & { inheritedFrom?: Record<string, string> }) | undefined> {
  const api = await loadApi();
  const lower = name.toLowerCase();
  const cls = api.classes.find((c) => c.name.toLowerCase() === lower);
  if (!cls) return undefined;
  if (!includeInherited) return cls;

  // Flatten the extends chain, recording where each inherited method came from.
  const seen = new Map<string, string>();
  const methods: ApiFunction[] = [];
  const inheritedFrom: Record<string, string> = {};
  let current: ApiClass | undefined = cls;
  const chain: string[] = [];
  while (current) {
    for (const m of current.methods) {
      if (!seen.has(m.name)) {
        seen.set(m.name, current.name);
        methods.push(m);
        if (current.name !== cls.name) inheritedFrom[m.name] = current.name;
      }
    }
    chain.push(current.name);
    const parentName: string | undefined = current.extends;
    current = parentName ? api.classes.find((c) => c.name === parentName) : undefined;
    if (current && chain.includes(current.name)) break; // cycle guard
  }
  return { ...cls, methods, inheritedFrom };
}

export async function getFunction(name: string): Promise<ApiFunction | undefined> {
  const api = await loadApi();
  const lower = name.toLowerCase();
  return api.functions.find((f) => f.name.toLowerCase() === lower);
}

export async function getMethod(className: string, methodName: string): Promise<{ owner: string; method: ApiFunction } | undefined> {
  const cls = await getClass(className, true);
  if (!cls) return undefined;
  const m = cls.methods.find((x) => x.name.toLowerCase() === methodName.toLowerCase());
  if (!m) return undefined;
  return { owner: (cls as any).inheritedFrom?.[m.name] ?? cls.name, method: m };
}

export async function getEnum(name: string): Promise<ApiEnum | undefined> {
  const api = await loadApi();
  const lower = name.toLowerCase();
  return api.enums.find((e) => e.name.toLowerCase() === lower);
}

export async function apiStats(): Promise<{ classes: number; functions: number; enums: number; generatedAt?: string }> {
  const api = await loadApi();
  return { classes: api.classes.length, functions: api.functions.length, enums: api.enums.length, generatedAt: api.generatedAt };
}
