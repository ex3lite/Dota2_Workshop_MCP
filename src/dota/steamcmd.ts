// Download Steam Workshop items (Dota custom games, app 570) outside the game via
// SteamCMD. External equivalent of the client's SteamUGC.SubscribeItem: anonymous
// login works for app-570 UGC (verified), so no Steam account is needed.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { run } from "./process.js";
import { pathExists } from "../util/fsx.js";

const APP_ID = "570";

export function steamcmdRoot(): string {
  return process.env.STEAMCMD_DIR || join(homedir(), "steamcmd");
}
export function steamcmdExe(): string {
  return join(steamcmdRoot(), "steamcmd.exe");
}
export function steamcmdWorkshopDir(): string {
  return join(steamcmdRoot(), "steamapps", "workshop", "content", APP_ID);
}

export async function ensureSteamcmd(): Promise<string> {
  const exe = steamcmdExe();
  if (await pathExists(exe)) return exe;
  if (process.platform !== "win32") {
    throw new Error("SteamCMD not found. Install it and set STEAMCMD_DIR (auto-install is Windows-only).");
  }
  const root = steamcmdRoot();
  await mkdir(root, { recursive: true });
  const zip = join(root, "steamcmd.zip");
  const ps =
    "Invoke-WebRequest -Uri 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip' -OutFile '" + zip + "'; " +
    "Expand-Archive -Force '" + zip + "' '" + root + "'";
  const res = await run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], { timeoutMs: 180000 });
  if (!(await pathExists(exe))) throw new Error("SteamCMD install failed: " + (res.stderr || res.stdout).slice(-400));
  return exe;
}

export interface DownloadResult {
  id: string;
  path: string;
  ok: boolean;
  log: string;
}

export async function downloadWorkshopItem(id: string): Promise<DownloadResult> {
  if (!/^\d+$/.test(id)) throw new Error("Invalid workshop id: " + id);
  const exe = await ensureSteamcmd();
  const res = await run(exe, ["+login", "anonymous", "+workshop_download_item", APP_ID, id, "+quit"], {
    cwd: steamcmdRoot(),
    timeoutMs: 900000,
  });
  const path = join(steamcmdWorkshopDir(), id);
  const ok = (await pathExists(path)) && (res.stdout.includes("Success") || (await pathExists(join(path, id + ".vpk"))));
  return { id, path, ok, log: (res.stdout + "\n" + res.stderr).trim() };
}
