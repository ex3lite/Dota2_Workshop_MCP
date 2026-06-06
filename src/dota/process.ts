// Process spawning helpers for build/launch tools.

import { spawn } from "node:child_process";

export interface RunResult {
  command: string;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Cap captured output to avoid flooding the model context. */
  maxOutputChars?: number;
}

/** Run a process to completion, capturing output. */
export function run(exe: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { cwd, timeoutMs = 600_000, maxOutputChars = 20_000 } = opts;
  const command = quoteCommand(exe, args);

  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const clip = (s: string, add: string) => (s.length > maxOutputChars ? s : (s + add).slice(-maxOutputChars * 2));

    child.stdout?.on("data", (d) => (stdout = clip(stdout, d.toString())));
    child.stderr?.on("data", (d) => (stderr = clip(stderr, d.toString())));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ command, code: null, stdout, stderr: stderr + `\n[spawn error] ${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ command, code, stdout: tail(stdout, maxOutputChars), stderr: tail(stderr, maxOutputChars), timedOut });
    });
  });
}

/** Launch a process detached (fire-and-forget), e.g. dota2.exe. */
export function spawnDetached(exe: string, args: string[], cwd?: string): { command: string; pid?: number } {
  const child = spawn(exe, args, { cwd, detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  return { command: quoteCommand(exe, args), pid: child.pid };
}

/** The platform-appropriate npm executable. */
export function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function quoteCommand(exe: string, args: string[]): string {
  const q = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
  return [q(exe), ...args.map(q)].join(" ");
}

function tail(s: string, max: number): string {
  if (s.length <= max) return s;
  return "...(truncated)...\n" + s.slice(-max);
}
