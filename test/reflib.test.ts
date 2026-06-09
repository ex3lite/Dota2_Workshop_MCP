import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreQuality } from "../src/dota/reflib.js";

function makeGoodLua(n: number) {
  const files = [];
  for (let i = 0; i < n; i++) {
    const lines = [];
    lines.push(`-- modifier_example_${i}: a documented, structured modifier`);
    lines.push(`LinkLuaModifier("modifier_example_${i}", "modifiers/modifier_example_${i}", LUA_MODIFIER_MOTION_NONE)`);
    lines.push(`modifier_example_${i} = class({})`);
    lines.push(`function modifier_example_${i}:OnCreated(params)`);
    lines.push(`  -- store the caster so we can apply effects each interval`);
    lines.push(`  self.caster = self:GetCaster()`);
    lines.push(`  self:StartIntervalThink(0.5)`);
    lines.push(`end`);
    lines.push(`function modifier_example_${i}:OnIntervalThink()`);
    lines.push(`  -- deal a small amount of damage`);
    lines.push(`  ApplyDamage({ victim = self:GetParent(), attacker = self.caster, damage = 10 })`);
    lines.push(`end`);
    files.push({ path: `scripts/vscripts/modifiers/modifier_example_${i}.lua`, text: lines.join("\n") });
  }
  files.push({ path: "panorama/layout/custom_game/hud.xml", text: "<root><Panel/></root>" });
  files.push({ path: "scripts/npc/npc_abilities_custom.txt", text: '"DOTAAbilities"{ "x" {} }' });
  return files;
}

test("scoreQuality rewards substantial, documented, structured code", () => {
  const { score, metrics } = scoreQuality(makeGoodLua(12));
  assert.ok(metrics.luaFiles === 12, `expected 12 lua files, got ${metrics.luaFiles}`);
  assert.ok(metrics.hasModifiers, "should detect LinkLuaModifier");
  assert.ok(metrics.hasPanorama, "should detect panorama");
  assert.equal(metrics.obfuscated, false);
  assert.ok(metrics.commentRatio > 0.1, `comment ratio should be meaningful, got ${metrics.commentRatio}`);
  assert.ok(score >= 45, `good code should score high, got ${score}`);
});

test("scoreQuality penalizes obfuscated / minified code", () => {
  const blob = "x".repeat(3000);
  const files = [
    { path: "scripts/vscripts/bundle.lua", text: `local a=1 ${blob}` },
    { path: "scripts/vscripts/enc.lua", text: `local s = loadstring("${"y".repeat(400)}")` },
  ];
  const { score, metrics } = scoreQuality(files);
  assert.equal(metrics.obfuscated, true, "should flag obfuscation");
  assert.ok(score < 20, `obfuscated code should score low, got ${score}`);
});

test("scoreQuality handles an empty extraction without throwing", () => {
  const { score, metrics } = scoreQuality([]);
  assert.equal(metrics.luaFiles, 0);
  assert.ok(score >= 0 && score <= 100);
});

test("scoreQuality clamps to 0..100", () => {
  const { score } = scoreQuality(makeGoodLua(200));
  assert.ok(score <= 100 && score >= 0, `score out of range: ${score}`);
});
