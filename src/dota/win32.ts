// Windows window-control + input-injection engine. A single batched PowerShell
// invocation drives the dota2 window: focus/move/show plus a whole sequence of
// mouse/keyboard input actions in one process launch (one Add-Type compile per
// call) so self-test click sequences run fast.
//
// Coordinates default to CLIENT-relative (relative to the dota2 render area's
// top-left), converted to screen space via ClientToScreen so they line up with
// what you see in a screenshot. Pass screen:true for absolute desktop coords, or
// nx/ny in [0,1] for a fraction of the client area.
//
// This is the OS-level path (works for menus, the in-game world, the console, the
// HUD). For deterministic game-logic control prefer the VConsole/DebugSDK path.

import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./process.js";

export type Button = "left" | "right" | "middle";

export type InputAction =
  | { type: "move"; x?: number; y?: number; nx?: number; ny?: number }
  | { type: "click"; x?: number; y?: number; nx?: number; ny?: number; button?: Button; double?: boolean; count?: number }
  | { type: "down"; x?: number; y?: number; nx?: number; ny?: number; button?: Button }
  | { type: "up"; x?: number; y?: number; nx?: number; ny?: number; button?: Button }
  | { type: "drag"; from: { x?: number; y?: number; nx?: number; ny?: number }; to: { x?: number; y?: number; nx?: number; ny?: number }; button?: Button; steps?: number }
  | { type: "scroll"; amount: number; x?: number; y?: number; nx?: number; ny?: number }
  | { type: "key"; key: string } // SendKeys syntax, e.g. "{ENTER}", "{ESC}", "^a"
  | { type: "text"; text: string } // literal text (escaped for SendKeys)
  | { type: "sleep"; ms: number };

export type WindowAction =
  | "info"
  | "focus"
  | "unfocus"
  | "minimize"
  | "restore"
  | "maximize"
  | "show"
  | "hide"
  | "move";

export interface Win32Spec {
  /** Bring dota2 to the foreground before doing anything (default true when there are input actions). */
  focus?: boolean;
  /** A window-management action. */
  window?: { action: WindowAction; x?: number; y?: number; w?: number; h?: number };
  /** A sequence of input actions, executed in order. */
  actions?: InputAction[];
}

export interface Win32Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface Win32Result {
  ok: boolean;
  error?: string;
  handle?: string;
  pid?: number;
  foreground?: boolean;
  minimized?: boolean;
  window?: Win32Rect; // outer window rect (screen coords)
  client?: Win32Rect; // client area size + screen-space top-left
  performed?: string[];
}

// Escape a literal string for WScript.Shell SendKeys. The metacharacters
// + ^ % ~ ( ) { } [ ] must be wrapped in braces to be sent literally.
export function escapeSendKeys(s: string): string {
  return s.replace(/[+^%~(){}\[\]]/g, (c) => `{${c}}`);
}

