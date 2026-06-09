// Detect when the Dota 2 / Source 2 tools are STUCK on a blocking modal that the normal capture
// paths can't see. When the engine hits an assert, a watchdog "Stall Detected", or a crash dialog,
// it spawns a SEPARATE top-level window — often hidden BEHIND the main game window (visible=false)
// — and blocks the main thread waiting for a click. Symptom: every screenshot/record comes back
// empty, RAM is low and CPU is flat. The only way to know is to enumerate ALL of the process's
// top-level windows (not just MainWindowHandle), classify them, and read the dialog text.
//
// This module enumerates those windows via Win32 (PowerShell + Add-Type, like capture.ts), reads
// the child-control text of any dialog/watchdog/crash window, classifies each window, and can
// dismiss a blocker by clicking a safe button (BM_CLICK, no focus needed).
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./process.js";

export type WindowRole = "game" | "assert" | "stall" | "crash" | "dialog" | "tools" | "noise" | "other";

export interface RawWindow {
  hwnd: string;
  visible: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
  className: string;
  title: string;
  childTexts: string[];
  buttons: string[];
}

export interface DiagWindow extends RawWindow {
  role: WindowRole;
  /** Joined child static text (the assert message), for dialog-like windows. */
  message?: string;
}

export interface DiagProcess {
  pid: number;
  memMB: number;
  cpu: number;
  windows: DiagWindow[];
}

export interface DotaDiagnosis {
  running: boolean;
  processes: DiagProcess[];
  /** A blocking modal (assert / stall / crash / generic dialog) is present on any dota process. */
  blocked: boolean;
  /** The blocking windows, most severe first. */
  blockers: DiagWindow[];
  /** Human-readable one-screen summary. */
  summary: string;
}

// Roles that mean "the engine is waiting for input and the game thread is stuck".
const BLOCKING_ROLES: ReadonlySet<WindowRole> = new Set(["assert", "stall", "crash", "dialog"]);

/** Pure classification of one top-level window — unit-testable, no I/O. */
export function classifyWindow(w: RawWindow): WindowRole {
  const cls = w.className || "";
  const title = w.title || "";
  const blob = `${title} ${(w.childTexts || []).join(" ")}`.toLowerCase();

  // Classify by window CLASS first — a standard dialog box is a real modal regardless of size, so
  // it must win over the size-based noise heuristic below (a tiny #32770 is still a blocker).
  if (cls === "SDL_app") return "game"; // the real game render window
  if (cls === "WatchdogThreadWndClass" || /stall detected/i.test(title)) return "stall";
  if (cls === "#32770") {
    if (/assert/.test(blob)) return "assert";
    if (/crash|fatal|unhandled exception|has stopped working|access violation/.test(blob)) return "crash";
    return "dialog"; // some other modal message box
  }
  if (/crash|fatal|unhandled exception|has stopped working|access violation/.test(blob)) return "crash";

  // Input-method / shadow / zero-size helper windows — pure noise.
  if (/^(MSCTFIME UI|IME|Default IME)$/i.test(cls)) return "noise";
  if (/PopupDropShadow|SaveBits/i.test(cls)) return "noise";
  if (w.width === 0 && w.height === 0) return "noise";
  if (w.width <= 120 && w.height <= 40) return "noise";

  // Qt tool windows (Asset Browser, Hammer, etc.) with a real title — informative, not blocking.
  if (/^Qt/i.test(cls) && title) return "tools";
  return "other";
}

function severity(role: WindowRole): number {
  switch (role) {
    case "crash": return 4;
    case "assert": return 3;
    case "stall": return 2;
    case "dialog": return 1;
    default: return 0;
  }
}

const PS_DIAGNOSE = String.raw`$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class Diag {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static List<IntPtr> Top(uint t) { var res = new List<IntPtr>(); EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == t) res.Add(h); return true; }, IntPtr.Zero); return res; }
  public static List<IntPtr> Kids(IntPtr p) { var res = new List<IntPtr>(); EnumChildWindows(p, (h, l) => { res.Add(h); return true; }, IntPtr.Zero); return res; }
  public static string Txt(IntPtr h) { var sb = new StringBuilder(1024); GetWindowText(h, sb, 1024); return sb.ToString(); }
  public static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
}
"@
$procs = @(Get-Process dota2 -ErrorAction SilentlyContinue)
$out = @()
foreach ($p in $procs) {
  $wins = @()
  foreach ($h in [Diag]::Top([uint32]$p.Id)) {
    $cls = [Diag]::Cls($h); $title = [Diag]::Txt($h)
    $r = New-Object Diag+RECT; [void][Diag]::GetWindowRect($h, [ref]$r)
    $w = $r.R - $r.L; $ht = $r.B - $r.T
    $childTexts = @(); $buttons = @()
    $isDialog = ($cls -eq '#32770') -or ($cls -eq 'WatchdogThreadWndClass') -or ($title -match '(?i)assert|stall|crash|fatal|error|fail')
    if ($isDialog) {
      foreach ($k in [Diag]::Kids($h)) {
        $kc = [Diag]::Cls($k); $kt = [Diag]::Txt($k)
        if ($kt.Length -gt 0) { if ($kc -match '(?i)button') { $buttons += $kt } else { $childTexts += $kt } }
      }
    }
    $cpuVal = 0.0; if ($p.CPU) { $cpuVal = [double]$p.CPU }
    $wins += [ordered]@{ hwnd = "$([int64]$h)"; visible = [bool][Diag]::IsWindowVisible($h); left = $r.L; top = $r.T; width = $w; height = $ht; className = $cls; title = $title; childTexts = @($childTexts); buttons = @($buttons) }
  }
  $cpuVal = 0.0; if ($p.CPU) { $cpuVal = [double]$p.CPU }
  $out += [ordered]@{ pid = $p.Id; memMB = [int]($p.WorkingSet64 / 1MB); cpu = $cpuVal; windows = @($wins) }
}
ConvertTo-Json @($out) -Depth 6 -Compress
`;

