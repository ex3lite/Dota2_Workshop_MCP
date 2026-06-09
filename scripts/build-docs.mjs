#!/usr/bin/env node
// Downloads the ModDota guide articles (the content behind moddota.com) and bundles
// them as structured, searchable markdown under src/data/docs/. Source of truth:
// the Jekyll _articles collection in ModDota/moddota.github.io@source.
// Run: npm run build:docs

import { writeFile, mkdir, rm, readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, "..", "src", "data", "docs");
const PAGES_DIR = join(DOCS_DIR, "pages");
// Hand-authored pages that ship with the MCP (not fetched from ModDota). Merged in
// after the fetch so they survive a re-run of build:data. Filename "cat__slug.md" -> id "cat/slug".
const EXTRA_DIR = join(__dirname, "..", "src", "data", "docs-extra", "pages");

const REPO = "ModDota/moddota.github.io";
const BRANCH = "source";
const ROOT = "_articles/";
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;

// Private-use marker for protecting code spans during Liquid stripping (never in real text).
const MARK = String.fromCharCode(0xE000);

async function ghJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "dota2-workshop-mcp-build", Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function stripFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { body: md, front: {} };
  const front = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (kv) front[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { body: md.slice(m[0].length), front };
}

function cleanBody(body) {
  // Protect fenced + inline code so Liquid stripping never eats real JSX/JS such as
  // style={{ marginLeft: '5px' }} (syntactically identical to a Liquid {{ }} tag).
  const fences = [];
  let out = body.replace(/```[\s\S]*?```|`[^`\n]*`/g, (m) => {
    fences.push(m);
    return `${MARK}${fences.length - 1}${MARK}`;
  });
  out = out.replace(/\{%[\s\S]*?%\}/g, "").replace(/\{\{[\s\S]*?\}\}/g, ""); // Liquid in prose only
  out = out.replace(new RegExp(`${MARK}(\\d+)${MARK}`, "g"), (_, i) => fences[Number(i)]);
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function titleFrom(front, body, id) {
  if (front.title) return front.title;
  const h = body.match(/^#\s+(.+)$/m);
  if (h) return h[1].trim();
  return id.split("/").pop().replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function headingsOf(body) {
  return [...body.matchAll(/^#{1,4}\s+(.+)$/gm)].map((m) => m[1].trim()).slice(0, 30);
}

function summaryOf(body) {
  const prose = body.replace(/```[\s\S]*?```/g, "").replace(/^#{1,6}\s.*$/gm, "");
  const para = prose
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0 && !p.startsWith("```") && !p.startsWith("|") && !p.startsWith("!["));
  return para ? para.replace(/\s+/g, " ").slice(0, 320) : "";
}

async function main() {
  console.error(`Fetching ModDota articles from ${REPO}@${BRANCH} ...`);
  // Use a single ref (BRANCH) for both the tree listing and the raw content fetch.
  const tree = await ghJson(`https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`);
  const files = tree.tree.filter(
    (n) => n.type === "blob" && n.path.startsWith(ROOT) && /\.(md|markdown)$/i.test(n.path) && n.path !== `${ROOT}index.md`,
  );

  await rm(DOCS_DIR, { recursive: true, force: true });
  await mkdir(PAGES_DIR, { recursive: true });

  const index = [];
  const usedFiles = new Map();
  let ok = 0;
  for (const f of files) {
    try {
      const raw = await fetchText(RAW + f.path);
      const rel = f.path.slice(ROOT.length).replace(/\.(md|markdown)$/i, "");
      const segs = rel.split("/");
      const category = segs.length > 1 ? segs[0] : "general";
      const id = rel;
      const { body, front } = stripFrontmatter(raw);
      const cleaned = cleanBody(body);
      const fileName = id.replace(/\//g, "__") + ".md";
      if (usedFiles.has(fileName)) {
        throw new Error(`filename collision "${fileName}" from ids "${usedFiles.get(fileName)}" and "${id}"`);
      }
      usedFiles.set(fileName, id);
      const title = titleFrom(front, cleaned, id);

      await writeFile(join(PAGES_DIR, fileName), cleaned, "utf8");
      index.push({
        id,
        title,
        category,
        summary: summaryOf(cleaned),
        headings: headingsOf(cleaned),
        file: fileName,
        sourceUrl: `https://moddota.com/${id}`,
      });
      ok++;
    } catch (err) {
      console.error(`  ! ${f.path}: ${err.message}`);
    }
  }

  // Merge hand-authored extra pages (bundled with the MCP).
  const extra = await mergeExtraPages(index, usedFiles);
  ok += extra;

  index.sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
  await writeFile(join(DOCS_DIR, "index.json"), JSON.stringify({ generatedAt: new Date().toISOString(), count: index.length, pages: index }), "utf8");

  const byCat = {};
  for (const p of index) byCat[p.category] = (byCat[p.category] || 0) + 1;
  console.error(`Wrote ${ok} docs to ${DOCS_DIR}\n  categories: ${JSON.stringify(byCat)}`);
}

// Copy each src/data/docs-extra/pages/*.md into the bundle and index it.
async function mergeExtraPages(index, usedFiles) {
  let merged = 0;
  let files = [];
  try {
    files = (await readdir(EXTRA_DIR)).filter((f) => /\.md$/i.test(f));
  } catch {
    return 0; // no extras directory — fine
  }
  for (const fileName of files) {
    try {
      const raw = await readFile(join(EXTRA_DIR, fileName), "utf8");
      const { body, front } = stripFrontmatter(raw);
      const cleaned = body.trim();
      const id = fileName.replace(/\.md$/i, "").replace(/__/g, "/");
      const category = id.includes("/") ? id.split("/")[0] : "general";
      if (usedFiles.has(fileName)) {
        console.error(`  ! extra "${fileName}" collides with a fetched page — skipping`);
        continue;
      }
      usedFiles.set(fileName, id);
      await writeFile(join(PAGES_DIR, fileName), cleaned, "utf8");
      // Replace any existing entry with the same id, then add.
      const existing = index.findIndex((p) => p.id === id);
      if (existing >= 0) index.splice(existing, 1);
      index.push({
        id,
        title: titleFrom(front, cleaned, id),
        category,
        summary: summaryOf(cleaned),
        headings: headingsOf(cleaned),
        file: fileName,
        sourceUrl: front.sourceUrl || "bundled with dota2-workshop-mcp",
      });
      merged++;
    } catch (err) {
      console.error(`  ! extra ${fileName}: ${err.message}`);
    }
  }
  if (merged) console.error(`Merged ${merged} hand-authored extra doc(s).`);
  return merged;
}

main().catch((err) => {
  console.error("build-docs failed:", err);
  process.exit(1);
});