const PS_ENGINE = String.raw`param([string]$SpecPath)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class W32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  // Fallback finder: the process MainWindowHandle can be 0 when the game is minimized
  // or in fullscreen. Enumerate top-level windows owned by the pid (ignoring the visible
  // flag, so a minimized window still resolves) and pick the "Dota 2" window, else the
  // largest reasonable one.
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
[void][W32]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms

$MOVE=0x0001; $LDOWN=0x0002; $LUP=0x0004; $RDOWN=0x0008; $RUP=0x0010; $MDOWN=0x0020; $MUP=0x0040; $WHEEL=0x0800
$SW_HIDE=0; $SW_MAXIMIZE=3; $SW_SHOW=5; $SW_MINIMIZE=6; $SW_RESTORE=9
$HWND_TOP=[IntPtr]::Zero; $HWND_BOTTOM=[IntPtr]1
$SWP_NOSIZE=0x0001; $SWP_NOMOVE=0x0002; $SWP_NOACTIVATE=0x0010; $SWP_SHOWWINDOW=0x0040

$spec = Get-Content -Raw -Path $SpecPath -Encoding UTF8 | ConvertFrom-Json
$performed = New-Object System.Collections.ArrayList

function Emit($obj) { $obj | ConvertTo-Json -Compress -Depth 6 }

$p = Get-Process dota2 -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) { Emit @{ ok = $false; error = 'dota2.exe is not running' }; exit 0 }
$h = $p.MainWindowHandle
if ($h -eq 0 -or $h -eq [IntPtr]::Zero) { $h = [W32]::FindByPid([uint32]$p.Id) }
if ($h -eq 0 -or $h -eq [IntPtr]::Zero) { Emit @{ ok = $false; error = 'dota2 is running but has no visible window (minimized, or exclusive fullscreen)' }; exit 0 }

function Get-Rects {
  $wr = New-Object W32+RECT; [void][W32]::GetWindowRect($h, [ref]$wr)
  $cr = New-Object W32+RECT; [void][W32]::GetClientRect($h, [ref]$cr)
  $o = New-Object W32+POINT; $o.X = 0; $o.Y = 0; [void][W32]::ClientToScreen($h, [ref]$o)
  return @{
    window = @{ left=$wr.Left; top=$wr.Top; right=$wr.Right; bottom=$wr.Bottom; width=($wr.Right-$wr.Left); height=($wr.Bottom-$wr.Top) }
    client = @{ left=$o.X; top=$o.Y; right=($o.X + ($cr.Right-$cr.Left)); bottom=($o.Y + ($cr.Bottom-$cr.Top)); width=($cr.Right-$cr.Left); height=($cr.Bottom-$cr.Top) }
  }
}

function Force-Foreground {
  if ([W32]::IsIconic($h)) { [void][W32]::ShowWindow($h, $SW_RESTORE) }
  $fg = [W32]::GetForegroundWindow()
  $tFg = [W32]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
  $tCur = [W32]::GetCurrentThreadId()
  [void][W32]::AttachThreadInput($tCur, $tFg, $true)
  [void][W32]::BringWindowToTop($h)
  [void][W32]::SetForegroundWindow($h)
  [void][W32]::ShowWindow($h, $SW_SHOW)
  [void][W32]::AttachThreadInput($tCur, $tFg, $false)
  Start-Sleep -Milliseconds 120
}

# Resolve an action point to absolute screen coords (client-relative by default).
function Resolve-Point($a) {
  $rects = Get-Rects
  $cw = $rects.client.width; $ch = $rects.client.height
  if ($a.PSObject.Properties.Name -contains 'nx' -and $a.nx -ne $null) {
    $cx = [int]([math]::Round($a.nx * $cw)); $cy = [int]([math]::Round($a.ny * $ch))
  } else {
    $cx = [int]$a.x; $cy = [int]$a.y
  }
  if ($a.PSObject.Properties.Name -contains 'screen' -and $a.screen) {
    return @{ X = $cx; Y = $cy }
  }
  $pt = New-Object W32+POINT; $pt.X = $cx; $pt.Y = $cy
  [void][W32]::ClientToScreen($h, [ref]$pt)
  return @{ X = $pt.X; Y = $pt.Y }
}

function Btn-Flags($b) {
  switch ($b) {
    'right'  { return @($RDOWN, $RUP) }
    'middle' { return @($MDOWN, $MUP) }
    default  { return @($LDOWN, $LUP) }
  }
}

# Window management.
$doFocus = $true
if ($spec.PSObject.Properties.Name -contains 'focus' -and $spec.focus -ne $null) { $doFocus = [bool]$spec.focus }

if ($spec.PSObject.Properties.Name -contains 'window' -and $spec.window -ne $null) {
  $act = $spec.window.action
  switch ($act) {
    'focus'    { Force-Foreground; [void]$performed.Add('focus') }
    'unfocus'  { [void][W32]::SetWindowPos($h, $HWND_BOTTOM, 0,0,0,0, ($SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE)); [void]$performed.Add('unfocus (sent to back)') }
    'minimize' { [void][W32]::ShowWindow($h, $SW_MINIMIZE); [void]$performed.Add('minimize') }
    'restore'  { [void][W32]::ShowWindow($h, $SW_RESTORE); [void]$performed.Add('restore') }
    'maximize' { [void][W32]::ShowWindow($h, $SW_MAXIMIZE); [void]$performed.Add('maximize') }
    'show'     { [void][W32]::ShowWindow($h, $SW_SHOW); [void]$performed.Add('show') }
    'hide'     { [void][W32]::ShowWindow($h, $SW_HIDE); [void]$performed.Add('hide') }
    'move'     {
      $x = [int]$spec.window.x; $y = [int]$spec.window.y; $w = [int]$spec.window.w; $hh = [int]$spec.window.h
      $flags = $SWP_NOACTIVATE -bor $SWP_SHOWWINDOW
      if ($w -le 0 -or $hh -le 0) { $flags = $flags -bor $SWP_NOSIZE }
      [void][W32]::ShowWindow($h, $SW_RESTORE)
      [void][W32]::SetWindowPos($h, $HWND_TOP, $x, $y, $w, $hh, $flags)
      [void]$performed.Add("move ($x,$y $($w)x$($hh))")
    }
    'info'     { [void]$performed.Add('info') }
  }
}

# Input actions.
$hasActions = ($spec.PSObject.Properties.Name -contains 'actions' -and $spec.actions -ne $null -and $spec.actions.Count -gt 0)
if ($hasActions) {
  if ($doFocus) { Force-Foreground }
  foreach ($a in $spec.actions) {
    switch ($a.type) {
      'move' {
        $pt = Resolve-Point $a; [void][W32]::SetCursorPos($pt.X, $pt.Y); [void]$performed.Add("move->($($pt.X),$($pt.Y))")
      }
      'click' {
        $pt = Resolve-Point $a; [void][W32]::SetCursorPos($pt.X, $pt.Y); Start-Sleep -Milliseconds 20
        $f = Btn-Flags $a.button
        $n = 1; if ($a.PSObject.Properties.Name -contains 'count' -and $a.count) { $n = [int]$a.count }
        if ($a.PSObject.Properties.Name -contains 'double' -and $a.double) { $n = 2 }
        for ($i=0; $i -lt $n; $i++) {
          [W32]::mouse_event($f[0],0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 15
          [W32]::mouse_event($f[1],0,0,0,[UIntPtr]::Zero)
          if ($i -lt $n-1) { Start-Sleep -Milliseconds 60 }
        }
        [void]$performed.Add("click $($a.button) x$n @($($pt.X),$($pt.Y))")
      }
      'down' {
        $pt = Resolve-Point $a; [void][W32]::SetCursorPos($pt.X, $pt.Y); Start-Sleep -Milliseconds 20
        $f = Btn-Flags $a.button; [W32]::mouse_event($f[0],0,0,0,[UIntPtr]::Zero); [void]$performed.Add("down $($a.button)")
      }
      'up' {
        $pt = Resolve-Point $a; [void][W32]::SetCursorPos($pt.X, $pt.Y); Start-Sleep -Milliseconds 20
        $f = Btn-Flags $a.button; [W32]::mouse_event($f[1],0,0,0,[UIntPtr]::Zero); [void]$performed.Add("up $($a.button)")
      }
      'drag' {
        $from = Resolve-Point $a.from; $to = Resolve-Point $a.to
        $steps = 20; if ($a.PSObject.Properties.Name -contains 'steps' -and $a.steps) { $steps = [int]$a.steps }
        $f = Btn-Flags $a.button
        [void][W32]::SetCursorPos($from.X, $from.Y); Start-Sleep -Milliseconds 30
        [W32]::mouse_event($f[0],0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 30
        for ($i=1; $i -le $steps; $i++) {
          $ix = [int]($from.X + ($to.X - $from.X) * $i / $steps)
          $iy = [int]($from.Y + ($to.Y - $from.Y) * $i / $steps)
          [void][W32]::SetCursorPos($ix, $iy); Start-Sleep -Milliseconds 8
        }
        [W32]::mouse_event($f[1],0,0,0,[UIntPtr]::Zero); [void]$performed.Add("drag")
      }
      'scroll' {
        if ($a.PSObject.Properties.Name -contains 'x' -or $a.PSObject.Properties.Name -contains 'nx') { $pt = Resolve-Point $a; [void][W32]::SetCursorPos($pt.X, $pt.Y) }
        # WHEEL data is a SIGNED delta packed in a DWORD; a checked [uint32] cast throws on
        # negatives (scroll down). Convert via 2's-complement bytes so down-scroll works.
        $wd = [int]$a.amount * 120
        $data = [System.BitConverter]::ToUInt32([System.BitConverter]::GetBytes([int]$wd), 0)
        [W32]::mouse_event($WHEEL,0,0,$data,[UIntPtr]::Zero); [void]$performed.Add("scroll $($a.amount)")
      }
      'key'  { [System.Windows.Forms.SendKeys]::SendWait([string]$a.key); [void]$performed.Add("key $($a.key)") }
      'text' { [System.Windows.Forms.SendKeys]::SendWait([string]$a.text); [void]$performed.Add("text ($(([string]$a.text).Length) chars)") }
      'sleep' { Start-Sleep -Milliseconds ([int]$a.ms); [void]$performed.Add("sleep $($a.ms)ms") }
    }
    Start-Sleep -Milliseconds 12
  }
}

$r = Get-Rects
$fgNow = ([W32]::GetForegroundWindow() -eq $h)
Emit @{
  ok = $true
  handle = ('0x{0:X}' -f [int64]$h)
  pid = $p.Id
  foreground = $fgNow
  minimized = [W32]::IsIconic($h)
  window = $r.window
  client = $r.client
  performed = @($performed.ToArray())
}
`;

