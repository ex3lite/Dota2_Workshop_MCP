// Re-unpack every locally-available game (subscribed + steamcmd) into the reference
// library so each gets the new passport (full inventory + assets + all-files.txt).
// No downloads — re-reads existing VPKs.

import { requireDotaPaths } from "../dist/dota/paths.js";
import { steamcmdWorkshopDir } from "../dist/dota/steamcmd.js";
import { ingestItem, loadIndex } from "../dist/dota/reflib.js";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const CAPS = { maxFiles: 600, maxBytesPerFile: 220_000, maxTotalBytes: 7_000_000 };
const dota = await requireDotaPaths();
const bases = [dota.workshopContentDir, steamcmdWorkshopDir()];

const ids = [];
for (const base of bases) {
  for (const id of (await readdir(base).catch(() => [])).filter((d) => /^\d+$/.test(d))) {
    const files = await readdir(join(base, id)).catch(() => []);
    if (files.some((f) => /\.vpk$/i.test(f)) && !ids.includes(id)) ids.push(id);
  }
}
console.error(`Re-unpacking ${ids.length} local games (building passports)…`);

let ok = 0, fail = 0;
const t0 = Date.now();
for (const id of ids) {
  try {
    const item = await ingestItem(id, undefined, CAPS);
    ok++;
    const inv = item.inventory;
    console.error(`  [${ok + fail}/${ids.length}] ${id} ${item.title} — ${inv ? inv.files + " files, " + Math.round(inv.bytes / 1048576) + "MB" : "?"}, lua ${item.assets?.vscripts}, models ${item.assets?.models}, particles ${item.assets?.particles}`);
  } catch (e) {
    fail++;
    console.error(`  [${ok + fail}/${ids.length}] ${id} FAILED: ${e.message}`);
  }
}
const idx = await loadIndex();
console.error(`\nDone in ${Math.round((Date.now() - t0) / 1000)}s. ok=${ok} fail=${fail}. Library now ${idx.items.length} games (all with passports).`);