function toArray<T>(x: T[] | T | null | undefined): T[] {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

/** Enumerate every dota2 process's top-level windows, classify them, and flag blocking modals. */
export async function diagnoseDota(): Promise<DotaDiagnosis> {
  if (process.platform !== "win32") {
    return { running: false, processes: [], blocked: false, blockers: [], summary: "Window diagnosis is Windows-only." };
  }
  const dir = await mkdtemp(join(tmpdir(), "d2diag-"));
  const ps1 = join(dir, "diag.ps1");
  let raw = "[]";
  try {
    await writeFile(ps1, PS_DIAGNOSE, "utf8");
    const res = await run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], { timeoutMs: 25_000, maxOutputChars: 200_000 });
    raw = res.stdout.trim() || "[]";
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { running: false, processes: [], blocked: false, blockers: [], summary: `Could not parse window list:\n${raw.slice(0, 300)}` };
  }

  const procsRaw = toArray(parsed as DiagProcess[]);
  const processes: DiagProcess[] = procsRaw.map((p: any) => ({
    pid: Number(p.pid),
    memMB: Number(p.memMB) || 0,
    cpu: Number(p.cpu) || 0,
    windows: toArray<any>(p.windows).map((w: any): DiagWindow => {
      const win: RawWindow = {
        hwnd: String(w.hwnd),
        visible: !!w.visible,
        left: Number(w.left) || 0,
        top: Number(w.top) || 0,
        width: Number(w.width) || 0,
        height: Number(w.height) || 0,
        className: String(w.className ?? ""),
        title: String(w.title ?? ""),
        childTexts: toArray<string>(w.childTexts).map(String),
        buttons: toArray<string>(w.buttons).map(String),
      };
      const role = classifyWindow(win);
      const message = win.childTexts.length ? win.childTexts.join("\n") : undefined;
      return { ...win, role, message };
    }),
  }));

  const blockers = processes
    .flatMap((p) => p.windows)
    .filter((w) => BLOCKING_ROLES.has(w.role))
    .sort((a, b) => severity(b.role) - severity(a.role));

  const running = processes.length > 0;
  const blocked = blockers.length > 0;

  return { running, processes, blocked, blockers, summary: buildSummary({ running, processes, blocked, blockers }) };
}

function buildSummary(d: Pick<DotaDiagnosis, "running" | "processes" | "blocked" | "blockers">): string {
  if (!d.running) return "dota2.exe is not running.";
  const lines: string[] = [];
  for (const p of d.processes) {
    const game = p.windows.find((w) => w.role === "game");
    lines.push(`pid ${p.pid}: ${p.memMB} MB RAM, ${p.cpu.toFixed(1)}s CPU${game ? `, game window ${game.width}x${game.height}${game.visible ? "" : " (not visible)"}` : ", no game window"}`);
  }
  if (!d.blocked) {
    lines.push("No blocking dialogs detected. ✅");
    return lines.join("\n");
  }
  lines.push("");
  lines.push(`⛔ BLOCKED by ${d.blockers.length} modal window(s) — the game thread is waiting for input:`);
  for (const b of d.blockers) {
    lines.push(`  • [${b.role}] "${b.title || b.className}"${b.visible ? "" : " (hidden behind the main window)"}`);
    if (b.message) lines.push(b.message.split("\n").map((l) => `      ${l}`).join("\n"));
    if (b.buttons.length) lines.push(`      buttons: ${b.buttons.map((x) => x.replace(/&/g, "")).join(" | ")}`);
  }
  lines.push("");
  lines.push("→ Dismiss with dota_dismiss_dialog (clicks a safe button like 'Ignore All Asserts'), then retry the capture.");
  return lines.join("\n");
}

/** One-line hint for appending to other tools' empty-capture errors, or "" when healthy. */
export async function dotaBlockerHint(): Promise<string> {
  try {
    const d = await diagnoseDota();
    if (!d.running || !d.blocked) return "";
    const b = d.blockers[0];
    const first = (b.message || "").split("\n").find((l) => /assert|map |using|error|stall|crash/i.test(l)) || b.title;
    return `\n⚠ Dota appears BLOCKED by a [${b.role}] dialog: "${b.title || b.className}"${b.visible ? "" : " (hidden behind the main window)"} — ${first}\n  Run dota_diagnose for details, or dota_dismiss_dialog to unblock it.`;
  } catch {
    return "";
  }
}

