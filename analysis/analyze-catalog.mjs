// Analyze analysis/top-games-catalog.json: genre/tag distribution, feature signals
// from descriptions, temporal activity, and per-genre leaders. Writes a markdown
// findings report to analysis/findings-metadata.md.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cat = JSON.parse(await readFile(join(__dirname, "top-games-catalog.json"), "utf8"));
const games = cat.games;

const GENRES = [
  ["Tower Defense", /tower\s*defen|(\b| )td(\b| )|maze|gem\s*td/i],
  ["Auto Chess / Battler", /auto\s*chess|autochess|battler|underlord|chess|combine|tier/i],
  ["Arena / Hero Brawl", /arena|brawl|overthrow|angel arena|deathmatch|all\s*random/i],
  ["ARPG / Dungeon", /rpg|dungeon|loot|crawler|diablo|hack\s*and\s*slash/i],
  ["Survival / Horde", /survival|horde|zombie|wave|endless|defense of/i],
  ["Custom Hero", /custom hero|hero chaos|imba|ability draft|random abilit/i],
  ["MOBA / AoS", /\b10v10\b|\b5v5\b|moba|lane|ranked|matchmaking|all pick/i],
  ["Pudge / Hook", /pudge|hook/i],
  ["Minigame / Party", /minigame|party|hide.and.seek|parkour|race|trivia|puzzle/i],
  ["Battle Royale / IO", /battle\s*royale|\bbr\b|\bio\b|agar|snake/i],
  ["Boss Fight / Raid", /boss|raid/i],
  ["Tycoon / Sim", /tycoon|simulat|idle|clicker|tower of/i],
];

const FEATURES = [
  ["Save/progression codes", /save\s*code|save\/load|progress|persistent|account|profile/i],
  ["Leaderboards/Ranked/MMR", /leaderboard|ranked|mmr|elo|ladder|rating|season/i],
  ["Custom shop/economy", /shop|gold|economy|currency|buy|vendor|market/i],
  ["Talents/Perks/Upgrades", /talent|perk|upgrade|skill\s*tree|ascend|prestige/i],
  ["Custom heroes/abilities", /custom (hero|abilit)|new abilit|reworked|hundreds of abilit/i],
  ["Waves/Rounds", /wave|round|stage|level\s*\d|endless/i],
  ["Bosses", /boss/i],
  ["Co-op / Teams", /co.?op|team|cooperat|guild|party/i],
  ["PvP", /pvp|versus|1v1|2v2|duel/i],
  ["Loot / Items / Inventory", /loot|inventory|item drop|rarity|legendary|crafting/i],
  ["Custom UI / HUD", /custom (ui|hud|interface)|panorama|scoreboard/i],
  ["Bots / AI", /\bbot\b|\bai\b|artificial intelligence/i],
];

function pct(n) {
  return ((n / games.length) * 100).toFixed(1) + "%";
}

function countBy(re) {
  return games.filter((g) => re.test(g.title + " " + g.description + " " + g.tags.join(" "))).length;
}

function leaders(re, k = 5) {
  return games.filter((g) => re.test(g.title + " " + g.description + " " + g.tags.join(" "))).slice(0, k);
}

// Tag frequency (Steam Workshop tags).
const tagFreq = {};
for (const g of games) for (const t of g.tags) tagFreq[t] = (tagFreq[t] || 0) + 1;
const topTags = Object.entries(tagFreq).sort((a, b) => b[1] - a[1]).slice(0, 20);

// Temporal: updated-year distribution (maintenance signal).
const updatedYear = {};
for (const g of games) if (g.updated) { const y = g.updated.slice(0, 4); updatedYear[y] = (updatedYear[y] || 0) + 1; }

const totalSubs = games.reduce((s, g) => s + g.subscriptions, 0);
const median = games[Math.floor(games.length / 2)].subscriptions;

let md = `# Top Custom Games — Metadata Analysis\n\n`;
md += `Analyzed **${games.length}** Dota 2 custom games from the Steam Workshop (app 570), ranked by lifetime subscriptions. Generated ${cat.generatedAt.slice(0, 10)}.\n\n`;
md += `- Combined lifetime subscriptions: **${totalSubs.toLocaleString()}**\n- Median subscriptions: **${median.toLocaleString()}**\n- Top game: **${games[0].title}** (${games[0].subscriptions.toLocaleString()})\n\n`;

md += `## Genre distribution\n\n| Genre | Games | Share | Leaders (by subs) |\n| --- | ---: | ---: | --- |\n`;
for (const [name, re] of GENRES) {
  const n = countBy(re);
  const top = leaders(re, 4).map((g) => g.title).join(", ");
  md += `| ${name} | ${n} | ${pct(n)} | ${top} |\n`;
}

md += `\n## Feature prevalence (signals from titles/descriptions/tags)\n\n| Feature | Games | Share |\n| --- | ---: | ---: |\n`;
for (const [name, re] of FEATURES) {
  const n = countBy(re);
  md += `| ${name} | ${n} | ${pct(n)} |\n`;
}

md += `\n## Most common Workshop tags\n\n`;
md += topTags.map(([t, n]) => `- ${t}: ${n}`).join("\n") + "\n";

md += `\n## Maintenance (by last-updated year)\n\n`;
md += Object.entries(updatedYear).sort((a, b) => b[0].localeCompare(a[0])).map(([y, n]) => `- ${y}: ${n}`).join("\n") + "\n";

md += `\n## Top 40 games\n\n| # | Subs | Title | id | Updated | Tags |\n| ---: | ---: | --- | --- | --- | --- |\n`;
games.slice(0, 40).forEach((g, i) => {
  md += `| ${i + 1} | ${g.subscriptions.toLocaleString()} | ${g.title.replace(/\|/g, "/")} | ${g.id} | ${g.updated ?? "?"} | ${g.tags.slice(0, 4).join(", ")} |\n`;
});

md += `\n## Conclusions\n\n`;
md += `- The Workshop's popularity is dominated by a handful of evergreen formats: auto-battlers, hero arenas/brawls, custom-hero/IMBA modes, tower defense, and Pudge/skillshot party modes.\n`;
md += `- Progression hooks (save codes, ranked/MMR, talents/perks, shops) recur across the most-subscribed games — long-tail retention features, not just core gameplay.\n`;
md += `- Custom Panorama UI (scoreboards, shops, talent trees, hero pickers) is a baseline expectation in top games — a strong argument for the MCP's Panorama tooling + docs.\n`;

const out = join(__dirname, "findings-metadata.md");
await writeFile(out, md, "utf8");
console.log(`Wrote ${out} (${md.length} chars)`);
console.log("\nGenre counts:");
for (const [name, re] of GENRES) console.log(`  ${name}: ${countBy(re)}`);
