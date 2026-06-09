// Game control + self-test tools:
//   - dota_window / dota_focus_window — manage the dota2 window (focus, unfocus,
//     minimize, restore, move, geometry).
//   - dota_click / dota_type / dota_input — OS-level input injection (mouse + keyboard),
//     batched into a single fast PowerShell call. Coordinates are client-relative by
//     default so they line up with screenshots.
//   - dota_status — one-call health snapshot (process, window, VConsole, game state).
//   - dota_wait_for — block until a console line matches (sequencing self-tests).
//   - dota_selftest — orchestrated smoke test: (optionally) launch, run console/Lua
//     asserts, watch for errors, and screenshot — a single pass/fail report.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveProject } from "../config.js";
import { requireDotaPaths, resolveDotaPaths } from "../dota/paths.js";
import { getVConsole, defaultVconPort, ConsoleLine } from "../dota/vconsole.js";
import { runWin32Spec, dotaWindowInfo, escapeSendKeys, InputAction, Win32Spec, Button } from "../dota/win32.js";
import { captureWindowPng } from "../dota/capture.js";
import { restartGame } from "./debug.tools.js";
import { quoteLua } from "./debugsdk.tools.js";
import { json, image, error, guard, ToolResult } from "../util/result.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ERROR_RE =
  /(script error|stack traceback|attempt to (call|index|perform|concatenate)|assertion failed|lua runtime error|[^A-Za-z]Error:|\.lua:\d+:)/i;

function fmtWindow(r: { window?: any; client?: any; foreground?: boolean; minimized?: boolean; handle?: string; pid?: number }): string {
  if (!r.window) return "(no window geometry)";
  const w = r.window;
  const c = r.client;
  return [
    `window: ${w.width}x${w.height} at (${w.left},${w.top})  client: ${c?.width}x${c?.height} origin (${c?.left},${c?.top})`,
    `foreground: ${r.foreground}  minimized: ${r.minimized}  pid: ${r.pid}  handle: ${r.handle}`,
  ].join("\n");
}

