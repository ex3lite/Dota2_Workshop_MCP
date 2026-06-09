// Build a catalog of top Dota 2 custom games (app 570) from the public Steam Workshop:
// aggregate ids from trending pages + many genre searches, fetch full details
// (subscriptions, tags, description, dates) via the keyless GetPublishedFileDetails,
// dedupe, rank by lifetime subscriptions, and write analysis/top-games-catalog.json.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = "570";
const UA = { "User-Agent": "Mozilla/5.0 (dota2-workshop-mcp analysis)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GENRES = [
  "tower defense", "arena", "auto chess", "survival", "rpg", "dungeon", "moba",
  "horde", "pvp", "minigame", "parkour", "hide and seek", "battle royale",
  "roguelike", "boss fight", "open world", "io", "deathmatch", "card", "simulator",
  "tycoon", "zombie", "race", "puzzle", "co-op",
];

async function browseIds({ searchtext, sort = "trend", pages = 1 }) {
  const ids = [];
  for (let p = 1; p <= pages; p++) {
    const url =
      `https://steamcommunity.com/workshop/browse/?appid=${APP}` +
      (searchtext ? `&searchtext=${encodeURIComponent(searchtext)}&browsesort=textsearch&actualsort=textsearch` : `&browsesort=${sort}&actualsort=${sort}&days=-1`) +
      `&section=readytouseitems&p=${p}`;
    try {
      const html = await (await fetch(url, { headers: UA })).text();
      const found = [...new Set([...html.matchAll(/filedetails\/\?id=(\d+)/g)].map((m) => m[1]))];
      ids.push(...found);
      if (!found.length) break;
    } catch (e) {
      console.error(`  ! browse ${searchtext || sort} p${p}: ${e.message}`);
    }
    await sleep(250);
  }
  return ids;
}

async function detailsBatch(ids) {
  const form = new URLSearchParams();
  form.set("itemcount", String(ids.length));
  ids.forEach((id, i) => form.set(`publishedfileids[${i}]`, id));
  const res = await fetch("https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  return data?.response?.publishedfiledetails ?? [];
}

async function main() {
  console.error("Gathering ids…");
  const idSet = new Set();
  // Trending overall (several pages).
  for (const id of await browseIds({ sort: "trend", pages: 7 })) idSet.add(id);
  for (const id of await browseIds({ sort: "mostrecent", pages: 0 })) idSet.add(id);
  // Per-genre text searches.
  for (const g of GENRES) {
    const ids = await browseIds({ searchtext: g, pages: 2 });
    ids.forEach((id) => idSet.add(id));
    console.error(`  ${g}: +${ids.length} (total ${idSet.size})`);
  }
  const ids = [...idSet];
  console.error(`Total unique ids: ${ids.length}. Fetching details…`);

  const details = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    details.push(...(await detailsBatch(batch)));
    await sleep(200);
  }

  const games = details
    .filter((d) => d && d.result === 1 && d.title && d.consumer_app_id == APP)
    .map((d) => ({
      id: String(d.publishedfileid),
      title: d.title,
      subscriptions: d.lifetime_subscriptions ?? d.subscriptions ?? 0,
      favorited: d.favorited ?? 0,
      views: d.views ?? 0,
      fileSizeMB: Number(d.file_size) > 0 ? Math.round(Number(d.file_size) / 1048576) : undefined,
      tags: (d.tags ?? []).map((t) => t.tag).filter(Boolean),
      created: d.time_created ? new Date(d.time_created * 1000).toISOString().slice(0, 10) : undefined,
      updated: d.time_updated ? new Date(d.time_updated * 1000).toISOString().slice(0, 10) : undefined,
      description: (d.description ?? "").replace(/\[\/?[^\]]+\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 600),
    }))
    .sort((a, b) => b.subscriptions - a.subscriptions);

  const catalog = {
    generatedAt: new Date().toISOString(),
    source: "steamcommunity.com/workshop/browse (app 570) + GetPublishedFileDetails",
    count: games.length,
    games,
  };
  const out = join(__dirname, "top-games-catalog.json");
  await writeFile(out, JSON.stringify(catalog, null, 2), "utf8");
  console.error(`\nWrote ${games.length} games -> ${out}`);
  console.error("Top 15 by subscriptions:");
  for (const g of games.slice(0, 15)) console.error(`  ${g.subscriptions.toLocaleString().padStart(10)}  ${g.id}  ${g.title}`);
}

main().catch((e) => {
  console.error("catalog build failed:", e);
  process.exit(1);
});