/** Run a window/input spec against the dota2 window via one PowerShell invocation. */
export async function runWin32Spec(spec: Win32Spec, timeoutMs = 30_000): Promise<Win32Result> {
  if (process.platform !== "win32") {
    return { ok: false, error: "Window/input control is only supported on Windows." };
  }
  const dir = await mkdtemp(join(tmpdir(), "d2win-"));
  const psPath = join(dir, "engine.ps1");
  const specPath = join(dir, "spec.json");
  try {
    await writeFile(psPath, PS_ENGINE, "utf8");
    await writeFile(specPath, JSON.stringify(spec), "utf8");
    const res = await run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psPath, specPath], { timeoutMs });
    const out = res.stdout.trim();
    const jsonStart = out.indexOf("{");
    if (jsonStart < 0) {
      return { ok: false, error: `No result from window engine. ${res.stderr.slice(-400) || out.slice(-400)}`.trim() };
    }
    try {
      return JSON.parse(out.slice(jsonStart)) as Win32Result;
    } catch {
      return { ok: false, error: `Could not parse window engine output: ${out.slice(0, 400)}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Is the dota2 window present? Returns its geometry/state, or ok:false. */
export async function dotaWindowInfo(): Promise<Win32Result> {
  return runWin32Spec({ focus: false, window: { action: "info" } });
}
