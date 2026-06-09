// Harvest a FRESH batch of top games not already in the reference library, to broaden
// the code-analysis corpus. Picks top-by-subscriptions from the catalog, excluding
// already-ingested ids, size-capped. Downloads + ingests. Run in background.

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { requireDotaPaths } from "../dist/dota/paths.js";
import { steamcmdWorkshopDir, downloadWorkshopItem } from "../dist/dota/steamcmd.js";
import { ingestItem, loadIndex } from "../dist/dota/reflib.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COUNT = Number(process.env.COUNT || 12);
const MAX_MB = Number(process.env.MAX_MB || 400);
const CAPS = { maxFiles: 600, maxBytesPerFile: 220_000, maxTotalBytes: 7_000_000 };

const cat = JSON.parse(await readFile(join(__dirname, "top-games-catalog.json"), "utf8"));
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

const targets = cat.games
  .filter((g) => !have.has(g.id) && (!g.fileSizeMB || g.fileSizeMB <= MAX_MB) && g.subscriptions > 5000)
  .slice(0, COUNT);

console.error(`Fresh harvest: ${targets.length} new games (excluding ${have.size} already in library).`);
let ok = 0, fail = 0;
const t0 = Date.now();
for (const g of targets) {
  const tag = `[${ok + fail + 1}/${targets.length}] ${g.id} ${g.title} (${g.fileSizeMB || "?"}MB, ${g.subscriptions} subs)`;
  try {
    if (!(await hasVpk(g.id))) {
      console.error(`${tag} downloading…`);
      const dl = await downloadWorkshopItem(g.id);
      if (!dl.ok) { fail++; console.error(`${tag} download FAILED`); continue; }
    }
    const item = await ingestItem(g.id, g, CAPS);
    ok++;
    console.error(`${tag} ingested — score ${item.score}, ${item.fileCount} files, panorama=${item.metrics.hasPanorama}, topics: ${item.topics.join(",")}`);
  } catch (e) {
    fail++;
    console.error(`${tag} ERROR: ${e.message}`);
  }
}
const after = await loadIndex();
console.error(`\nFresh harvest done in ${Math.round((Date.now() - t0) / 1000)}s. ok=${ok} fail=${fail}. Library now ${after.items.length} games.`);
