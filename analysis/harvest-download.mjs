// Deep-corpus builder: pick a diverse set of TOP games (top-N per genre from the
// catalog), download any that aren't local via SteamCMD, and ingest them into the
// reference library (code extraction + quality score + topic classification).
// Designed to run in the background; logs incremental progress.

import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { requireDotaPaths } from "../dist/dota/paths.js";
import { steamcmdWorkshopDir, downloadWorkshopItem } from "../dist/dota/steamcmd.js";
import { ingestItem, loadIndex } from "../dist/dota/reflib.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PER_GENRE = Number(process.env.PER_GENRE || 3);
const MAX_GAMES = Number(process.env.MAX_GAMES || 24);
const MAX_MB = Number(process.env.MAX_MB || 450); // skip very large items
const CAPS = { maxFiles: 600, maxBytesPerFile: 220_000, maxTotalBytes: 7_000_000 };

const GENRES = [
  ["tower-defense", /tower\s*defen|(\b| )td(\b| )|maze|gem\s*td/i],
  ["auto-chess", /auto\s*chess|autochess|battler|underlord/i],
  ["arena", /arena|brawl|overthrow|angel arena|deathmatch/i],
  ["arpg", /\brpg\b|dungeon|loot|crawler|diablo/i],
  ["survival", /survival|horde|zombie|endless/i],
  ["custom-hero", /custom hero|hero chaos|imba|ability draft/i],
  ["moba", /\b10v10\b|\b5v5\b|moba|ranked|matchmaking/i],
  ["hook", /pudge|hook/i],
  ["minigame", /minigame|party|hide.and.seek|parkour|race|puzzle/i],
  ["boss", /boss|raid/i],
];

const cat = JSON.parse(await readFile(join(__dirname, "top-games-catalog.json"), "utf8"));
const dota = await requireDotaPaths();
const bases = [dota.workshopContentDir, steamcmdWorkshopDir()];

async function hasVpk(id) {
  for (const base of bases) {
    const dir = join(base, id);
    const files = await readdir(dir).catch(() => null);
    if (files && files.some((f) => /\.vpk$/i.test(f))) return true;
  }
  return false;
}

// Build a diverse, deduped target set: top-N per genre, capped, size-filtered.
const picked = new Map();
for (const [genre, re] of GENRES) {
  const matches = cat.games.filter((g) => re.test(g.title + " " + g.description + " " + g.tags.join(" ")));
  let n = 0;
  for (const g of matches) {
    if (n >= PER_GENRE || picked.size >= MAX_GAMES) break;
    if (picked.has(g.id)) continue;
    if (g.fileSizeMB && g.fileSizeMB > MAX_MB) continue;
    picked.set(g.id, { ...g, genre });
    n++;
  }
}
const targets = [...picked.values()];
console.error(`Deep corpus: ${targets.length} games (<=${MAX_MB}MB, ${PER_GENRE}/genre).`);

let ok = 0, fail = 0;
const t0 = Date.now();
for (const g of targets) {
  const tag = `[${ok + fail + 1}/${targets.length}] ${g.id} ${g.title} (${g.genre}, ${g.fileSizeMB || "?"}MB)`;
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

const index = await loadIndex();
console.error(`\nDeep harvest done in ${Math.round((Date.now() - t0) / 1000)}s. ok=${ok} fail=${fail}. Library now ${index.items.length} games.`);
