// Bulk-harvest locally-available custom games (subscribed + steamcmd) into the
// reference library — no downloads. Extracts code, scores quality, classifies topics.
// Usage: node analysis/harvest-local.mjs [limit]

import { requireDotaPaths } from "../dist/dota/paths.js";
import { steamcmdWorkshopDir } from "../dist/dota/steamcmd.js";
import { workshopDetails } from "../dist/dota/workshop.js";
import { ingestItem, loadIndex } from "../dist/dota/reflib.js";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const LIMIT = process.argv[2] ? Number(process.argv[2]) : Infinity;
const CAPS = { maxFiles: 300, maxBytesPerFile: 150_000, maxTotalBytes: 3_000_000 };

const dota = await requireDotaPaths();
const bases = [dota.workshopContentDir, steamcmdWorkshopDir()];
const ids = [];
for (const base of bases) {
  for (const d of await readdir(base).catch(() => [])) {
    if (/^\d+$/.test(d) && !ids.includes(d)) ids.push(d);
  }
}
const targets = ids.slice(0, LIMIT);
console.error(`Harvesting ${targets.length} local games into the reflib…`);

// Preload details (title/subs) in batches to avoid per-item network calls.
const detail = new Map();
for (let i = 0; i < targets.length; i += 50) {
  const batch = targets.slice(i, i + 50);
  for (const d of await workshopDetails(batch).catch(() => [])) detail.set(d.id, d);
}

let ok = 0, fail = 0;
const t0 = Date.now();
for (const id of targets) {
  try {
    const item = await ingestItem(id, detail.get(id), CAPS);
    ok++;
    console.error(`  [${ok + fail}/${targets.length}] ${id} ${item.title} — score ${item.score}, ${item.fileCount} files, topics: ${item.topics.join(",") || "—"}`);
  } catch (e) {
    fail++;
    console.error(`  [${ok + fail}/${targets.length}] ${id} FAILED: ${e.message}`);
  }
}

const index = await loadIndex();
const byTopic = {};
for (const it of index.items) for (const t of it.topics) byTopic[t] = (byTopic[t] || 0) + 1;
const avg = index.items.reduce((s, i) => s + i.score, 0) / (index.items.length || 1);
console.error(`\nDone in ${Math.round((Date.now() - t0) / 1000)}s. ok=${ok} fail=${fail}. Library now ${index.items.length} games, avg score ${avg.toFixed(1)}.`);
console.error("Topics:", Object.entries(byTopic).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}:${n}`).join("  "));
