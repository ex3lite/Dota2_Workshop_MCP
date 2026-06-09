// ffmpeg integration for recording short clips (window/screen) and encoding to GIF/MP4.
// Auto-installs a static ffmpeg build on first use (Windows), like VRF / cloudflared / SteamCMD.
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readdir } from "node:fs/promises";
import { run } from "./process.js";
import { pathExists } from "../util/fsx.js";

const FF_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

export function ffmpegDir(): string {
  return process.env.DOTA2_FFMPEG_DIR || join(homedir(), ".dota2-workshop-mcp", "ffmpeg");
}

async function findExe(dir: string): Promise<string | undefined> {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const hit = await findExe(full);
      if (hit) return hit;
    } else if (e.name.toLowerCase() === "ffmpeg.exe") {
      return full;
    }
  }
  return undefined;
}

/** Ensure ffmpeg is installed; download + unzip on first use (Windows). Returns the exe path. */
export async function ensureFfmpeg(): Promise<string> {
  if (process.env.DOTA2_FFMPEG) return process.env.DOTA2_FFMPEG;
  const dir = ffmpegDir();
  let exe = (await pathExists(dir)) ? await findExe(dir) : undefined;
  if (exe) return exe;
  if (process.platform !== "win32") {
    throw new Error("ffmpeg auto-install is Windows-only here. Install ffmpeg and set DOTA2_FFMPEG to its path.");
  }
  await mkdir(dir, { recursive: true });
  const zip = join(dir, "ffmpeg.zip");
  const ps = `Invoke-WebRequest -Uri '${FF_URL}' -OutFile '${zip}'; Expand-Archive -Force '${zip}' '${dir}'`;
  const res = await run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], { timeoutMs: 300_000 });
  exe = await findExe(dir);
  if (!exe) throw new Error("ffmpeg install failed: " + (res.stderr || res.stdout).slice(-400));
  return exe;
}
