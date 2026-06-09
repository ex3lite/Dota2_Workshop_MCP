import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

// Point the asset DB at a throwaway file BEFORE any open() happens (open is lazy).
const DB = join(tmpdir(), `assetdb-test-${process.pid}.db`);
process.env.DOTA2_ASSETDB = DB;

const { kindForPath, indexGame, searchAssets, assetDbStats, removeGameFromDb, indexedGameIds, closeAssetDb } =
  await import("../src/dota/assetdb.js");

function cleanup() {
  closeAssetDb();
  for (const ext of ["", "-wal", "-shm"]) rmSync(DB + ext, { force: true });
}

test("kindForPath classifies compiled + source assets", () => {
  assert.equal(kindForPath("models/heroes/tower.vmdl_c"), "model");
  assert.equal(kindForPath("materials/x.vmat_c"), "material");
  assert.equal(kindForPath("particles/spark.vpcf"), "particle");
  assert.equal(kindForPath("soundevents/x.vsndevts_c"), "soundevent");
  assert.equal(kindForPath("sounds/hit.vsnd_c"), "sound");
  assert.equal(kindForPath("scripts/vscripts/main.lua"), "script");
  assert.equal(kindForPath("scripts/npc/npc_units_custom.txt"), "kv");
  assert.equal(kindForPath("panorama/styles/custom_game/hud.vcss_c"), "panorama");
  assert.equal(kindForPath("panorama/images/x.png"), "panorama");
  assert.equal(kindForPath("maps/dota.vpk"), "map");
  assert.equal(kindForPath("textures/icon.vtex_c"), "texture");
  assert.equal(kindForPath("readme.md"), "other");
});

test("indexGame + searchAssets find assets by name/kind/ext", () => {
  indexGame("111", "Tower Game", [
    "models/towers/cannon_tower.vmdl_c",
    "particles/towers/cannon_fire.vpcf_c",
    "sounds/towers/cannon_shot.vsnd_c",
    "scripts/vscripts/towers.lua",
  ]);
  indexGame("222", "Spark RPG", [
    "particles/spark/spark_burst.vpcf_c",
    "models/props/crate.vmdl_c",
  ]);

  assert.deepEqual([...indexedGameIds()].sort(), ["111", "222"]);

  const towers = searchAssets({ query: "tower" });
  assert.ok(towers.length >= 3, "should match the tower assets");
  assert.ok(towers.every((h) => h.game_id === "111"));

  const models = searchAssets({ kind: "model" });
  assert.equal(models.length, 2);

  const sparkParticles = searchAssets({ query: "spark", kind: "particle" });
  assert.equal(sparkParticles.length, 1);
  assert.equal(sparkParticles[0].game_id, "222");

  const byExt = searchAssets({ ext: "vsnd_c" });
  assert.equal(byExt.length, 1);
  assert.equal(byExt[0].kind, "sound");
});

test("indexGame is idempotent (re-index replaces rows)", () => {
  indexGame("111", "Tower Game", ["models/towers/only_one.vmdl_c"]); // fewer files now
  const towers = searchAssets({ id: "111" });
  assert.equal(towers.length, 1, "re-indexing should replace, not append");
});

test("searchAssets escapes LIKE wildcards in the query", () => {
  indexGame("333", "Pct", ["models/a_b/100%scale.vmdl_c", "models/axb/other.vmdl_c"]);
  // a literal '%' must not act as a wildcard
  const pct = searchAssets({ query: "100%" });
  assert.ok(pct.length === 1 && pct[0].game_id === "333", "literal % should match only the real file");
});

test("assetDbStats aggregates by kind/ext", () => {
  const s = assetDbStats();
  assert.ok(s.games >= 2);
  assert.ok(s.assets >= 3);
  assert.ok(s.byKind.model >= 1);
  assert.ok(Array.isArray(s.byExt) && s.byExt.length > 0);
});

test("removeGameFromDb drops a game's rows", () => {
  removeGameFromDb("222");
  assert.ok(!indexedGameIds().has("222"));
  assert.equal(searchAssets({ id: "222" }).length, 0);
  cleanup();
});
