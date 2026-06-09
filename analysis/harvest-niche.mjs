// Harvest UNDER-REPRESENTED niche genres to reach fresh mechanic-space (vs the
// TD/arena/arpg/survival-heavy corpus). Live workshop search per niche query, top-N
// each, excluding games already in the library; download + ingest.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { requireDotaPaths } from "../dist/dota/paths.js";
import { steamcmdWorkshopDir, downloadWorkshopItem } from "../dist/dota/steamcmd.js";
import { searchWorkshop } from "../dist/dota/workshop.js";
import { ingestItem, loadIndex } from "../dist/dota/reflib.js";

const PER = Number(process.env.PER || 2);
const MAX_MB = Number(process.env.MAX_MB || 350);
const MIN_SUBS = Number(process.env.MIN_SUBS || 30000);
const CAPS = { maxFiles: 500, maxBytesPerFile: 200_000, maxTotalBytes: 6_000_000 };

const NICHES = [
  "card game", "deck building", "tycoon", "idle clicker", "puzzle",
  "simulator", "chess", "tournament draft", "board game", "gladiator",
  "fishing", "tower wars", "footmen", "musical rhythm",
];

const index = await loadIndex();
const have = new Set(index.items.map((i) => i.id));
const dota = await requireDotaPaths();
const bases = [dota.workshopContentDir, steamcmdWorkshopDir()];
async function hasVpk(id) {
  for (const base of bases) {
    const files = await readdir(join(base, id)).catch(() => null);
    if (files && files.some((f) => /\.vpk$/i.test(f))) return true;
  }
  return false;
}

let ok = 0, fail = 0;
const seen = new Set();
const t0 = Date.now();
for (const q of NICHES) {
  let hits = [];
  try { hits = await searchWorkshop(q, 8); } catch { continue; }
  let n = 0;
  for (const h of hits) {
    if (n >= PER) break;
    if (have.has(h.id) || seen.has(h.id)) continue;
    if ((h.subscriptions ?? 0) < MIN_SUBS) continue;
    if (h.fileSizeMB && h.fileSizeMB > MAX_MB) continue;
    seen.add(h.id);
    n++;
    const tag = `[${q}] ${h.id} ${h.title} (${h.fileSizeMB || "?"}MB, ${h.subscriptions} subs)`;
    try {
      if (!(await hasVpk(h.id))) {
        const dl = await downloadWorkshopItem(h.id);
        if (!dl.ok) { fail++; console.error(`${tag} download FAILED`); continue; }
      }
      const item = await ingestItem(h.id, h, CAPS);
      ok++;
      console.error(`${tag} -> score ${item.score}, ${item.fileCount} files, topics: ${item.topics.join(",")}`);
    } catch (e) {
      fail++;
      console.error(`${tag} ERROR: ${e.message}`);
    }
  }
}
const after = await loadIndex();
console.error(`\nNiche harvest done in ${Math.round((Date.now() - t0) / 1000)}s. ok=${ok} fail=${fail}. Library now ${after.items.length} games.`);
