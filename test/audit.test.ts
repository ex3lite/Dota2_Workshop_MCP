import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectProject } from "../src/dota/project.js";
import { auditAddon } from "../src/dota/audit.js";
import { writeTextFile } from "../src/util/fsx.js";

async function buildAddon(root: string) {
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, "src", "vscripts"), { recursive: true });
  await mkdir(join(root, "content", "panorama", "scripts", "custom_game"), { recursive: true });
  await mkdir(join(root, "game", "scripts", "npc"), { recursive: true });
  await mkdir(join(root, "game", "resource"), { recursive: true });

  await writeFile(join(root, "package.json"), JSON.stringify({ name: "audittest", devDependencies: { "typescript-to-lua": "^1" } }));

  // Server: has Precache (PrecacheResource), a listener, and two AllClients sends (one with a string payload).
  await writeFile(
    join(root, "src", "vscripts", "addon_game_mode.lua"),
    `function Precache(context)\n  PrecacheResource("particle", "particles/x.vpcf", context)\nend\n` +
      `CustomGameEventManager:RegisterListener("known_event", function() end)\n` +
      `CustomGameEventManager:Send_ServerToAllClients("server_event", { x = 1 })\n` +
      `CustomGameEventManager:Send_ServerToAllClients("server_event", "somepayload")\n`,
    "utf8",
  );

  // Client: fires a dead event (no server listener) + subscribes to server_event.
  await writeFile(
    join(root, "content", "panorama", "scripts", "custom_game", "ui.js"),
    `GameEvents.SendCustomGameEventToServer("dead_event", {});\nGameEvents.Subscribe("server_event", function(){});\n`,
    "utf8",
  );

  // Abilities: visible+tip (ok), notip (missing), notip_extra (has tip, prefix-collision bait), hidden (skip).
  await writeFile(
    join(root, "game", "scripts", "npc", "npc_abilities_custom.txt"),
    `"DOTAAbilities"\n{\n` +
      `  "Version" "1"\n` +
      `  "ability_visible" { "BaseClass" "ability_lua" "AbilityBehavior" "DOTA_ABILITY_BEHAVIOR_POINT" }\n` +
      `  "ability_notip" { "BaseClass" "ability_lua" "AbilityBehavior" "DOTA_ABILITY_BEHAVIOR_NO_TARGET" }\n` +
      `  "ability_notip_extra" { "BaseClass" "ability_lua" "AbilityBehavior" "DOTA_ABILITY_BEHAVIOR_NO_TARGET" }\n` +
      `  "ability_hidden" { "BaseClass" "ability_lua" "AbilityBehavior" "DOTA_ABILITY_BEHAVIOR_HIDDEN" }\n` +
      `}\n`,
    "utf8",
  );

  // Localization (UTF-16 LE + BOM) — has tooltips for visible + notip_extra only.
  await writeTextFile(
    join(root, "game", "resource", "addon_english.txt"),
    `"lang"\n{\n  "Language" "English"\n  "Tokens"\n  {\n` +
      `    "DOTA_Tooltip_ability_ability_visible" "Visible"\n` +
      `    "DOTA_Tooltip_ability_ability_notip_extra" "Extra"\n` +
      `  }\n}\n`,
    { encoding: "utf16le", bom: true },
  );
}

test("auditAddon: precache present (PrecacheResource) → no precache-missing (regression #5)", async () => {
  const root = join(tmpdir(), "mcp-audit-test");
  await buildAddon(root);
  const project = await detectProject(root);
  const { findings } = await auditAddon(project);
  assert.equal(findings.some((f) => f.rule === "precache-missing"), false, "PrecacheResource should satisfy the precache check");
  await rm(root, { recursive: true, force: true });
});

test("auditAddon: dead client event flagged; AllClients string payload NOT flagged (regression #7)", async () => {
  const root = join(tmpdir(), "mcp-audit-test2");
  await buildAddon(root);
  const project = await detectProject(root);
  const { findings } = await auditAddon(project);
  assert.ok(findings.some((f) => f.rule === "custom-event-no-listener" && f.message.includes("dead_event")), "dead_event should be flagged");
  assert.equal(findings.some((f) => f.message.includes("somepayload")), false, "the AllClients string payload must not be treated as an event");
  await rm(root, { recursive: true, force: true });
});

test("auditAddon: missing tooltip exact-match (prefix collision not masked) + hidden skipped (regression #6/#8)", async () => {
  const root = join(tmpdir(), "mcp-audit-test3");
  await buildAddon(root);
  const project = await detectProject(root);
  const { findings } = await auditAddon(project);
  const tipMissing = (k: string) => findings.some((f) => f.rule === "missing-tooltip" && f.message.includes(`"${k}"`));
  assert.ok(tipMissing("ability_notip"), "ability_notip is genuinely missing a tooltip (must not be masked by ability_notip_extra)");
  assert.equal(tipMissing("ability_visible"), false, "ability_visible has a tooltip");
  assert.equal(tipMissing("ability_notip_extra"), false, "ability_notip_extra has a tooltip");
  assert.equal(tipMissing("ability_hidden"), false, "hidden abilities are skipped");
  await rm(root, { recursive: true, force: true });
});
