// OS-level window capture fallback for screenshots (Windows). Uses PrintWindow with
// PW_RENDERFULLCONTENT to grab the dota2 main window even when it's not focused.
// Note: hardware-accelerated 3D viewports may come back black via PrintWindow; the
// in-game `jpeg` console command (the primary path) is preferred when a game is rendering.

import { writeFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./process.js";

const PS_SCRIPT = `param([string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinCap {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
}
"@
$p = Get-Process dota2 -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { throw 'no dota2 window' }
$h = $p.MainWindowHandle
$r = New-Object WinCap+RECT
[void][WinCap]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
if ($w -le 0 -or $ht -le 0) { throw 'bad window size' }
$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][WinCap]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc); $g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
`;

/** Capture the dota2 main window as a PNG buffer, or undefined if it can't. */
export async function captureDotaWindowPng(): Promise<Buffer | undefined> {
  if (process.platform !== "win32") return undefined;
  const dir = await mkdtemp(join(tmpdir(), "d2shot-"));
  const ps1 = join(dir, "cap.ps1");
  const out = join(dir, "shot.png");
  try {
    await writeFile(ps1, PS_SCRIPT, "utf8");
    await run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, out], { timeoutMs: 20_000 });
    return await readFile(out);
  } catch {
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
