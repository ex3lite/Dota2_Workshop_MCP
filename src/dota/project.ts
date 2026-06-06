// Detect the addon project the MCP is operating on, and its layout.
//
// Two layouts are supported:
//   - "ts-template": the ModDota TypeScript-Addon-Template (root/src/vscripts via
//      typescript-to-lua, root/game, root/content, addon name from package.json).
//   - "raw": a plain addon folder whose game files live directly under the root
//      (root/scripts/npc, root/scripts/vscripts) — e.g. a folder inside dota_addons.

import { join, basename } from "node:path";
import { readFile } from "node:fs/promises";
import { pathExists } from "../util/fsx.js";

export type ProjectType = "ts-template" | "raw" | "unknown";

export interface AddonProject {
  root: string;
  type: ProjectType;
  addonName: string;
  /** Compiled "game" tree root (KV scripts, compiled lua, resource, panorama). */
  gameDir: string;
  /** Source "content" tree root (maps, particles, panorama sources). */
  contentDir: string;
  /** game/scripts/npc — where npc_*_custom.txt live. */
  npcDir: string;
  /** Compiled vscripts output (game/scripts/vscripts). */
  vscriptsOutDir: string;
  /** localization file resource/addon_english.txt. */
  localizationFile: string;
  /** TypeScript vscripts source dir (ts-template only). */
  tsVscriptsDir?: string;
  /** TypeScript panorama source dir (ts-template only). */
  tsPanoramaDir?: string;
  /** content/panorama (layout/styles/scripts sources). */
  panoramaContentDir: string;
  hasTstl: boolean;
}

const ADDON_NAME_RE = /^[a-z][a-z0-9_]+$/;

async function readPackageJson(root: string): Promise<{ name?: string; deps: Record<string, string> } | undefined> {
  const pkgPath = join(root, "package.json");
  if (!(await pathExists(pkgPath))) return undefined;
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    return {
      name: pkg.name,
      deps: { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) },
    };
  } catch {
    return undefined;
  }
}

export function validateAddonName(name: string): void {
  if (!ADDON_NAME_RE.test(name)) {
    throw new Error(
      `Invalid addon name "${name}". It must be lowercase letters, digits and underscores, ` +
        "and start with a letter (this is the dota_addons/<name> folder name).",
    );
  }
}

export async function detectProject(root: string): Promise<AddonProject> {
  const pkg = await readPackageJson(root);
  const hasTstl = !!pkg && ("typescript-to-lua" in pkg.deps || "@moddota/dota-lua-types" in pkg.deps);

  const templateLayout =
    (await pathExists(join(root, "src", "vscripts"))) || (await pathExists(join(root, "game", "scripts")));
  const rawLayout = await pathExists(join(root, "scripts", "npc"));

  let type: ProjectType = "unknown";
  let gameDir: string;
  let contentDir: string;

  if (templateLayout || hasTstl) {
    type = hasTstl ? "ts-template" : "raw";
    gameDir = join(root, "game");
    contentDir = join(root, "content");
  } else if (rawLayout) {
    type = "raw";
    gameDir = root;
    contentDir = root;
  } else {
    // Best-effort default to the template layout.
    gameDir = join(root, "game");
    contentDir = join(root, "content");
  }

  // Addon name: package.json name, else the project folder name.
  const addonName = (pkg?.name ?? basename(root)).toLowerCase();

  const project: AddonProject = {
    root,
    type,
    addonName,
    gameDir,
    contentDir,
    npcDir: join(gameDir, "scripts", "npc"),
    vscriptsOutDir: join(gameDir, "scripts", "vscripts"),
    localizationFile: join(gameDir, "resource", "addon_english.txt"),
    panoramaContentDir: join(contentDir, "panorama"),
    hasTstl,
  };

  if (await pathExists(join(root, "src", "vscripts"))) project.tsVscriptsDir = join(root, "src", "vscripts");
  if (await pathExists(join(root, "src", "panorama"))) project.tsPanoramaDir = join(root, "src", "panorama");

  return project;
}

/** Map a logical KV file name to its filename under npcDir. */
export const NPC_FILES = {
  abilities: "npc_abilities_custom.txt",
  items: "npc_items_custom.txt",
  units: "npc_units_custom.txt",
  heroes: "npc_heroes_custom.txt",
} as const;

export type NpcFileKey = keyof typeof NPC_FILES;

export const NPC_WRAPPER: Record<NpcFileKey, string> = {
  abilities: "DOTAAbilities",
  items: "DOTAAbilities",
  units: "DOTAUnits",
  heroes: "DOTAHeroes",
};
