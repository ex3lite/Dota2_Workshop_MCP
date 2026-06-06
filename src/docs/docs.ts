// Loader + search over the bundled ModDota guide articles and the tools catalog.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveDataPath } from "../util/datapath.js";

export interface DocMeta {
  id: string;
  title: string;
  category: string;
  summary: string;
  headings: string[];
  file: string;
  sourceUrl: string;
}

export interface DocsIndex {
  generatedAt?: string;
  count: number;
  pages: DocMeta[];
}

export interface ToolEntry {
  name: string;
  category: string;
  description: string;
  url: string;
  package?: string;
}

let indexCache: DocsIndex | undefined;
let pagesDir: string | undefined;
const contentCache = new Map<string, { raw: string; lower: string }>();
let toolsCache: { description?: string; tools: ToolEntry[] } | undefined;

export async function loadDocsIndex(): Promise<DocsIndex> {
  if (indexCache) return indexCache;
  const file = await resolveDataPath("docs/index.json");
  pagesDir = join(dirname(file), "pages");
  indexCache = JSON.parse(await readFile(file, "utf8")) as DocsIndex;
  return indexCache;
}

export async function getDoc(id: string): Promise<{ meta: DocMeta; content: string } | undefined> {
  const index = await loadDocsIndex();
  const meta = index.pages.find((p) => p.id.toLowerCase() === id.toLowerCase());
  if (!meta) return undefined;
  const content = await readPage(meta);
  return { meta, content };
}

async function readPageEntry(meta: DocMeta): Promise<{ raw: string; lower: string }> {
  const cached = contentCache.get(meta.id);
  if (cached) return cached;
  const raw = await readFile(join(pagesDir!, meta.file), "utf8");
  const entry = { raw, lower: raw.toLowerCase() };
  contentCache.set(meta.id, entry);
  return entry;
}

async function readPage(meta: DocMeta): Promise<string> {
  return (await readPageEntry(meta)).raw;
}

export async function listDocs(category?: string): Promise<DocMeta[]> {
  const index = await loadDocsIndex();
  return category ? index.pages.filter((p) => p.category.toLowerCase() === category.toLowerCase()) : index.pages;
}

export async function docCategories(): Promise<{ category: string; count: number }[]> {
  const index = await loadDocsIndex();
  const map = new Map<string, number>();
  for (const p of index.pages) map.set(p.category, (map.get(p.category) ?? 0) + 1);
  return [...map.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => a.category.localeCompare(b.category));
}

export interface DocHit {
  id: string;
  title: string;
  category: string;
  score: number;
  snippet?: string;
}

function snippetAround(entry: { raw: string; lower: string }, term: string): string | undefined {
  const idx = entry.lower.indexOf(term.toLowerCase());
  if (idx < 0) return undefined;
  const start = Math.max(0, idx - 60);
  return entry.raw.slice(start, idx + term.length + 100).replace(/\s+/g, " ").trim();
}

export async function searchDocs(query: string, opts: { category?: string; limit?: number } = {}): Promise<DocHit[]> {
  const index = await loadDocsIndex();
  const q = query.toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  const limit = opts.limit ?? 15;
  const pages = opts.category ? index.pages.filter((p) => p.category.toLowerCase() === opts.category!.toLowerCase()) : index.pages;

  const hits: DocHit[] = [];
  for (const p of pages) {
    let s = 0;
    const title = p.title.toLowerCase();
    if (title === q) s += 100;
    else if (title.includes(q)) s += 70;
    if (p.id.toLowerCase().includes(q)) s += 30;
    if (p.headings.some((h) => h.toLowerCase().includes(q))) s += 40;
    if (p.summary.toLowerCase().includes(q)) s += 25;

    let snippet: string | undefined;
    const entry = await readPageEntry(p); // cached (raw + lowercased)
    if (entry.lower.includes(q)) {
      s += 15;
      snippet = snippetAround(entry, query);
    } else if (tokens.length > 1 && tokens.every((t) => entry.lower.includes(t))) {
      // All words present but not as a contiguous phrase — still a relevant body match.
      s += 10;
      snippet = snippetAround(entry, tokens.find((t) => entry.lower.includes(t))!);
    }
    if (s > 0) hits.push({ id: p.id, title: p.title, category: p.category, score: s, snippet: snippet ?? p.summary.slice(0, 160) });
  }

  hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return hits.slice(0, limit);
}

export async function loadTools(): Promise<{ description?: string; tools: ToolEntry[] }> {
  if (toolsCache) return toolsCache;
  const file = await resolveDataPath("tools-catalog.json");
  const parsed = JSON.parse(await readFile(file, "utf8")) as { description?: string; tools: ToolEntry[] };
  toolsCache = parsed;
  return parsed;
}

export async function searchTools(query?: string, category?: string): Promise<ToolEntry[]> {
  const { tools } = await loadTools();
  let list = tools;
  if (category) list = list.filter((t) => t.category.toLowerCase() === category.toLowerCase());
  if (query) {
    const q = query.toLowerCase();
    list = list.filter((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || (t.package ?? "").toLowerCase().includes(q));
  }
  return list;
}
