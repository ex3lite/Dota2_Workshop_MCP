// OS-level window capture for the dota2 window (Windows). Two strategies:
//
//   "screen"  — Graphics.CopyFromScreen over the window's screen rect. Captures the
//               REAL displayed pixels, including the hardware-accelerated 3D viewport.
//               Requires the window to be visible/on top (we can focus it first), and
//               it grabs whatever is actually on screen in that rectangle.
//   "print"   — PrintWindow(PW_RENDERFULLCONTENT). Works even when the window is
//               occluded/background, but a GPU 3D viewport often comes back BLACK.
//
// The in-game `jpeg`/`screenshot` console command (driven from debug.tools) is the
// highest-fidelity path when a map is rendering; these OS captures are for the window
// itself (tools mode, menus, panorama) and as a fallback.

import { writeFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./process.js";

export type WindowCaptureMode = "screen" | "print";

export interface WindowCaptureResult {
  buf?: Buffer;
  mode: WindowCaptureMode;
  error?: string;
}

const PS_SCRIPT = String.raw`param([string]$Out, [string]$Mode, [string]$Focus)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinCap {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr Found; public static uint TargetPid; public static long FoundArea; public static bool FoundTitled;
  private static bool EnumCb(IntPtr h, IntPtr l) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    if (pid != TargetPid) return true;
    RECT r; GetWindowRect(h, out r);
    int w = r.Right - r.Left, ht = r.Bottom - r.Top;
    if (w <= 100 || ht <= 100) return true;
    var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
    bool titled = sb.ToString() == "Dota 2";
    long area = (long)w * ht;
    if ((titled && !FoundTitled) || (titled == FoundTitled && area > FoundArea)) { Found = h; FoundArea = area; FoundTitled = titled; }
    return true;
  }
  public static IntPtr FindByPid(uint pid) { TargetPid = pid; Found = IntPtr.Zero; FoundArea = 0; FoundTitled = false; EnumWindows(new EnumWindowsProc(EnumCb), IntPtr.Zero); return Found; }
}
"@
[void][WinCap]::SetProcessDPIAware()
$p = Get-Process dota2 -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) { throw 'dota2.exe is not running' }
$h = $p.MainWindowHandle
if ($h -eq 0 -or $h -eq [IntPtr]::Zero) { $h = [WinCap]::FindByPid([uint32]$p.Id) }
if ($h -eq 0 -or $h -eq [IntPtr]::Zero) { throw 'dota2 has no visible window (minimized or exclusive fullscreen) — use the in-game render method' }
if ($Focus -eq 'true') {
  if ([WinCap]::IsIconic($h)) { [void][WinCap]::ShowWindow($h, 9) }
  $fg = [WinCap]::GetForegroundWindow()
  $tFg = [WinCap]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
  $tCur = [WinCap]::GetCurrentThreadId()
  [void][WinCap]::AttachThreadInput($tCur, $tFg, $true)
  [void][WinCap]::BringWindowToTop($h)
  [void][WinCap]::SetForegroundWindow($h)
  [void][WinCap]::ShowWindow($h, 5)
  [void][WinCap]::AttachThreadInput($tCur, $tFg, $false)
  Start-Sleep -Milliseconds 250
}
$r = New-Object WinCap+RECT
[void][WinCap]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
if ($w -le 0 -or $ht -le 0) { throw 'bad window size' }
$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
if ($Mode -eq 'print') {
  $hdc = $g.GetHdc()
  [void][WinCap]::PrintWindow($h, $hdc, 2)
  $g.ReleaseHdc($hdc)
} else {
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $ht)))
}
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
`;

/** Capture the dota2 window as a PNG buffer. */
export async function captureWindowPng(
  mode: WindowCaptureMode = "screen",
  focus = true,
): Promise<WindowCaptureResult> {
  if (process.platform !== "win32") return { mode, error: "Window capture is only supported on Windows." };
  const dir = await mkdtemp(join(tmpdir(), "d2shot-"));
  const ps1 = join(dir, "cap.ps1");
  const out = join(dir, "shot.png");
  try {
    await writeFile(ps1, PS_SCRIPT, "utf8");
    const res = await run(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, out, mode, focus ? "true" : "false"],
      { timeoutMs: 25_000 },
    );
    const buf = await readFile(out).catch(() => undefined);
    if (!buf || !buf.length) {
      return { mode, error: `Capture produced no image. ${res.stderr.slice(-300) || res.stdout.slice(-300)}`.trim() };
    }
    return { buf, mode };
  } catch (err) {
    return { mode, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Back-compat: a PNG buffer of the dota2 window, or undefined. Uses real-pixel screen capture. */
export async function captureDotaWindowPng(): Promise<Buffer | undefined> {
  const r = await captureWindowPng("screen", false);
  return r.buf;
}
