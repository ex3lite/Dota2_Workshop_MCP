// dota_diagnose / dota_dismiss_dialog — detect and clear the hidden modal dialogs that hang the
// Source 2 tools (engine asserts, watchdog "Stall Detected", crash dialogs). These spawn separate
// top-level windows, often BEHIND the main game window, and block the main thread — so every
// screenshot/record silently returns empty. dota_diagnose enumerates ALL of the process's windows,
// reads the assert text, and flags the blocker; dota_dismiss_dialog clicks a safe button to unblock.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { diagnoseDota, captureDialogPng, clickDialogButton, pickSafeButton } from "../dota/diagnose.js";
import { json, error, guard, ToolResult, ContentItem } from "../util/result.js";

export function registerDiagnoseTools(server: McpServer) {
  server.registerTool(
    "dota_diagnose",
    {
      title: "Detect stuck / blocking Dota dialogs (asserts, stalls, crashes)",
      description:
        "Check whether the running Dota 2 / Source 2 tools are STUCK on a hidden modal dialog. When the engine " +
        "hits an assert, a watchdog 'Stall Detected', or a crash, it pops a SEPARATE top-level window — often " +
        "hidden behind the main window — and blocks the main thread, so screenshots/recordings come back empty " +
        "with no explanation. This enumerates ALL of the process's top-level windows (not just the main one), " +
        "classifies them (game/assert/stall/crash/dialog/tools/noise), reads the assert message text, and reports " +
        "process health (RAM/CPU). Run this whenever a capture is empty or the game seems hung. " +
        "Use dota_dismiss_dialog to clear a blocker.",
      inputSchema: {
        capture: z.boolean().optional().describe("Also attach a PrintWindow screenshot of each blocking dialog (renders even when hidden). Default false."),
      },
    },
    guard(async ({ capture }): Promise<ToolResult> => {
      const d = await diagnoseDota();
      const content: ContentItem[] = [{ type: "text", text: d.summary }];
      if (capture && d.blockers.length) {
        for (const b of d.blockers) {
          const png = await captureDialogPng(b.hwnd);
          if (png) {
            content.push({ type: "text", text: `↓ [${b.role}] ${b.title || b.className}` });
            content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
          }
        }
      }
      return {
        content,
        structuredContent: {
          running: d.running,
          blocked: d.blocked,
          blockers: d.blockers.map((b) => ({ hwnd: b.hwnd, role: b.role, title: b.title, className: b.className, visible: b.visible, message: b.message, buttons: b.buttons.map((x) => x.replace(/&/g, "")) })),
          processes: d.processes.map((p) => ({ pid: p.pid, memMB: p.memMB, cpu: p.cpu, windows: p.windows.map((w) => ({ role: w.role, className: w.className, title: w.title, visible: w.visible, width: w.width, height: w.height })) })),
        },
      };
    }),
  );

  server.registerTool(
    "dota_dismiss_dialog",
    {
      title: "Dismiss a blocking Dota dialog (unblock the game thread)",
      description:
        "Clear a modal dialog detected by dota_diagnose so the engine can continue. Clicks a SAFE button via " +
        "BM_CLICK (no focus needed) — preferring, for asserts, 'Ignore All Asserts' > 'Ignore This Assert' > " +
        "'Continue Logging Failures'. It NEVER auto-clicks dangerous buttons (Break in Debugger, Broadcast " +
        "Minidump, Abort/Kill); to use one of those, pass its exact label in `button`. By default it dismisses " +
        "the single most-severe blocker; set all=true to clear every blocking dialog.",
      inputSchema: {
        hwnd: z.string().optional().describe("Target a specific dialog window by hwnd (from dota_diagnose). Default: the most-severe blocker."),
        button: z.string().optional().describe("Exact button label to click (ampersands ignored). Default: an auto-picked safe button."),
        all: z.boolean().optional().describe("Dismiss every blocking dialog, not just one. Default false."),
      },
    },
    guard(async ({ hwnd, button, all }): Promise<ToolResult> => {
      const d = await diagnoseDota();
      if (!d.running) return error("dota2.exe is not running — nothing to dismiss.");
      if (!d.blocked) return json({ blocked: false }, "No blocking dialogs detected. ✅ Nothing to dismiss.");

      let targets = d.blockers;
      if (hwnd) {
        targets = d.blockers.filter((b) => b.hwnd === hwnd);
        if (!targets.length) return error(`No blocking dialog with hwnd ${hwnd}. Run dota_diagnose for current hwnds.`);
      } else if (!all) {
        targets = [d.blockers[0]];
      }

      const results: Array<{ hwnd: string; role: string; title: string; clicked?: string; error?: string }> = [];
      for (const t of targets) {
        const label = button ?? pickSafeButton(t.buttons);
        if (!label) {
          results.push({ hwnd: t.hwnd, role: t.role, title: t.title, error: `No safe button found. Available: ${t.buttons.map((x) => x.replace(/&/g, "")).join(" | ") || "(none)"}. Pass one explicitly via 'button'.` });
          continue;
        }
        const res = await clickDialogButton(t.hwnd, label);
        results.push({ hwnd: t.hwnd, role: t.role, title: t.title, clicked: res.clicked, error: res.error });
      }

      // Re-check so the caller knows whether the game actually unblocked.
      const after = await diagnoseDota();
      const lines = results.map((r) => (r.clicked ? `✓ [${r.role}] "${r.title}" → clicked "${r.clicked}"` : `✗ [${r.role}] "${r.title}" → ${r.error}`));
      lines.push("");
      lines.push(after.blocked ? `⚠ Still blocked by ${after.blockers.length} dialog(s) after dismissing.` : "✅ No blocking dialogs remain — game thread should resume.");
      if (after.processes[0]) lines.push(`pid ${after.processes[0].pid}: ${after.processes[0].memMB} MB RAM (rising RAM = map loading resumed).`);
      return json({ dismissed: results, stillBlocked: after.blocked, remaining: after.blockers.length }, lines.join("\n"));
    }),
  );
}
