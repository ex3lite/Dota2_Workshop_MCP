// Public share-link via a Cloudflare "quick tunnel" — no account, no config: cloudflared
// prints an https://<random>.trycloudflare.com URL that proxies to our local server, so a
// gallery can be opened on any device (phone/laptop) even when a browser can't be opened on
// the remote machine. The cloudflared binary auto-installs on first use (Windows), like VRF.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { run } from "./process.js";
import { pathExists } from "../util/fsx.js";

const CF_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";

export function cloudflaredDir(): string {
  return process.env.DOTA2_CLOUDFLARED_DIR || join(homedir(), ".dota2-workshop-mcp", "cloudflared");
}
export function cloudflaredExe(): string {
  return process.env.DOTA2_CLOUDFLARED || join(cloudflaredDir(), "cloudflared.exe");
}

export async function ensureCloudflared(): Promise<string> {
  const exe = cloudflaredExe();
  if (await pathExists(exe)) return exe;
  if (process.platform !== "win32") {
    throw new Error("cloudflared auto-install is Windows-only here. Install cloudflared and set DOTA2_CLOUDFLARED.");
  }
  await mkdir(cloudflaredDir(), { recursive: true });
  const ps = `Invoke-WebRequest -Uri '${CF_URL}' -OutFile '${exe}'`;
  const res = await run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], { timeoutMs: 300_000 });
  if (!(await pathExists(exe))) throw new Error("cloudflared download failed: " + (res.stderr || res.stdout).slice(-300));
  return exe;
}

export interface Tunnel {
  url: string; // https://<sub>.trycloudflare.com
  stop: () => void;
}

const TRYCF = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/** Start a quick tunnel to a local port; resolves once the public URL appears. */
export async function startQuickTunnel(localUrl: string, opts: { timeoutMs?: number } = {}): Promise<Tunnel> {
  const exe = await ensureCloudflared();
  const proc = spawn(exe, ["tunnel", "--no-autoupdate", "--url", localUrl], { stdio: ["ignore", "pipe", "pipe"] });
  const timeoutMs = opts.timeoutMs ?? 45_000;
  return new Promise<Tunnel>((resolve, reject) => {
    let done = false;
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(TRYCF);
      if (m && !done) {
        done = true;
        clearTimeout(timer);
        resolve({ url: m[0], stop: () => proc.kill() });
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData); // cloudflared prints the URL on stderr
    proc.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    proc.on("exit", (code) => { if (!done) { done = true; clearTimeout(timer); reject(new Error(`cloudflared exited (${code}) before a URL appeared. Last output:\n${buf.slice(-400)}`)); } });
    const timer = setTimeout(() => {
      if (!done) { done = true; proc.kill(); reject(new Error(`cloudflared: no tunnel URL within ${timeoutMs}ms. Output:\n${buf.slice(-400)}`)); }
    }, timeoutMs);
  });
}
