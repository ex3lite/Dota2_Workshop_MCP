// Out-of-engine Source 2 asset decoding via ValveResourceFormat's Source2Viewer-CLI
// (https://github.com/ValveResourceFormat/ValveResourceFormat). Converts compiled
// resources straight from a VPK to standard formats WITHOUT launching Dota:
//   .vtex_c  -> .png      (textures / sprites / icons)
//   .vmdl_c  -> .glb      (models, viewable in a browser)
//   .vpcf_c  -> .vpcf     (particle KV3 text — to read its texture/material refs)
//   .vsnd_c  -> .wav/.mp3 (sounds)
// The CLI auto-installs on first use (Windows), like SteamCMD.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { run } from "./process.js";
import { pathExists } from "../util/fsx.js";

const VRF_VERSION = "19.2";
const VRF_URL = `https://github.com/ValveResourceFormat/ValveResourceFormat/releases/download/${VRF_VERSION}/cli-windows-x64.zip`;

export function vrfDir(): string {
  return process.env.DOTA2_VRF_DIR || join(homedir(), ".dota2-workshop-mcp", "vrf");
}
export function vrfExe(): string {
  return join(vrfDir(), "Source2Viewer-CLI.exe");
}

/** Ensure Source2Viewer-CLI is installed; download + unzip on first use (Windows). */
export async function ensureVrf(): Promise<string> {
  const exe = vrfExe();
  if (await pathExists(exe)) return exe;
  if (process.platform !== "win32") {
    throw new Error("Source2Viewer-CLI auto-install is Windows-only. Install it and set DOTA2_VRF_DIR.");
  }
  const dir = vrfDir();
  await mkdir(dir, { recursive: true });
  const zip = join(dir, "cli.zip");
  const ps =
    `Invoke-WebRequest -Uri '${VRF_URL}' -OutFile '${zip}'; ` +
    `Expand-Archive -Force '${zip}' '${dir}'`;
  const res = await run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], { timeoutMs: 300_000 });
  if (!(await pathExists(exe))) throw new Error("Source2Viewer-CLI install failed: " + (res.stderr || res.stdout).slice(-400));
  return exe;
}

/** List resource paths inside a VPK (optionally filtered by extension(s) / path). */
export async function vrfList(vpk: string, opts: { ext?: string; filter?: string } = {}): Promise<string[]> {
  const exe = await ensureVrf();
  const args = ["-i", vpk, "-l"];
  if (opts.ext) args.push("-e", opts.ext);
  if (opts.filter) args.push("-f", opts.filter);
  const res = await run(exe, args, { timeoutMs: 120_000, maxOutputChars: 2_000_000 });
  return res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((p) => /\.\w+_c$/.test(p));
}

const OUT_EXT: Record<string, string> = { vtex_c: "png", vmdl_c: "glb", vpcf_c: "vpcf", vsnd_c: "wav", vmat_c: "vmat" };

/**
 * Decompile a single resource from a VPK to `outDir`. Returns the produced output file
 * path(s) (e.g. the .png / .glb). `innerPath` may omit the trailing `_c` — VRF path-matches.
 */
export async function vrfDecode(vpk: string, innerPath: string, outDir: string, opts: { glb?: boolean } = {}): Promise<string[]> {
  const exe = await ensureVrf();
  if (!innerPath || innerPath.length < 4) throw new Error("vrfDecode: refusing empty inner path (would dump the whole VPK).");
  await mkdir(outDir, { recursive: true });
  const before = new Set(await walk(outDir));
  const args = ["-i", vpk, "-f", innerPath, "-d", "-o", outDir];
  if (opts.glb || /\.vmdl(_c)?$/i.test(innerPath)) args.push("--gltf_export_format", "glb");
  await run(exe, args, { timeoutMs: 180_000, maxOutputChars: 200_000 });
  const after = await walk(outDir);
  const wantExt = OUT_EXT[innerPath.replace(/^.*\./, "").toLowerCase()] ?? null;
  const produced = after.filter((f) => !before.has(f) && (!wantExt || f.toLowerCase().endsWith("." + wantExt)));
  return produced.length ? produced : after.filter((f) => !before.has(f));
}

/** Decompile a resource and return its decompiled TEXT (for reading vpcf/vmat refs). */
export async function vrfDecompileText(vpk: string, innerPath: string): Promise<string | undefined> {
  const tmp = join(vrfDir(), "_tmp", Math.abs(hash(vpk + innerPath)).toString(36));
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
  try {
    const out = await vrfDecode(vpk, innerPath, tmp);
    const textFile = out.find((f) => /\.(vpcf|vmat|txt)$/i.test(f));
    if (!textFile) return undefined;
    const { readFile } = await import("node:fs/promises");
    return await readFile(textFile, "utf8");
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** Newest file by mtime among paths (for picking a freshly-produced output). */
export async function newest(paths: string[]): Promise<string | undefined> {
  let best: string | undefined;
  let bestM = -1;
  for (const p of paths) {
    const st = await stat(p).catch(() => null);
    if (st && st.mtimeMs > bestM) {
      bestM = st.mtimeMs;
      best = p;
    }
  }
  return best;
}