export function registerControlTools(server: McpServer) {
  // ---- window management --------------------------------------------------
  server.registerTool(
    "dota_window",
    {
      title: "Manage the dota2 window",
      description:
        "Control the dota2 game window via the Win32 API: 'info' (geometry + foreground/minimized state), 'focus' " +
        "(bring to foreground — needed before reliable input/clicks), 'unfocus' (send to back), 'minimize', " +
        "'restore', 'maximize', 'show', 'hide', or 'move' (with x/y/w/h). Returns the window geometry afterwards.",
      inputSchema: {
        action: z.enum(["info", "focus", "unfocus", "minimize", "restore", "maximize", "show", "hide", "move"]),
        x: z.number().int().optional(),
        y: z.number().int().optional(),
        w: z.number().int().optional().describe("Width for 'move' (omit/0 keeps current size)."),
        h: z.number().int().optional().describe("Height for 'move' (omit/0 keeps current size)."),
      },
    },
    guard(async ({ action, x, y, w, h }): Promise<ToolResult> => {
      const r = await runWin32Spec({ focus: false, window: { action, x, y, w, h } });
      if (!r.ok) return error(r.error ?? "Window control failed.");
      return json(r as unknown as Record<string, unknown>, `${r.performed?.join(", ") || action}\n${fmtWindow(r)}`);
    }),
  );

  server.registerTool(
    "dota_focus_window",
    {
      title: "Focus / unfocus the game window",
      description:
        "Set or remove focus on the dota2 window. focus:true (default) brings it to the foreground and activates it " +
        "(uses the AttachThreadInput trick to beat the Windows foreground lock) — do this before clicking into the " +
        "game. focus:false sends it to the back without minimizing.",
      inputSchema: { focus: z.boolean().optional().describe("true = bring to foreground (default), false = send to back.") },
    },
    guard(async ({ focus }): Promise<ToolResult> => {
      const r = await runWin32Spec({ focus: false, window: { action: focus === false ? "unfocus" : "focus" } });
      if (!r.ok) return error(r.error ?? "Focus control failed.");
      return json(r as unknown as Record<string, unknown>, `${r.performed?.join(", ")}\nforeground now: ${r.foreground}`);
    }),
  );

  // ---- input injection ----------------------------------------------------
  const pointFields = {
    x: z.number().optional().describe("Client-relative X (px from the render area's left)."),
    y: z.number().optional().describe("Client-relative Y (px from the render area's top)."),
    nx: z.number().min(0).max(1).optional().describe("Normalized X in [0,1] of the client area (e.g. 0.5 = center)."),
    ny: z.number().min(0).max(1).optional().describe("Normalized Y in [0,1] of the client area."),
  };

  server.registerTool(
    "dota_click",
    {
      title: "Click in the game window",
      description:
        "Move the cursor and click inside the dota2 window. Coordinates are CLIENT-relative by default (matching what " +
        "you see in a 'window' screenshot); use nx/ny for a fraction of the client area. Focuses the window first " +
        "(focus:false to skip). Supports left/right/middle and double-click. Fast — one PowerShell call.",
      inputSchema: {
        ...pointFields,
        button: z.enum(["left", "right", "middle"]).optional(),
        double: z.boolean().optional().describe("Double-click."),
        focus: z.boolean().optional().describe("Focus the window first (default true)."),
      },
    },
    guard(async ({ x, y, nx, ny, button, double, focus }): Promise<ToolResult> => {
      const action: InputAction = { type: "click", x, y, nx, ny, button: button as Button, double };
      const r = await runWin32Spec({ focus: focus !== false, actions: [action] });
      if (!r.ok) return error(r.error ?? "Click failed.");
      return json(r as unknown as Record<string, unknown>, `${r.performed?.join(", ")}`);
    }),
  );

  server.registerTool(
    "dota_type",
    {
      title: "Type text / send keys",
      description:
        "Type literal text or send key chords into the focused dota2 window. With `text`, the string is sent " +
        "literally (auto-escaped). With `keys`, the string uses SendKeys syntax: {ENTER} {ESC} {TAB} {F5} {BACKSPACE}, " +
        "^a (Ctrl+A), %f (Alt+F), +x (Shift+X). Focuses the window first. Useful for chat/console commands typed into " +
        "the game and for menu navigation.",
      inputSchema: {
        text: z.string().optional().describe("Literal text to type (escaped for you)."),
        keys: z.string().optional().describe("SendKeys chord string, e.g. '{ENTER}' or '^a'."),
        focus: z.boolean().optional(),
      },
    },
    guard(async ({ text, keys, focus }): Promise<ToolResult> => {
      const actions: InputAction[] = [];
      if (text != null) actions.push({ type: "text", text: escapeSendKeys(text) });
      if (keys != null) actions.push({ type: "key", key: keys });
      if (!actions.length) return error("Provide `text` and/or `keys`.");
      const r = await runWin32Spec({ focus: focus !== false, actions });
      if (!r.ok) return error(r.error ?? "Type failed.");
      return json(r as unknown as Record<string, unknown>, `${r.performed?.join(", ")}`);
    }),
  );

  server.registerTool(
    "dota_input",
    {
      title: "Run an input sequence (batched)",
      description:
        "Run a whole mouse/keyboard sequence against the dota2 window in ONE fast PowerShell call — the way to script " +
        "a self-test interaction. Each action: {type} where type is move|click|down|up|drag|scroll|key|text|sleep. " +
        "Points use x/y (client-relative px) or nx/ny (0..1 fraction). Examples: " +
        '[{"type":"click","nx":0.5,"ny":0.9},{"type":"sleep","ms":300},{"type":"key","key":"{ESC}"}]. ' +
        "Drag uses {from:{x,y},to:{x,y}}. The window is focused first unless focus:false.",
      inputSchema: {
        actions: z
          .array(
            z.object({
              type: z.enum(["move", "click", "down", "up", "drag", "scroll", "key", "text", "sleep"]),
              x: z.number().optional(),
              y: z.number().optional(),
              nx: z.number().optional(),
              ny: z.number().optional(),
              button: z.enum(["left", "right", "middle"]).optional(),
              double: z.boolean().optional(),
              count: z.number().int().optional(),
              amount: z.number().optional().describe("Scroll notches (+ up / - down)."),
              from: z.object({ x: z.number().optional(), y: z.number().optional(), nx: z.number().optional(), ny: z.number().optional() }).optional(),
              to: z.object({ x: z.number().optional(), y: z.number().optional(), nx: z.number().optional(), ny: z.number().optional() }).optional(),
              steps: z.number().int().optional(),
              key: z.string().optional(),
              text: z.string().optional(),
              ms: z.number().int().optional(),
            }),
          )
          .min(1),
        focus: z.boolean().optional(),
      },
    },
    guard(async ({ actions, focus }): Promise<ToolResult> => {
      // Auto-escape literal text actions for SendKeys.
      const norm = actions.map((a) => (a.type === "text" && a.text != null ? { ...a, text: escapeSendKeys(a.text) } : a)) as InputAction[];
      const spec: Win32Spec = { focus: focus !== false, actions: norm };
      const r = await runWin32Spec(spec, 60_000);
      if (!r.ok) return error(r.error ?? "Input sequence failed.");
      return json(r as unknown as Record<string, unknown>, `ran ${norm.length} action(s):\n${r.performed?.join("\n")}`);
    }),
  );

  // ---- status -------------------------------------------------------------
  server.registerTool(
    "dota_status",
    {
      title: "Game/connection status snapshot",
      description:
        "One-call health check: whether the Dota install is found, whether dota2.exe has a window (+ geometry/focus), " +
        "and whether the VConsole channel is reachable (with the live game state if the DebugSDK is attached — it " +
        "sends mcp_state). Use this before driving the game.",
      inputSchema: { vconPort: z.number().int().min(1).max(65535).optional() },
    },
    guard(async ({ vconPort }): Promise<ToolResult> => {
      const dota = await resolveDotaPaths();
      const win = await dotaWindowInfo();
      const vc = getVConsole(vconPort);
      let vconConnected = vc.isConnected();
      if (!vconConnected) {
        try {
          await vc.connect(3000);
          vconConnected = true;
        } catch {
          /* not running in tools mode */
        }
      }
      let gameState: unknown;
      if (vconConnected) {
        const line = await (async () => {
          const p = vc.waitForLine((l) => l.text.includes("[MCP] STATE"), 2500);
          try {
            vc.send("mcp_state");
          } catch {
            return undefined;
          }
          return p;
        })();
        if (line) {
          const m = line.text.match(/\[MCP\] STATE (\{.*\})/);
          if (m) {
            try {
              gameState = JSON.parse(m[1]);
            } catch {
              /* ignore */
            }
          }
        }
      }
      const status = {
        install: dota ? { found: true, root: dota.root, source: dota.source } : { found: false },
        window: win.ok ? { present: true, ...win.window, foreground: win.foreground, minimized: win.minimized, pid: win.pid } : { present: false, reason: win.error },
        vconsole: { connected: vconConnected, port: vconPort ?? defaultVconPort() },
        debugSdk: gameState ? "attached" : vconConnected ? "not detected (mcp_state silent — attach the DebugSDK)" : "unknown (no VConsole)",
        gameState,
      };
      const summary = [
        `install: ${dota ? "found (" + dota.root + ")" : "NOT found (set DOTA2_PATH)"}`,
        `window: ${win.ok ? `${win.window?.width}x${win.window?.height}, foreground=${win.foreground}, minimized=${win.minimized}` : "not running"}`,
        `vconsole: ${vconConnected ? "connected" : "not reachable (launch in -tools mode)"} (port ${vconPort ?? defaultVconPort()})`,
        `debugSdk: ${status.debugSdk}`,
        gameState ? `state: ${JSON.stringify(gameState)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return json(status as Record<string, unknown>, summary);
    }),
  );

  // ---- wait-for -----------------------------------------------------------
  server.registerTool(
    "dota_wait_for",
    {
      title: "Wait for console output",
      description:
        "Block until a live console line matches `pattern` (substring or, with regex:true, a regular expression), or " +
        "until timeout. Optionally send a `command` first (e.g. to trigger the thing you're waiting on). Great for " +
        "sequencing self-tests: send an action, wait for its log line, then continue. Returns the matching line.",
      inputSchema: {
        pattern: z.string().describe("Substring (or regex with regex:true) to wait for."),
        regex: z.boolean().optional(),
        command: z.string().optional().describe("Console command to send before waiting."),
        timeoutMs: z.number().int().min(100).max(120000).optional().describe("Default 10000."),
        scanRecent: z.boolean().optional().describe("Also match an already-printed line in the buffer (default false)."),
        vconPort: z.number().int().min(1).max(65535).optional(),
      },
    },
    guard(async ({ pattern, regex, command, timeoutMs, scanRecent, vconPort }): Promise<ToolResult> => {
      const vc = getVConsole(vconPort);
      try {
        if (!vc.isConnected()) await vc.connect();
      } catch {
        return error("Could not reach VConsole. Launch the game in -tools mode first.");
      }
      const re = regex ? new RegExp(pattern) : undefined;
      const test = (l: ConsoleLine) => (re ? re.test(l.text) : l.text.includes(pattern));
      const waitP = vc.waitForLine(test, timeoutMs ?? 10000, scanRecent === true);
      if (command) {
        try {
          vc.send(command);
        } catch {
          return error("VConsole send failed (not connected).");
        }
      }
      const line = await waitP;
      if (!line) return error(`Timed out waiting for ${regex ? "/" + pattern + "/" : '"' + pattern + '"'} after ${timeoutMs ?? 10000}ms.`);
      return json({ matched: true, line: line.text, at: line.at }, `matched: ${line.text}`);
    }),
  );

  // ---- self-test ----------------------------------------------------------
  server.registerTool(
    "dota_selftest",
    {
      title: "Self-test the addon (smoke run)",
      description:
        "Run an automated smoke test against the game and return a single pass/fail report. Steps: optionally launch " +
        "the map (launch:true + map), connect VConsole, run each `commands` console command, evaluate each `asserts` " +
        "Lua boolean expression via the DebugSDK (mcp_assert → PASS/FAIL), watch the console for Lua/engine errors " +
        "over `errorWindowMs`, and take a final screenshot. Requires the DebugSDK attached for asserts " +
        "(addon_attach_debug_sdk).",
      inputSchema: {
        projectRoot: z.string().optional(),
        map: z.string().optional().describe("Map to (re)launch on when launch:true."),
        launch: z.boolean().optional().describe("Relaunch the game on `map` before testing (default false)."),
        commands: z.array(z.string()).optional().describe("Console commands to run (e.g. ['mcp_spawn npc_dota_creep_badguys 3'])."),
        asserts: z.array(z.string()).optional().describe("Lua boolean expressions checked via mcp_assert."),
        errorWindowMs: z.number().int().min(0).max(60000).optional().describe("Collect console output this long, then scan for errors (default 3000)."),
        screenshot: z.boolean().optional().describe("Capture a final screenshot (default true)."),
        vconPort: z.number().int().min(1).max(65535).optional(),
      },
    },
    guard(async ({ projectRoot, map, launch, commands, asserts, errorWindowMs, screenshot, vconPort }): Promise<ToolResult> => {
      const steps: { step: string; ok: boolean; detail?: string }[] = [];
      const port = vconPort ?? defaultVconPort();
      const project = await resolveProject(projectRoot);

      // 1) Launch if requested.
      if (launch) {
        if (!map) return error("launch:true needs a `map` to relaunch on.");
        const dota = await requireDotaPaths();
        const r = await restartGame(dota, project.addonName, map, port, true, true);
        steps.push({ step: `launch ${map}`, ok: r.reconnected, detail: `pid ${r.pid}, reconnected ${r.reconnected}` });
      }

      // 2) Connect.
      const vc = getVConsole(port);
      try {
        if (!vc.isConnected()) await vc.connectWithRetry(launch ? 60000 : 8000, 1000);
        steps.push({ step: "vconsole connect", ok: true });
      } catch {
        steps.push({ step: "vconsole connect", ok: false, detail: "not reachable (launch in -tools mode)" });
        return finish(steps, [], undefined);
      }

      // 3) DebugSDK ping (informational).
      {
        const pong = vc.waitForLine((l) => l.text.includes("[MCP] PONG"), 1500);
        try {
          vc.send("mcp_ping");
        } catch {
          /* ignore */
        }
        const got = await pong;
        steps.push({ step: "DebugSDK ping", ok: !!got, detail: got ? got.text : "no PONG — asserts need the DebugSDK attached" });
      }

      // 4) Commands.
      for (const cmd of commands ?? []) {
        const out = await vc.sendAndCapture(cmd, `MCP_SELFTEST_${steps.length}`, 2000);
        const errored = out.some((l) => ERROR_RE.test(l.text));
        steps.push({ step: `cmd: ${cmd}`, ok: !errored, detail: out.slice(0, 3).map((l) => l.text).join(" | ") });
      }

      // 5) Asserts via mcp_assert.
      for (const expr of asserts ?? []) {
        // Send as ONE quoted token (like dota_lua_eval) so multi-token/quoted/multiline
        // asserts survive the console; match on the same normalized form the SDK echoes.
        const norm = expr.replace(/\r?\n/g, " ").replace(/"/g, "'");
        const want = vc.waitForLine((l) => l.text.includes("[MCP] ASSERT") && l.text.includes(norm.slice(0, 40)), 4000);
        try {
          vc.send(`mcp_assert ${quoteLua(expr)}`);
        } catch {
          /* ignore */
        }
        const line = await want;
        const pass = !!line && /\[MCP\] ASSERT PASS/.test(line.text);
        steps.push({ step: `assert: ${expr}`, ok: pass, detail: line?.text ?? "no response from DebugSDK" });
      }

      // 6) Error watch.
      vc.clearRing();
      const win = errorWindowMs ?? 3000;
      if (win > 0) await sleep(win);
      const errors = vc.recent(1000).filter((l) => ERROR_RE.test(l.text)).map((l) => l.text);
      steps.push({ step: `error watch (${win}ms)`, ok: errors.length === 0, detail: errors.length ? `${errors.length} error line(s)` : "clean" });

      // 7) Screenshot.
      let shot: { buf: Buffer } | undefined;
      if (screenshot !== false) {
        const cap = await captureWindowPng("screen", true);
        if (cap.buf) shot = { buf: cap.buf };
        steps.push({ step: "screenshot", ok: !!cap.buf, detail: cap.buf ? `${Math.round(cap.buf.length / 1024)} KB` : cap.error });
      }

      return finish(steps, errors, shot);

      function finish(
        s: { step: string; ok: boolean; detail?: string }[],
        errs: string[],
        screen: { buf: Buffer } | undefined,
      ): ToolResult {
        const passed = s.filter((x) => x.ok).length;
        const failed = s.length - passed;
        const report =
          `SELF-TEST: ${passed} passed, ${failed} failed\n` +
          s.map((x) => `  ${x.ok ? "PASS" : "FAIL"}  ${x.step}${x.detail ? "  — " + x.detail : ""}`).join("\n") +
          (errs.length ? `\n\nERRORS:\n${errs.join("\n")}` : "");
        const data = { passed, failed, steps: s, errors: errs };
        if (screen) {
          return {
            content: [
              { type: "text", text: report },
              { type: "image", data: screen.buf.toString("base64"), mimeType: "image/png" },
            ],
            structuredContent: data,
            isError: failed > 0,
          };
        }
        return { ...json(data, report), isError: failed > 0 };
      }
    }),
  );
}
