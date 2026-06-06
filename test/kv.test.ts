import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKV, serializeKV, getWrapperBlock, blockToObject, objectToBlock, upsertPair, findPair, listBases, isBlock } from "../src/kv/index.js";

test("parses a basic ability block", () => {
  const src = `"DOTAAbilities"
{
    "Version" "1"
    "my_ability"
    {
        "AbilityBehavior" "DOTA_ABILITY_BEHAVIOR_NO_TARGET | DOTA_ABILITY_BEHAVIOR_IMMEDIATE"
        "AbilityValues"
        {
            "duration" "5.0"
        }
    }
}`;
  const doc = parseKV(src);
  const wrapper = getWrapperBlock(doc)!;
  const obj = blockToObject(wrapper) as any;
  assert.equal(obj.Version, "1");
  assert.equal(obj.my_ability.AbilityBehavior, "DOTA_ABILITY_BEHAVIOR_NO_TARGET | DOTA_ABILITY_BEHAVIOR_IMMEDIATE");
  assert.equal(obj.my_ability.AbilityValues.duration, "5.0");
});

test("preserves #base directives", () => {
  const src = `#base "heroes/meepo.kv"\n"DOTAAbilities"\n{\n}`;
  const doc = parseKV(src);
  assert.deepEqual(listBases(doc), ["heroes/meepo.kv"]);
  const out = serializeKV(doc);
  assert.ok(out.includes('#base "heroes/meepo.kv"'));
});

test("round-trips comments on untouched entries", () => {
  const src = `"DOTAAbilities"
{
    // banner comment
    "ability_a"
    {
        "AbilityManaCost" "100" // mana
    }
    "ability_b"
    {
        "AbilityManaCost" "50"
    }
}`;
  const doc = parseKV(src);
  const wrapper = getWrapperBlock(doc)!;
  // edit ability_b only
  upsertPair(wrapper, "ability_b", objectToBlock({ AbilityManaCost: "75" }));
  const out = serializeKV(doc);
  assert.ok(out.includes("banner comment"), "comment on ability_a preserved");
  assert.ok(out.includes("// mana"), "inline comment preserved");
  assert.ok(out.includes('"75"'), "ability_b updated");
});

test("lenient with malformed single-slash comment line", () => {
  const src = `"DOTAUnits"\n{\n/=== weird banner ===\n"npc_x" { "Model" "m.vmdl" }\n}`;
  const doc = parseKV(src);
  const wrapper = getWrapperBlock(doc)!;
  const pair = findPair(wrapper, "npc_x")!;
  assert.ok(isBlock(pair.value));
});

test("objectToBlock coerces numbers and booleans", () => {
  const block = objectToBlock({ a: 5, b: true, c: false, d: "x" });
  const obj = blockToObject(block) as any;
  assert.equal(obj.a, "5");
  assert.equal(obj.b, "1");
  assert.equal(obj.c, "0");
  assert.equal(obj.d, "x");
});

test("comment or [$cond] between a key and its block does not throw", () => {
  const src = `"DOTAAbilities"
{
    "a" // base ability
    {
        "x" "1"
    }
    "b" [$WIN32]
    {
        "y" "2"
    }
}`;
  const doc = parseKV(src);
  const w = getWrapperBlock(doc)!;
  assert.ok(isBlock(findPair(w, "a")!.value), "a is a block");
  assert.ok(isBlock(findPair(w, "b")!.value), "b is a block");
  const out = serializeKV(doc);
  assert.ok(out.includes("[$WIN32]"), "block condition round-trips");
});

test("backslash paths are not doubled (idempotent round-trip)", () => {
  const src = `"DOTAUnits"
{
    "npc_x"
    {
        "Model" "models\\heroes\\x.vmdl"
    }
}`;
  const out = serializeKV(parseKV(src));
  assert.ok(out.includes("models\\heroes\\x.vmdl"), "single backslashes preserved");
  assert.ok(!out.includes("models\\\\heroes"), "backslashes not doubled");
  assert.equal(serializeKV(parseKV(out)), out, "serialize is idempotent");
});

test("leading-slash value is not swallowed as a comment", () => {
  const doc = parseKV(`"D"\n{\n"k" "/relative/path"\n}`);
  const obj = blockToObject(getWrapperBlock(doc)!) as any;
  assert.equal(obj.k, "/relative/path");
});

test("nested AbilityValues blocks round-trip", () => {
  const src = `"DOTAAbilities"
{
    "x"
    {
        "AbilityValues"
        {
            "radius"
            {
                "value" "220"
                "affected_by_aoe_increase" "1"
            }
        }
    }
}`;
  const doc = parseKV(src);
  const obj = blockToObject(getWrapperBlock(doc)!) as any;
  assert.equal(obj.x.AbilityValues.radius.value, "220");
  assert.equal(obj.x.AbilityValues.radius.affected_by_aoe_increase, "1");
});