// --- Dismissal ---------------------------------------------------------------

// Preferred buttons, most→least desirable, for clearing an assert/dialog without derailing the
// engine. The denylist NEVER gets auto-clicked (those attach a debugger, send a minidump, copy
// text, or kill the process) — surfaced for a human/agent to choose explicitly.
const BUTTON_PREFERENCE = [
  "Ignore All Asserts",
  "Always Ignore This Assert",
  "Ignore This Assert",
  "Continue Logging Failures",
  "Ignore",
  "Continue",
  "Resume",
  "Keep Waiting",
  "Wait",
  "OK",
  "Yes",
  "Close",
];
const BUTTON_DENY = /break|debugger|select|minidump|copy|abort|terminate|kill|exit|quit|retry|cancel|no\b/i;

function norm(s: string): string {
  return s.replace(/&/g, "").trim();
}

/** Choose a safe button label from a dialog's buttons, or null if none is safe. */
export function pickSafeButton(buttons: string[]): string | null {
  const clean = buttons.map(norm).filter(Boolean);
  for (const pref of BUTTON_PREFERENCE) {
    const hit = clean.find((b) => b.toLowerCase() === pref.toLowerCase());
    if (hit) return hit;
  }
  for (const pref of BUTTON_PREFERENCE) {
    const hit = clean.find((b) => b.toLowerCase().includes(pref.toLowerCase()));
    if (hit) return hit;
  }
  const safe = clean.find((b) => !BUTTON_DENY.test(b));
  return safe ?? null;
}

export interface DismissResult {
  clicked?: string;
  hwnd?: string;
  error?: string;
}

const PS_CLICK = String.raw`param([string]$Hwnd, [string]$Label)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class Click {
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public static List<IntPtr> Kids(IntPtr p) { var res = new List<IntPtr>(); EnumChildWindows(p, (h, l) => { res.Add(h); return true; }, IntPtr.Zero); return res; }
  public static string Txt(IntPtr h) { var sb = new StringBuilder(256); GetWindowText(h, sb, 256); return sb.ToString(); }
  public static string Cls(IntPtr h) { var sb = new StringBuilder(128); GetClassName(h, sb, 128); return sb.ToString(); }
}
"@
$dlg = [IntPtr][int64]$Hwnd
$want = ($Label -replace '&', '').Trim().ToLower()
$target = [IntPtr]::Zero
foreach ($k in [Click]::Kids($dlg)) {
  if ([Click]::Cls($k) -match '(?i)button') {
    $t = ([Click]::Txt($k) -replace '&', '').Trim().ToLower()
    if ($t -eq $want) { $target = $k; break }
  }
}
if ($target -eq [IntPtr]::Zero) { Write-Output (ConvertTo-Json @{ error = "button not found: $Label" } -Compress); exit 0 }
$BM_CLICK = 0x00F5
[void][Click]::SendMessage($target, $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero)
Write-Output (ConvertTo-Json @{ clicked = $Label; hwnd = "$([int64]$target)" } -Compress)
`;

const PS_SHOT = String.raw`param([string]$Hwnd, [string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Shot {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
$h = [IntPtr][int64]$Hwnd
$r = New-Object Shot+RECT; [void][Shot]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L; $ht = $r.B - $r.T
if ($w -le 0 -or $ht -le 0) { throw 'bad size' }
$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc(); [void][Shot]::PrintWindow($h, $hdc, 2); $g.ReleaseHdc($hdc)
$g.Dispose(); $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
`;

/** PrintWindow-capture a window (renders even when hidden/occluded) to a PNG buffer. */
export async function captureDialogPng(hwnd: string): Promise<Buffer | undefined> {
  if (process.platform !== "win32") return undefined;
  const dir = await mkdtemp(join(tmpdir(), "d2dshot-"));
  const ps1 = join(dir, "shot.ps1");
  const out = join(dir, "shot.png");
  try {
    await writeFile(ps1, PS_SHOT, "utf8");
    await run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, hwnd, out], { timeoutMs: 15_000 });
    return await readFile(out).catch(() => undefined);
  } catch {
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Click a button (by exact label, ampersands ignored) on a dialog window via BM_CLICK. */
export async function clickDialogButton(dialogHwnd: string, label: string): Promise<DismissResult> {
  if (process.platform !== "win32") return { error: "Windows-only." };
  const dir = await mkdtemp(join(tmpdir(), "d2click-"));
  const ps1 = join(dir, "click.ps1");
  try {
    await writeFile(ps1, PS_CLICK, "utf8");
    const res = await run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, dialogHwnd, label], { timeoutMs: 15_000 });
    const m = res.stdout.match(/\{[^}]*\}/);
    if (!m) return { error: `no result from click (${(res.stderr || res.stdout).slice(-200)})` };
    return JSON.parse(m[0]) as DismissResult;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
