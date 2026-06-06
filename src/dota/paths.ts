// Locate the Dota 2 + Workshop Tools install and derive the paths the MCP needs.
//
// Detection order:
//   1. DOTA2_PATH env override (if it points at a valid "dota 2 beta" root)
//   2. Steam root from the Windows registry (HKCU SteamPath, then HKLM InstallPath)
//   3. steamapps/libraryfolders.vdf -> the library that owns app 570
//   4. the default Program Files location
// The result is validated by checking that game/bin/win64/dota2.exe exists.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { pathExists } from "../util/fsx.js";

const execFileAsync = promisify(execFile);

export interface DotaPaths {
  root: string;
  binWin64: string;
  dota2Exe: string;
  resourceCompilerExe: string;
  vconsoleExe: string;
  gameDotaAddons: string;
  contentDotaAddons: string;
  /** The folder containing gameinfo.gi (game/dota) — the correct -game target for resourcecompiler. */
  dotaGameDir: string;
  gameInfo: string;
  dmxconvertExe: string;
  pak01DirVpk: string;
  workshopContentDir: string; // steamapps/workshop/content/570 (subscribed custom games)
  screenshotsDir: string;
  source: string; // how the root was found
}

const DEFAULT_ROOT = "C:\\Program Files (x86)\\Steam\\steamapps\\common\\dota 2 beta";

function derive(root: string, source: string): DotaPaths {
  const binWin64 = join(root, "game", "bin", "win64");
  return {
    root,
    binWin64,
    dota2Exe: join(binWin64, "dota2.exe"),
    resourceCompilerExe: join(binWin64, "resourcecompiler.exe"),
    vconsoleExe: join(binWin64, "vconsole2.exe"),
    gameDotaAddons: join(root, "game", "dota_addons"),
    contentDotaAddons: join(root, "content", "dota_addons"),
    dotaGameDir: join(root, "game", "dota"),
    gameInfo: join(root, "game", "dota", "gameinfo.gi"),
    dmxconvertExe: join(binWin64, "dmxconvert.exe"),
    pak01DirVpk: join(root, "game", "dota", "pak01_dir.vpk"),
    workshopContentDir: join(root, "..", "..", "workshop", "content", "570"),
    screenshotsDir: join(root, "game", "dota", "screenshots"),
    source,
  };
}

async function regQuery(key: string, value: string): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  try {
    const { stdout } = await execFileAsync("reg", ["query", key, "/v", value]);
    // Output: "    SteamPath    REG_SZ    c:/program files (x86)/steam"
    const line = stdout.split(/\r?\n/).find((l) => l.includes(value));
    if (!line) return undefined;
    const m = line.match(/REG_\w+\s+(.+)$/);
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

async function findSteamRoot(): Promise<string | undefined> {
  const candidates = [
    await regQuery("HKCU\\Software\\Valve\\Steam", "SteamPath"),
    await regQuery("HKLM\\SOFTWARE\\Wow6432Node\\Valve\\Steam", "InstallPath"),
    await regQuery("HKLM\\SOFTWARE\\Valve\\Steam", "InstallPath"),
  ];
  for (const c of candidates) {
    if (c) {
      const normalized = c.replace(/\//g, "\\");
      if (await pathExists(normalized)) return normalized;
    }
  }
  return undefined;
}

async function findDotaViaLibraryFolders(steamRoot: string): Promise<string | undefined> {
  const vdf = join(steamRoot, "steamapps", "libraryfolders.vdf");
  if (!(await pathExists(vdf))) return undefined;
  const { readFile } = await import("node:fs/promises");
  const txt = await readFile(vdf, "utf8");

  // Each library block has a "path" then an "apps" sub-block whose keys are app ids.
  const blockRe = /"path"\s*"([^"]+)"[\s\S]*?"apps"\s*\{([\s\S]*?)\}/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(txt))) {
    const libPath = m[1].replace(/\\\\/g, "\\");
    if (/"570"/.test(m[2])) {
      const candidate = join(libPath, "steamapps", "common", "dota 2 beta");
      if (await pathExists(candidate)) return candidate;
    }
  }
  return undefined;
}

let cached: DotaPaths | undefined;

/** Resolve the Dota install. Returns undefined if no valid install is found. */
export async function resolveDotaPaths(force = false): Promise<DotaPaths | undefined> {
  if (cached && !force) return cached;

  const tryRoot = async (root: string | undefined, source: string): Promise<DotaPaths | undefined> => {
    if (!root) return undefined;
    const p = derive(root, source);
    if (await pathExists(p.dota2Exe)) return p;
    return undefined;
  };

  const envRoot = process.env.DOTA2_PATH;
  let result =
    (await tryRoot(envRoot, "DOTA2_PATH env")) ??
    undefined;

  if (!result) {
    const steam = await findSteamRoot();
    if (steam) {
      const viaLib = await findDotaViaLibraryFolders(steam);
      result =
        (await tryRoot(viaLib, "libraryfolders.vdf (app 570)")) ??
        (await tryRoot(join(steam, "steamapps", "common", "dota 2 beta"), "steam default library")) ??
        undefined;
    }
  }

  if (!result) result = await tryRoot(DEFAULT_ROOT, "default path");

  if (result) cached = result;
  return result;
}

/** Like resolveDotaPaths but throws a helpful error when not found. */
export async function requireDotaPaths(): Promise<DotaPaths> {
  const p = await resolveDotaPaths();
  if (!p) {
    throw new Error(
      "Could not locate the Dota 2 install. Set the DOTA2_PATH environment variable to your " +
        '"dota 2 beta" folder (the one containing game\\bin\\win64\\dota2.exe).',
    );
  }
  return p;
}

export async function hasWorkshopTools(p: DotaPaths): Promise<boolean> {
  // The tools DLC ships resourcecompiler.exe + the sdktools manifest.
  return (await pathExists(p.resourceCompilerExe)) && (await pathExists(join(p.binWin64, "..", "sdkenginetools.txt")));
}
