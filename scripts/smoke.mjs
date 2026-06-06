#!/usr/bin/env node
// End-to-end smoke test: boots the built MCP server over stdio via the MCP client,
// lists tools, exercises read-only + dry-run tools, and runs the scaffolders against
// a throwaway temp addon (so the user's real project is never touched).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = join(root, ".tmp-verify-addon");

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? "  — " + detail : ""}`);
  }
}

async function setupTempAddon() {
  await rm(tmp, { recursive: true, force: true });
  await mkdir(join(tmp, "src", "vscripts", "lib"), { recursive: true });
  await mkdir(join(tmp, "src", "panorama"), { recursive: true });
  await mkdir(join(tmp, "game", "scripts", "npc"), { recursive: true });
  await writeFile(
    join(tmp, "package.json"),
    JSON.stringify({ name: "verify_addon", devDependencies: { "typescript-to-lua": "^1.26.0", "@moddota/dota-lua-types": "^4.34.1" } }, null, 2),
  );
}

function textOf(res) {
  return (res.content ?? []).map((c) => c.text ?? "").join("\n");
}

async function main() {
  await setupTempAddon();

  const transport = new StdioClientTransport({
    command: "node",
    args: [join(root, "dist", "index.js")],
    env: { ...process.env, DOTA2_ADDON_DIR: tmp },
  });
  const client = new Client({ name: "smoke", version: "1.0.0" });
  await client.connect(transport);

  // 1) tools/list
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log(`\nTools (${names.length}): ${names.join(", ")}\n`);
  check("server exposes >= 18 tools", names.length >= 18, `got ${names.length}`);
  for (const expected of [
    "dota_doctor", "addon_list", "kv_read", "kv_upsert_entry", "lua_api_search",
    "lua_api_get", "scaffold_ability", "scaffold_modifier", "addon_build", "addon_launch_tools",
    "dota_send_console_command", "dota_read_console_log", "dota_reload_scripts",
    "dota_restart_game", "dota_dev_cycle", "dota_screenshot", "dota_watch_errors",
    "docs_search", "docs_get", "docs_list", "dota_patterns", "panorama_api_search", "panorama_api_get", "tools_catalog",
    "map_create", "map_add_entity", "map_to_text", "map_from_text", "map_compile", "map_list",
    "kv3_read", "soundevents_list", "soundevents_get", "soundevents_upsert",
    "assets_list", "assets_search", "vpk_find", "vpk_read", "base_kv_entry",
    "scaffold_custom_event", "scaffold_net_table",
    "entity_catalog", "map_terrain", "map_build", "map_preview", "map_tile_to_world", "scaffold_td",
    "workshop_list", "workshop_inspect", "workshop_read", "workshop_search", "workshop_download",
  ]) {
    check(`tool present: ${expected}`, names.includes(expected));
  }

  // 2) Lua API search + get
  const search = await client.callTool({ name: "lua_api_search", arguments: { query: "CreateUnitByName" } });
  check("lua_api_search finds CreateUnitByName", textOf(search).includes("CreateUnitByName"));

  const getCls = await client.callTool({ name: "lua_api_get", arguments: { name: "CDOTA_BaseNPC" } });
  check("lua_api_get CDOTA_BaseNPC returns methods", /methods \(\d+\)/.test(textOf(getCls)));

  const getMethod = await client.callTool({ name: "lua_api_get", arguments: { name: "CDOTA_BaseNPC:AddAbility" } });
  check("lua_api_get method form works", textOf(getMethod).includes("AddAbility"));

  // 3) Scaffold an ability into the temp addon
  const ab = await client.callTool({
    name: "scaffold_ability",
    arguments: { name: "verify_fireball", behavior: "point", lang: "ts", displayName: "Verify Fireball" },
  });
  check("scaffold_ability succeeded", !ab.isError, textOf(ab));
  const tsFile = join(tmp, "src", "vscripts", "abilities", "verify_fireball.ts");
  check("ability TS file created", existsSync(tsFile));
  if (existsSync(tsFile)) {
    const c = await readFile(tsFile, "utf8");
    check("ability TS uses @registerAbility", c.includes("@registerAbility") && c.includes("class verify_fireball"));
  }
  const abilitiesKv = join(tmp, "game", "scripts", "npc", "npc_abilities_custom.txt");
  check("npc_abilities_custom.txt created", existsSync(abilitiesKv));
  if (existsSync(abilitiesKv)) {
    const c = await readFile(abilitiesKv, "utf8");
    check("KV has the ability + ScriptFile", c.includes("verify_fireball") && c.includes('"abilities/verify_fireball.lua"'));
  }
  const locFile = join(tmp, "game", "resource", "addon_english.txt");
  check("localization file created", existsSync(locFile));
  if (existsSync(locFile)) {
    // It should be UTF-16 LE with BOM.
    const buf = await readFile(locFile);
    check("localization is UTF-16 LE w/ BOM", buf[0] === 0xff && buf[1] === 0xfe);
    const c = buf.slice(2).toString("utf16le");
    check("localization has the tooltip token", c.includes("DOTA_Tooltip_ability_verify_fireball"));
  }

  // 3b) overwrite guard: re-scaffold same ability without overwrite must refuse (source guard);
  //     with overwrite=true it updates the KV entry.
  const abAgain = await client.callTool({ name: "scaffold_ability", arguments: { name: "verify_fireball", behavior: "point", lang: "ts" } });
  check("re-scaffold without overwrite refuses", abAgain.isError === true && /overwrite=true/.test(textOf(abAgain)));
  const abOver = await client.callTool({ name: "scaffold_ability", arguments: { name: "verify_fireball", behavior: "point", lang: "ts", overwrite: true } });
  check("re-scaffold with overwrite=true updates KV", !abOver.isError && /updated "verify_fireball"/.test(textOf(abOver)));

  // 3c) unit has no source file, so its KV overwrite guard is the reachable path
  await client.callTool({ name: "scaffold_unit", arguments: { name: "npc_dota_verify2" } });
  const unit2 = await client.callTool({ name: "scaffold_unit", arguments: { name: "npc_dota_verify2", model: "changed.vmdl" } });
  check("re-scaffold unit keeps existing KV (no clobber)", /skipped "npc_dota_verify2"|already existed/.test(textOf(unit2)));

  // 4) scaffold_modifier
  const mod = await client.callTool({ name: "scaffold_modifier", arguments: { name: "modifier_verify", lang: "ts" } });
  check("scaffold_modifier succeeded", !mod.isError, textOf(mod));
  check("modifier TS file created", existsSync(join(tmp, "src", "vscripts", "modifiers", "modifier_verify.ts")));

  // 5) kv_read + kv_get_entry round-trip
  const read = await client.callTool({ name: "kv_read", arguments: { file: "abilities" } });
  check("kv_read lists verify_fireball", textOf(read).includes("verify_fireball"));
  const entry = await client.callTool({ name: "kv_get_entry", arguments: { file: "abilities", key: "verify_fireball" } });
  check("kv_get_entry returns the block", textOf(entry).includes("AbilityBehavior"));

  // 6) kv_upsert_entry + validate
  await client.callTool({ name: "kv_upsert_entry", arguments: { file: "units", key: "npc_dota_verify", data: { BaseClass: "npc_dota_creature", StatusHealth: 500 } } });
  const unitEntry = await client.callTool({ name: "kv_get_entry", arguments: { file: "units", key: "npc_dota_verify" } });
  check("kv_upsert_entry wrote a unit", textOf(unitEntry).includes("npc_dota_creature"));
  const validate = await client.callTool({ name: "kv_validate", arguments: { file: "units" } });
  check("kv_validate reports valid", textOf(validate).includes("OK"));

  // 7) build/launch dry-runs (no side effects)
  const buildDry = await client.callTool({ name: "addon_build", arguments: { dryRun: true } });
  check("addon_build dryRun returns npm command", textOf(buildDry).includes("run build"));
  const launchDry = await client.callTool({ name: "addon_launch_tools", arguments: { dryRun: true } });
  check("addon_launch_tools dryRun builds -tools -addon", /-tools.*-addon.*verify_addon/.test(textOf(launchDry)));

  // 8) dota_doctor (read-only; will report whether the real install is found)
  const doctor = await client.callTool({ name: "dota_doctor", arguments: {} });
  check("dota_doctor runs", !doctor.isError, textOf(doctor).slice(0, 200));

  // 9) debug tools — use port 29999 (no game listening) so VConsole refuses deterministically
  const sendNoGame = await client.callTool({ name: "dota_send_console_command", arguments: { command: "echo hi", vconPort: 29999, waitMs: 500 } });
  check("send_console_command errors gracefully when no game", sendNoGame.isError === true && /VConsole|tools mode/i.test(textOf(sendNoGame)));
  const readNoGame = await client.callTool({ name: "dota_read_console_log", arguments: { vconPort: 29999 } });
  check("read_console_log errors gracefully when no game", readNoGame.isError === true);
  const restartDry = await client.callTool({ name: "dota_restart_game", arguments: { map: "dota", vconPort: 29999, dryRun: true } });
  const rt = textOf(restartDry);
  check("restart_game dryRun has taskkill + launch + vconport", /taskkill/i.test(rt) && rt.includes("dota2.exe") && rt.includes("-vconport"));
  const shotNoGame = await client.callTool({ name: "dota_screenshot", arguments: { method: "console", vconPort: 29999 } });
  check("screenshot errors gracefully when no game", shotNoGame.isError === true && /VConsole|tools mode/i.test(textOf(shotNoGame)));
  const watchNoGame = await client.callTool({ name: "dota_watch_errors", arguments: { vconPort: 29999 } });
  check("watch_errors errors gracefully when no game", watchNoGame.isError === true);

  // 10) docs + panorama + tools catalog
  const docsList = await client.callTool({ name: "docs_list", arguments: {} });
  check("docs_list shows categories", /abilities|panorama/.test(textOf(docsList)));
  const docsSearch = await client.callTool({ name: "docs_search", arguments: { query: "modifier" } });
  check("docs_search finds results", !docsSearch.isError && textOf(docsSearch).length > 20);
  const gs = await client.callTool({ name: "docs_get", arguments: { id: "getting-started" } });
  check("docs_get returns a page", !gs.isError && /Getting Started/i.test(textOf(gs)));

  const panSearch = await client.callTool({ name: "panorama_api_search", arguments: { query: "GameEvents" } });
  check("panorama_api_search finds GameEvents", textOf(panSearch).includes("GameEvents"));
  const panGet = await client.callTool({ name: "panorama_api_get", arguments: { name: "GameEvents" } });
  check("panorama_api_get GameEvents lists Subscribe", textOf(panGet).includes("Subscribe"));
  const panDollar = await client.callTool({ name: "panorama_api_get", arguments: { name: "$" } });
  check("panorama_api_get $ resolves to its interface members", /members of/i.test(textOf(panDollar)) && textOf(panDollar).includes("Msg"));
  check("panorama_api_get $ includes the (selector) call signature", /selector/.test(textOf(panDollar)));
  const panLabel = await client.callTool({ name: "panorama_api_get", arguments: { name: "LabelPanel" } });
  check("panorama LabelPanel includes inherited members", /\(from /.test(textOf(panLabel)) && /members \((\d{2,})\)/.test(textOf(panLabel)));

  const cat = await client.callTool({ name: "tools_catalog", arguments: { category: "official" } });
  check("tools_catalog official lists VConsole/Hammer", /VConsole|Hammer/.test(textOf(cat)));

  // 10b) design patterns knowledge base
  const patAll = await client.callTool({ name: "dota_patterns", arguments: {} });
  check("dota_patterns lists patterns", !patAll.isError && /tower-defense|maze|backend/i.test(textOf(patAll)));
  const patTd = await client.callTool({ name: "dota_patterns", arguments: { category: "tower-defense" } });
  check("dota_patterns filters by category", !patTd.isError && /Maze validation|pathing/i.test(textOf(patTd)));

  // 11) map tools — non-destructive checks (real map create/compile is covered by live tests)
  const mapCompileDry = await client.callTool({ name: "map_compile", arguments: { name: "somemap", dryRun: true } });
  check("map_compile dryRun shows resourcecompiler + game/dota", /resourcecompiler/i.test(textOf(mapCompileDry)) && /game[\\/]dota/i.test(textOf(mapCompileDry)));
  const mapList = await client.callTool({ name: "map_list", arguments: {} });
  check("map_list runs", !mapList.isError);

  // 12) soundevents (KV3) on the temp addon
  const seUp = await client.callTool({ name: "soundevents_upsert", arguments: { name: "MCP.Test", vsnd_files: ["sounds/ui/x.vsnd"], volume: 0.6 } });
  check("soundevents_upsert creates an event", !seUp.isError && /MCP\.Test/.test(textOf(seUp)));
  const seGet = await client.callTool({ name: "soundevents_get", arguments: { file: "game_sounds_custom.vsndevts", event: "MCP.Test" } });
  check("soundevents_get returns it (KV3 round-trip)", /dota_src1_2d/.test(textOf(seGet)) && /0\.6/.test(textOf(seGet)));

  // 13) events + net tables scaffolding
  const ev = await client.callTool({ name: "scaffold_custom_event", arguments: { name: "mcp_demo_event", fields: { PlayerID: "PlayerID", amount: "number" } } });
  check("scaffold_custom_event writes decl + snippets", !ev.isError && /CustomGameEventManager|GameEvents/.test(textOf(ev)));
  check("custom event d.ts created", existsSync(join(tmp, "src", "common", "mcp_custom_events.d.ts")));
  const nt = await client.callTool({ name: "scaffold_net_table", arguments: { name: "scoreboard" } });
  check("scaffold_net_table writes decl + snippets", !nt.isError && /CustomNetTables/.test(textOf(nt)));

  // 13b) entity catalog
  const ec = await client.callTool({ name: "entity_catalog", arguments: { category: "path" } });
  check("entity_catalog lists path entities (path_track)", /path_track/.test(textOf(ec)));

  // 14) VPK reader against the REAL Dota install (proves base-game access)
  const vf = await client.callTool({ name: "vpk_find", arguments: { query: "scripts/npc/npc_heroes", limit: 5 } });
  check("vpk_find locates base npc_heroes", /npc_heroes\.txt/i.test(textOf(vf)));
  const vr = await client.callTool({ name: "vpk_read", arguments: { path: "scripts/npc/npc_heroes.txt", maxChars: 2000 } });
  check("vpk_read returns base file content", !vr.isError && /DOTAHeroes|#base|npc_dota_hero/i.test(textOf(vr)));

  // 15) kv3_read on a real base soundevents-style KV3 file (absolute path)
  const realVpcf = "C:/Program Files (x86)/Steam/steamapps/common/dota 2 beta/content/dota_addons/addon_template/particles/basic_ambient/basic_ambient.vpcf";
  if (existsSync(realVpcf)) {
    const k3 = await client.callTool({ name: "kv3_read", arguments: { path: realVpcf } });
    check("kv3_read parses a real .vpcf", /CParticleSystemDefinition/.test(textOf(k3)));
  }

  // 16) scaffold_td (temp addon) — waypoint mode + maze mode
  const td = await client.callTool({ name: "scaffold_td", arguments: { waypoints: [[0, 0, 128], [1000, 0, 128], [1000, 1000, 128]] } });
  check("scaffold_td writes director", !td.isError && existsSync(join(tmp, "src", "vscripts", "td", "td_director.ts")));
  const tdMaze = await client.callTool({ name: "scaffold_td", arguments: { maze: true, cell: 256 } });
  check("scaffold_td maze writes pathfinder + maze director", !tdMaze.isError
    && existsSync(join(tmp, "src", "vscripts", "td", "pathfinder.ts"))
    && existsSync(join(tmp, "src", "vscripts", "td", "td_maze.ts")));
  if (existsSync(join(tmp, "src", "vscripts", "td", "td_maze.ts"))) {
    const mz = await readFile(join(tmp, "src", "vscripts", "td", "td_maze.ts"), "utf8");
    check("maze director has canBuildAt + A* path follow", /canBuildAt/.test(mz) && /findPath/.test(mz) && /MoveToPosition/.test(mz));
  }

  // 17) workshop tools — live against installed custom games (if any subscribed)
  const wl = await client.callTool({ name: "workshop_list", arguments: {} });
  const hasItems = !wl.isError && /\d{6,}/.test(textOf(wl));
  check("workshop_list runs", !wl.isError);
  // live search by name (keyless Steam web API)
  const ws = await client.callTool({ name: "workshop_search", arguments: { query: "spin td", limit: 8 } });
  check("workshop_search finds Spin TD by name", !ws.isError && /Spin TD/i.test(textOf(ws)) && /\d{6,}/.test(textOf(ws)));
  if (hasItems && /2860562213|Spin TD/i.test(textOf(wl))) {
    const wr = await client.callTool({ name: "workshop_read", arguments: { id: "2860562213", path: "scripts/vscripts/game/waves.lua", maxChars: 3000 } });
    check("workshop_read reads Spin TD waves.lua", /waveTable/.test(textOf(wr)));
  }

  await client.close();
  await rm(tmp, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("smoke test crashed:", err);
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
});
