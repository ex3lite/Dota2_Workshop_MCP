// Scaffolders: write source files + KV blocks + localization for new content.

import { join } from "node:path";
import { AddonProject } from "../dota/project.js";
import { writeNpcEntry, addLocalizationTokens } from "../dota/kvfiles.js";
import { objectToBlock } from "../kv/index.js";
import { writeTextFile, pathExists, ensureDir } from "../util/fsx.js";
import {
  AbilityBehavior,
  BEHAVIOR_PRESETS,
  tsAbility,
  luaAbility,
  tsModifier,
  luaModifier,
  tsItem,
  panoramaXml,
  panoramaCss,
  panoramaTs,
} from "./templates.js";

export type Lang = "ts" | "lua";

export interface ScaffoldResult {
  created: string[];
  modified: string[];
  notes: string[];
}

const NAME_RE = /^[a-z][a-z0-9_]+$/;

function normalizeSubPath(sub?: string): string {
  if (!sub) return "";
  return sub.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function defaultLang(project: AddonProject, requested?: Lang): Lang {
  if (requested) return requested;
  return project.type === "ts-template" && project.tsVscriptsDir ? "ts" : "lua";
}

async function writeScriptFile(path: string, content: string, overwrite: boolean): Promise<void> {
  if (!overwrite && (await pathExists(path))) {
    throw new Error(`Refusing to overwrite existing file: ${path}. Pass overwrite=true to replace it.`);
  }
  await writeTextFile(path, content, { encoding: "utf8" });
}

function prettyName(name: string): string {
  return name
    .replace(/^(modifier_|item_|npc_dota_)/, "")
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Ability
// ---------------------------------------------------------------------------
export interface ScaffoldAbilityOptions {
  name: string;
  behavior?: AbilityBehavior;
  lang?: Lang;
  subPath?: string;
  texture?: string;
  castRange?: string | number;
  castPoint?: string | number;
  cooldown?: string | number;
  manaCost?: string | number;
  values?: Record<string, string | number>;
  displayName?: string;
  description?: string;
  overwrite?: boolean;
}

function defaultValuesFor(behavior: AbilityBehavior): Record<string, string | number> {
  switch (behavior) {
    case "point":
      return { radius: 300, damage: 100 };
    case "unit_target":
      return { damage: 100 };
    case "no_target":
      return { duration: 5 };
    case "passive":
      return { movespeed_pct: 10 };
    case "channeled":
      return { channel_damage: 100, radius: 400 };
  }
}

export async function scaffoldAbility(project: AddonProject, opts: ScaffoldAbilityOptions): Promise<ScaffoldResult> {
  const name = opts.name;
  if (!NAME_RE.test(name)) throw new Error(`Invalid ability name "${name}" (use lowercase letters, digits, underscores).`);
  const behavior = opts.behavior ?? "no_target";
  const lang = defaultLang(project, opts.lang);
  const sub = normalizeSubPath(opts.subPath);
  const scriptDir = "abilities" + (sub ? "/" + sub : "");
  const relScript = `${scriptDir}/${name}`;
  const scriptFile = `${relScript}.lua`;

  const result: ScaffoldResult = { created: [], modified: [], notes: [] };

  // 1) Source file
  if (lang === "ts") {
    if (!project.tsVscriptsDir) throw new Error("This project has no src/vscripts (not a TS template). Use lang=\"lua\".");
    const tsPath = join(project.tsVscriptsDir, ...relScript.split("/")) + ".ts";
    await writeScriptFile(tsPath, tsAbility(name, behavior, scriptDir), !!opts.overwrite);
    result.created.push(tsPath);
    result.notes.push("Run `npm run dev` (or `npm run build`) to compile the TypeScript to Lua.");
  } else {
    const luaPath = join(project.vscriptsOutDir, ...relScript.split("/")) + ".lua";
    await writeScriptFile(luaPath, luaAbility(name, behavior), !!opts.overwrite);
    result.created.push(luaPath);
  }

  // 2) KV block
  const values = { ...defaultValuesFor(behavior), ...(opts.values ?? {}) };
  const kv: Record<string, unknown> = {
    BaseClass: "ability_lua",
    ScriptFile: scriptFile,
    AbilityBehavior: BEHAVIOR_PRESETS[behavior].flags,
    ...BEHAVIOR_PRESETS[behavior].extraKv,
  };
  if (opts.texture) kv.AbilityTextureName = opts.texture;
  if (opts.castRange !== undefined) kv.AbilityCastRange = String(opts.castRange);
  if (opts.castPoint !== undefined) kv.AbilityCastPoint = String(opts.castPoint);
  if (opts.cooldown !== undefined) kv.AbilityCooldown = String(opts.cooldown);
  if (opts.manaCost !== undefined) kv.AbilityManaCost = String(opts.manaCost);
  if (Object.keys(values).length) kv.AbilityValues = values;

  const { path: kvPath, action } = await writeNpcEntry(project, "abilities", name, objectToBlock(kv), { overwrite: !!opts.overwrite });
  result.modified.push(`${kvPath} (${action} "${name}")`);
  if (action === "skipped") result.notes.push(`KV entry "${name}" already existed — kept it (pass overwrite=true to replace).`);

  // 3) Localization
  const loc = await addLocalizationTokens(
    project,
    {
      [`DOTA_Tooltip_ability_${name}`]: opts.displayName ?? prettyName(name),
      [`DOTA_Tooltip_ability_${name}_Description`]: opts.description ?? "",
    },
    { overwrite: !!opts.overwrite },
  );
  result.modified.push(`${loc.path} (+${loc.added.length} tokens, ${loc.skipped.length} kept)`);

  if (behavior === "passive") {
    result.notes.push(`This passive references "modifier_${name}". Scaffold it with scaffold_modifier.`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Modifier
// ---------------------------------------------------------------------------
export interface ScaffoldModifierOptions {
  name: string;
  lang?: Lang;
  subPath?: string;
  displayName?: string;
  description?: string;
  overwrite?: boolean;
}

export async function scaffoldModifier(project: AddonProject, opts: ScaffoldModifierOptions): Promise<ScaffoldResult> {
  const name = opts.name;
  if (!NAME_RE.test(name)) throw new Error(`Invalid modifier name "${name}".`);
  const lang = defaultLang(project, opts.lang);
  const sub = normalizeSubPath(opts.subPath);
  const scriptDir = "modifiers" + (sub ? "/" + sub : "");
  const relScript = `${scriptDir}/${name}`;
  const result: ScaffoldResult = { created: [], modified: [], notes: [] };

  if (!name.startsWith("modifier_")) result.notes.push('Convention: modifier names usually start with "modifier_".');

  if (lang === "ts") {
    if (!project.tsVscriptsDir) throw new Error("This project has no src/vscripts. Use lang=\"lua\".");
    const tsPath = join(project.tsVscriptsDir, ...relScript.split("/")) + ".ts";
    await writeScriptFile(tsPath, tsModifier(name, scriptDir), !!opts.overwrite);
    result.created.push(tsPath);
    result.notes.push("@registerModifier auto-registers via LinkLuaModifier. Import it where used (e.g. in GameMode.ts) so the file is bundled.");
    result.notes.push("Run `npm run dev` to compile.");
  } else {
    const luaPath = join(project.vscriptsOutDir, ...relScript.split("/")) + ".lua";
    await writeScriptFile(luaPath, luaModifier(name, `${relScript}.lua`), !!opts.overwrite);
    result.created.push(luaPath);
  }

  if (opts.displayName || opts.description) {
    const loc = await addLocalizationTokens(
      project,
      {
        [`DOTA_Tooltip_modifier_${name}`]: opts.displayName ?? prettyName(name),
        [`DOTA_Tooltip_modifier_${name}_Description`]: opts.description ?? "",
      },
      { overwrite: !!opts.overwrite },
    );
    result.modified.push(`${loc.path} (+${loc.added.length} tokens, ${loc.skipped.length} kept)`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Item (items live in the DOTAAbilities namespace)
// ---------------------------------------------------------------------------
export interface ScaffoldItemOptions {
  name: string;
  lang?: Lang;
  subPath?: string;
  cost?: string | number;
  shopTags?: string;
  quality?: string;
  texture?: string;
  values?: Record<string, string | number>;
  displayName?: string;
  description?: string;
  overwrite?: boolean;
}

export async function scaffoldItem(project: AddonProject, opts: ScaffoldItemOptions): Promise<ScaffoldResult> {
  const name = opts.name;
  if (!NAME_RE.test(name)) throw new Error(`Invalid item name "${name}".`);
  if (!name.startsWith("item_")) throw new Error('Item names must start with "item_".');
  const lang = defaultLang(project, opts.lang);
  const sub = normalizeSubPath(opts.subPath);
  const scriptDir = "items" + (sub ? "/" + sub : "");
  const relScript = `${scriptDir}/${name}`;
  const scriptFile = `${relScript}.lua`;
  const result: ScaffoldResult = { created: [], modified: [], notes: [] };

  if (lang === "ts") {
    if (!project.tsVscriptsDir) throw new Error("This project has no src/vscripts. Use lang=\"lua\".");
    const tsPath = join(project.tsVscriptsDir, ...relScript.split("/")) + ".ts";
    await writeScriptFile(tsPath, tsItem(name, scriptDir), !!opts.overwrite);
    result.created.push(tsPath);
    result.notes.push("Run `npm run dev` to compile.");
  } else {
    const luaPath = join(project.vscriptsOutDir, ...relScript.split("/")) + ".lua";
    await writeScriptFile(luaPath, luaAbility(name, "no_target"), !!opts.overwrite);
    result.created.push(luaPath);
  }

  const kv: Record<string, unknown> = {
    BaseClass: "item_lua",
    ScriptFile: scriptFile,
    AbilityBehavior: "DOTA_ABILITY_BEHAVIOR_NO_TARGET",
    AbilityName: name,
    ItemCost: String(opts.cost ?? 0),
    ItemShopTags: opts.shopTags ?? "",
    ItemQuality: opts.quality ?? "common",
  };
  if (opts.texture) kv.AbilityTextureName = opts.texture;
  if (opts.values && Object.keys(opts.values).length) kv.AbilityValues = opts.values;

  const { path: kvPath, action } = await writeNpcEntry(project, "items", name, objectToBlock(kv), { overwrite: !!opts.overwrite });
  result.modified.push(`${kvPath} (${action} "${name}")`);
  if (action === "skipped") result.notes.push(`KV entry "${name}" already existed — kept it (pass overwrite=true to replace).`);

  const loc = await addLocalizationTokens(
    project,
    {
      [`DOTA_Tooltip_ability_${name}`]: opts.displayName ?? prettyName(name),
      [`DOTA_Tooltip_ability_${name}_Description`]: opts.description ?? "",
    },
    { overwrite: !!opts.overwrite },
  );
  result.modified.push(`${loc.path} (+${loc.added.length} tokens, ${loc.skipped.length} kept)`);
  return result;
}

// ---------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------
export interface ScaffoldUnitOptions {
  name: string;
  model?: string;
  baseClass?: string;
  displayName?: string;
  fields?: Record<string, string | number>;
  overwrite?: boolean;
}

export async function scaffoldUnit(project: AddonProject, opts: ScaffoldUnitOptions): Promise<ScaffoldResult> {
  const name = opts.name;
  if (!NAME_RE.test(name)) throw new Error(`Invalid unit name "${name}".`);
  const result: ScaffoldResult = { created: [], modified: [], notes: [] };

  const kv: Record<string, unknown> = {
    BaseClass: opts.baseClass ?? "npc_dota_creature",
    Model: opts.model ?? "models/heroes/<set>/<model>.vmdl",
    Level: "1",
    AttackCapabilities: "DOTA_UNIT_CAP_MELEE_ATTACK",
    AttackDamageMin: "20",
    AttackDamageMax: "26",
    AttackRate: "1.5",
    AttackRange: "100",
    MovementCapabilities: "DOTA_UNIT_CAP_MOVE_GROUND",
    MovementSpeed: "300",
    StatusHealth: "200",
    StatusHealthRegen: "1.0",
    StatusMana: "0",
    ArmorPhysical: "1",
    MagicalResistance: "25",
    VisionDaytimeRange: "800",
    VisionNighttimeRange: "800",
    TeamName: "DOTA_TEAM_NEUTRALS",
    ...(opts.fields ?? {}),
  };

  const { path: kvPath, action } = await writeNpcEntry(project, "units", name, objectToBlock(kv), { overwrite: !!opts.overwrite });
  result.modified.push(`${kvPath} (${action} "${name}")`);
  if (action === "skipped") result.notes.push(`KV entry "${name}" already existed — kept it (pass overwrite=true to replace).`);

  const loc = await addLocalizationTokens(project, { [name]: opts.displayName ?? prettyName(name) }, { overwrite: !!opts.overwrite });
  result.modified.push(`${loc.path} (+${loc.added.length} tokens, ${loc.skipped.length} kept)`);
  result.notes.push("Spawn with CreateUnitByName(\"" + name + "\", ...) from vscripts.");
  return result;
}

// ---------------------------------------------------------------------------
// Hero (override an existing hero — the only supported way)
// ---------------------------------------------------------------------------
export interface ScaffoldHeroOptions {
  name: string; // custom key, e.g. npc_dota_hero_custom_x
  overrideHero: string; // e.g. npc_dota_hero_lina
  abilities?: string[]; // Ability1..N
  displayName?: string;
  fields?: Record<string, string | number>;
  overwrite?: boolean;
}

export async function scaffoldHero(project: AddonProject, opts: ScaffoldHeroOptions): Promise<ScaffoldResult> {
  const name = opts.name;
  if (!NAME_RE.test(name)) throw new Error(`Invalid hero key "${name}".`);
  if (!opts.overrideHero) throw new Error("overrideHero is required — custom games can only override existing heroes.");
  const result: ScaffoldResult = { created: [], modified: [], notes: [] };

  const kv: Record<string, unknown> = { override_hero: opts.overrideHero };
  (opts.abilities ?? []).forEach((ability, i) => {
    kv[`Ability${i + 1}`] = ability;
  });
  Object.assign(kv, opts.fields ?? {});

  const { path: kvPath, action } = await writeNpcEntry(project, "heroes", name, objectToBlock(kv), { overwrite: !!opts.overwrite });
  result.modified.push(`${kvPath} (${action} "${name}")`);
  if (action === "skipped") result.notes.push(`KV entry "${name}" already existed — kept it (pass overwrite=true to replace).`);

  if (opts.displayName) {
    const loc = await addLocalizationTokens(project, { [name]: opts.displayName }, { overwrite: !!opts.overwrite });
    result.modified.push(`${loc.path} (+${loc.added.length} tokens, ${loc.skipped.length} kept)`);
  }
  result.notes.push("Heroes are overrides: only the fields you set replace the base hero's values.");
  return result;
}

// ---------------------------------------------------------------------------
// Panorama panel
// ---------------------------------------------------------------------------
export interface ScaffoldPanelOptions {
  name: string;
  overwrite?: boolean;
}

export async function scaffoldPanoramaPanel(project: AddonProject, opts: ScaffoldPanelOptions): Promise<ScaffoldResult> {
  const panel = opts.name;
  if (!/^[a-z][a-z0-9_]*$/i.test(panel)) throw new Error(`Invalid panel name "${panel}".`);
  const result: ScaffoldResult = { created: [], modified: [], notes: [] };

  const layoutDir = join(project.panoramaContentDir, "layout", "custom_game");
  const stylesDir = join(project.panoramaContentDir, "styles", "custom_game");
  await ensureDir(layoutDir);
  await ensureDir(stylesDir);

  const xmlPath = join(layoutDir, `${panel}.xml`);
  const cssPath = join(stylesDir, `${panel}.css`);
  await writeScriptFile(xmlPath, panoramaXml(panel, `${panel}.css`, `${panel}.js`), !!opts.overwrite);
  await writeScriptFile(cssPath, panoramaCss(panel), !!opts.overwrite);
  result.created.push(xmlPath, cssPath);

  if (project.tsPanoramaDir) {
    const tsPath = join(project.tsPanoramaDir, `${panel}.ts`);
    await writeScriptFile(tsPath, panoramaTs(panel), !!opts.overwrite);
    result.created.push(tsPath);
    result.notes.push(`Add "${panel}" to src/panorama/manifest.ts so it compiles to scripts/custom_game/${panel}.js.`);
  }
  result.notes.push(`Reference ${panel}.xml from content/panorama/layout/custom_game/custom_ui_manifest.xml to show it.`);
  return result;
}
