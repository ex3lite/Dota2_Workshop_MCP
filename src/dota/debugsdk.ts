// Attach / detach the bundled MCP DebugSDK (src/data/debug-sdk/mcp_debug.lua) to an
// addon. The SDK is a self-contained Lua module that registers `mcp_*` console
// commands the MCP drives over VConsole. "Attaching" = copy the lua into the addon's
// runtime vscripts dir + wire a `require("mcp_debug")` into the game-mode bootstrap.
//
// It works for both layouts:
//   - ts-template: requires from src/vscripts/addon_game_mode.ts (tstl emits the require)
//   - raw / runtime: requires from game/scripts/vscripts/addon_game_mode.lua
// Re-running is idempotent (guarded by a marker comment). detach removes both.

import { readFile, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { AddonProject } from "./project.js";
import { resolveDataPath } from "../util/datapath.js";
import { pathExists, ensureDir } from "../util/fsx.js";

const MARKER = "[MCP DebugSDK]";

const LUA_SNIPPET =
  `-- ${MARKER} auto-attached; remove this line + mcp_debug.lua to detach\n` +
  `pcall(require, "mcp_debug")\n`;

const TS_SNIPPET =
  `// ${MARKER} auto-attached; remove these two lines to detach\n` +
  `declare function require(module: string): unknown;\n` +
  `require("mcp_debug");\n`;

export interface AttachResult {
  copiedTo: string[];
  bootstrapFile?: string;
  bootstrapAction: "inserted" | "already-present" | "not-found" | "skipped (dryRun)";
  instructions: string[];
  dryRun: boolean;
}

async function bundledSdkPath(): Promise<string> {
  return resolveDataPath("debug-sdk/mcp_debug.lua");
}

/** Find the best bootstrap file to wire the require into. */
async function findBootstrap(project: AddonProject): Promise<{ file: string; kind: "ts" | "lua" } | undefined> {
  const candidates: { file: string; kind: "ts" | "lua" }[] = [];
  if (project.tsVscriptsDir) candidates.push({ file: join(project.tsVscriptsDir, "addon_game_mode.ts"), kind: "ts" });
  candidates.push({ file: join(project.vscriptsOutDir, "addon_game_mode.lua"), kind: "lua" });
  candidates.push({ file: join(project.root, "scripts", "vscripts", "addon_game_mode.lua"), kind: "lua" });
  for (const c of candidates) {
    if (await pathExists(c.file)) return c;
  }
  return undefined;
}

export async function attachDebugSdk(project: AddonProject, dryRun = false): Promise<AttachResult> {
  const src = await bundledSdkPath();
  const instructions: string[] = [];
  const copiedTo: string[] = [];

  // Runtime location Lua's require() resolves against.
  const runtimeDest = join(project.vscriptsOutDir, "mcp_debug.lua");
  copiedTo.push(runtimeDest);
  // For ts-template, also keep a copy next to source so a clean rebuild still has it
  // available where teams keep loose lua (harmless if unused).
  if (project.tsVscriptsDir) copiedTo.push(join(project.tsVscriptsDir, "mcp_debug.lua"));

  const boot = await findBootstrap(project);
  let bootstrapAction: AttachResult["bootstrapAction"] = boot ? "inserted" : "not-found";
  let bootstrapFile = boot?.file;

  if (boot) {
    const existing = await readFile(boot.file, "utf8");
    if (existing.includes(MARKER)) {
      bootstrapAction = "already-present";
    }
  }

  if (dryRun) {
    instructions.push(`[dry run] would copy mcp_debug.lua -> ${copiedTo.join(", ")}`);
    if (boot && bootstrapAction !== "already-present") {
      instructions.push(`[dry run] would insert require into ${boot.file} (${boot.kind})`);
    }
    return { copiedTo, bootstrapFile, bootstrapAction: "skipped (dryRun)", instructions, dryRun: true };
  }

  // Copy the SDK.
  for (const dest of copiedTo) {
    await ensureDir(join(dest, ".."));
    await copyFile(src, dest);
  }

  // Wire the require.
  if (boot && bootstrapAction === "inserted") {
    const existing = await readFile(boot.file, "utf8");
    const snippet = boot.kind === "ts" ? TS_SNIPPET : LUA_SNIPPET;
    await writeFile(boot.file, snippet + "\n" + existing, "utf8");
    instructions.push(`Wired require into ${boot.file}.`);
  } else if (!boot) {
    instructions.push(
      "No addon_game_mode bootstrap found. Add this where your game mode initializes:",
      project.hasTstl ? TS_SNIPPET.trim() : LUA_SNIPPET.trim(),
    );
  } else {
    instructions.push("Bootstrap already references the DebugSDK — left as-is.");
  }

  if (project.hasTstl && boot?.kind === "ts") {
    instructions.push("Run addon_build (tstl) so the require compiles, then dota_restart_game.");
  } else {
    instructions.push("Run dota_restart_game (or attach before launching) so the SDK loads.");
  }
  instructions.push('Verify with: dota_send_console_command command="mcp_ping" (expect "[MCP] PONG ...").');

  return { copiedTo, bootstrapFile, bootstrapAction, instructions, dryRun: false };
}

export interface DetachResult {
  removedFiles: string[];
  bootstrapFile?: string;
  bootstrapCleaned: boolean;
}

async function removeMarkerBlock(file: string): Promise<boolean> {
  if (!(await pathExists(file))) return false;
  const text = await readFile(file, "utf8");
  if (!text.includes(MARKER)) return false;
  // Drop the marker line and the up-to-2 injected lines that follow it (the
  // require / declare lines for either the .lua or .ts snippet).
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let skip = 0;
  for (const line of lines) {
    if (line.includes(MARKER)) {
      skip = 2; // the snippet adds at most 2 lines after the marker
      continue;
    }
    if (skip > 0 && /mcp_debug|declare function require/.test(line)) {
      skip--;
      continue;
    }
    skip = 0;
    kept.push(line);
  }
  await writeFile(file, kept.join("\n").replace(/^\n+/, ""), "utf8");
  return true;
}

export async function detachDebugSdk(project: AddonProject): Promise<DetachResult> {
  const removedFiles: string[] = [];
  const { rm } = await import("node:fs/promises");
  for (const f of [join(project.vscriptsOutDir, "mcp_debug.lua"), project.tsVscriptsDir && join(project.tsVscriptsDir, "mcp_debug.lua")].filter(Boolean) as string[]) {
    if (await pathExists(f)) {
      await rm(f, { force: true });
      removedFiles.push(f);
    }
  }
  const boot = await findBootstrap(project);
  let bootstrapCleaned = false;
  if (boot) bootstrapCleaned = await removeMarkerBlock(boot.file);
  return { removedFiles, bootstrapFile: boot?.file, bootstrapCleaned };
}
