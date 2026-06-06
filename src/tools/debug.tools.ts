import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveProject } from "../config.js";
import { requireDotaPaths, DotaPaths } from "../dota/paths.js";
import { getVConsole, defaultVconPort, ConsoleLine } from "../dota/vconsole.js";
import { buildLaunchArgs } from "../dota/launch.js";
import { run, spawnDetached, killProcess, npmCommand } from "../dota/process.js";
import { ensureDir } from "../util/fsx.js";
import { captureDotaWindowPng } from "../dota/capture.js";
import { json, text, image, error, guard, ToolResult } from "../util/result.js";

let sentinelCounter = 0;
function nextSentinel(): string {
  return `MCP_SENTINEL_${++sentinelCounter}`;
}

function formatLines(lines: { text: string }[]): string {
  return lines.map((l) => l.text).join("\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Patterns that indicate a Lua/engine error in console output.
const ERROR_RE =
  /(script error|stack traceback|attempt to (call|index|perform|concatenate)|assertion failed|lua runtime error|[^A-Za-z]Error:|\.lua:\d+:)/i;

function findErrors(lines: ConsoleLine[]): string[] {
  return lines.filter((l) => ERROR_RE.test(l.text)).map((l) => l.text);
}

const VCON_HINT =
  "Could not reach the VConsole channel. Launch the game in tools mode first (addon_launch_custom_game), " +
  "and make sure it was started with -tools (and matching -vconport if you overrode it).";

/** Full relaunch helper shared by dota_restart_game and dota_dev_cycle. */
async function restartGame(
  dota: DotaPaths,
  addon: string,
  map: string,
  port: number,
  cheats: boolean,
  reconnect: boolean,
): Promise<{ pid?: number; command: string; killed: boolean; reconnected: boolean }> {
  const args = buildLaunchArgs({ addon, map, insecure: true, dev: true, cheats, vconPort: port });
  const command = `"${dota.dota2Exe}" ${args.join(" ")}`;
  getVConsole(port).disconnect();
  const kill = await killProcess("dota2.exe");
  await sleep(1500); // let the OS release file locks
  const { pid } = spawnDetached(dota.dota2Exe, args, dota.binWin64);
  let reconnected = false;
  if (reconnect) {
    try {
      await getVConsole(port).connectWithRetry(60_000, 1000);
      reconnected = true;
    } catch {
      /* still loading */
    }
  }
  return { pid, command, killed: kill.code === 0, reconnected };
}

export function registerDebugTools(server: McpServer) {
  server.registerTool(
    "dota_send_console_command",
    {
      title: "Send a console command",
      description:
        "Send a command to the RUNNING Dota 2 client over the VConsole2 channel (the reliable Windows path; " +
        "-netconport telnet is broken on Windows). Captures and returns the console output the command produced.",
      inputSchema: {
        command: z.string().describe("Console command, e.g. 'script_reload', 'dump_entities', 'sv_cheats 1'."),
        vconPort: z.number().int().min(1).max(65535).optional(),
        waitMs: z.number().int().optional().describe("How long to collect output (default 2000ms)."),
      },
    },
    guard(async ({ command, vconPort, waitMs }): Promise<ToolResult> => {
      const vc = getVConsole(vconPort);
      try {
        if (!vc.isConnected()) await vc.connect();
      } catch {
        return error(VCON_HINT);
      }
      const lines = await vc.sendAndCapture(command, nextSentinel(), waitMs ?? 2000);
      return json(
        { command, lineCount: lines.length, output: lines.map((l) => l.text) },
        `$ ${command}\n${formatLines(lines) || "(no output captured)"}`,
      );
    }),
  );

  server.registerTool(
    "dota_read_console_log",
    {
      title: "Read live console output",
      description:
        "Return recent console output captured live from the VConsole2 PRNT stream (console.log on disk is buffered " +
        "until the client exits, so it is not used). Optionally filter with a substring.",
      inputSchema: {
        limit: z.number().int().positive().max(2000).optional().describe("Max lines (default 200)."),
        grep: z.string().optional().describe("Only lines containing this substring."),
        vconPort: z.number().int().min(1).max(65535).optional(),
      },
    },
    guard(async ({ limit, grep, vconPort }): Promise<ToolResult> => {
      const vc = getVConsole(vconPort);
      try {
        if (!vc.isConnected()) await vc.connect();
      } catch {
        return error(VCON_HINT);
      }
      let lines = vc.recent(limit ?? 200);
      if (grep) lines = lines.filter((l) => l.text.includes(grep));
      return json({ count: lines.length, lines: lines.map((l) => l.text) }, formatLines(lines) || "(console buffer empty)");
    }),
  );

  server.registerTool(
    "dota_reload_scripts",
    {
      title: "Hot-reload vscripts",
      description:
        "Reload server-side Lua scripts live via the console `script_reload` (no relaunch). Optionally compile first. " +
        "Works for function-body edits; new files / changed class structure / KV files need dota_restart_game.",
      inputSchema: {
        projectRoot: z.string().optional(),
        build: z.boolean().optional().describe("Run `npm run build` before reloading (default true for TS templates)."),
        vconPort: z.number().int().min(1).max(65535).optional(),
      },
    },
    guard(async ({ projectRoot, build, vconPort }): Promise<ToolResult> => {
      const out: string[] = [];
      const project = await resolveProject(projectRoot);
      const shouldBuild = build ?? project.hasTstl;
      if (shouldBuild && project.hasTstl) {
        const res = await run(npmCommand(), ["run", "build"], { cwd: project.root, timeoutMs: 600_000 });
        out.push(`build: ${res.code === 0 ? "OK" : "FAILED (exit " + res.code + ")"}`);
        if (res.code !== 0) {
          return error(`Build failed — not reloading.\n${res.stdout}\n${res.stderr}`.trim());
        }
      }
      const vc = getVConsole(vconPort);
      try {
        if (!vc.isConnected()) await vc.connect();
      } catch {
        return error(VCON_HINT);
      }
      const lines = await vc.sendAndCapture("script_reload", nextSentinel(), 2500);
      out.push("sent: script_reload");
      return json({ steps: out, output: lines.map((l) => l.text) }, `${out.join("\n")}\n\n${formatLines(lines)}`.trim());
    }),
  );

  server.registerTool(
    "dota_restart_game",
    {
      title: "Restart the game",
      description:
        "Full relaunch for changes that can't hot-reload (KV files, new/removed scripts, structural changes): " +
        "kills dota2.exe (releases file locks), relaunches tools mode on the map, and reconnects VConsole.",
      inputSchema: {
        projectRoot: z.string().optional(),
        addon: z.string().optional(),
        map: z.string().describe("Map to launch."),
        vconPort: z.number().int().min(1).max(65535).optional(),
        cheats: z.boolean().optional(),
        reconnect: z.boolean().optional().describe("Wait and reconnect VConsole after relaunch (default true)."),
        dryRun: z.boolean().optional(),
      },
    },
    guard(async ({ projectRoot, addon, map, vconPort, cheats, reconnect, dryRun }): Promise<ToolResult> => {
      const dota = await requireDotaPaths();
      const name = addon ?? (await resolveProject(projectRoot)).addonName;
      const port = vconPort ?? defaultVconPort();
      if (dryRun) {
        const args = buildLaunchArgs({ addon: name, map, insecure: true, dev: true, cheats: cheats !== false, vconPort: port });
        return text(`[dry run]\ntaskkill /F /IM dota2.exe\n"${dota.dota2Exe}" ${args.join(" ")}`);
      }
      const r = await restartGame(dota, name, map, port, cheats !== false, reconnect !== false);
      return json(
        { killed: r.killed, pid: r.pid, command: r.command, reconnected: r.reconnected },
        `Restarting "${name}" on "${map}" (pid ${r.pid}). VConsole reconnected: ${r.reconnected}`,
      );
    }),
  );

  server.registerTool(
    "dota_dev_cycle",
    {
      title: "Dev cycle (build + reload/restart)",
      description:
        "One-shot iterate loop: compile, then apply changes the cheapest way. Lua/panorama edits → script_reload " +
        "(panorama also hot-reloads automatically); KV or structural changes → full restart (requires `map`). " +
        "Returns console output so you can verify the result.",
      inputSchema: {
        projectRoot: z.string().optional(),
        changeType: z.enum(["auto", "lua", "panorama", "kv", "structural"]).optional().describe("Default 'auto' (build + script_reload)."),
        map: z.string().optional().describe("Required when changeType is kv/structural (for the restart)."),
        autoRestart: z.boolean().optional().describe("If reload produces console errors, do one full restart (needs map)."),
        vconPort: z.number().int().min(1).max(65535).optional(),
      },
    },
    guard(async ({ projectRoot, changeType, map, autoRestart, vconPort }): Promise<ToolResult> => {
      const project = await resolveProject(projectRoot);
      const kind = changeType ?? "auto";
      const steps: string[] = [];
      const dota = await requireDotaPaths();
      const port = vconPort ?? defaultVconPort();

      // 1) Build (TS templates only).
      if (project.hasTstl) {
        const res = await run(npmCommand(), ["run", "build"], { cwd: project.root, timeoutMs: 600_000 });
        steps.push(`build: ${res.code === 0 ? "OK" : "FAILED"}`);
        if (res.code !== 0) return error(`Build failed — aborting dev cycle.\n${res.stdout}\n${res.stderr}`.trim());
      }

      // 2) Apply: full restart for KV/structural changes.
      if (kind === "kv" || kind === "structural") {
        if (!map) return error(`changeType="${kind}" needs a full restart — pass a 'map' to relaunch on.`);
        const r = await restartGame(dota, project.addonName, map, port, true, true);
        steps.push(`restart: relaunched (pid ${r.pid}), vconsole reconnected: ${r.reconnected}`);
        const errs = r.reconnected ? findErrors(getVConsole(port).recent(500)) : [];
        if (errs.length) steps.push(`detected ${errs.length} error line(s) after restart`);
        return json({ kind, steps, errors: errs }, `${steps.join("\n")}${errs.length ? "\n\nERRORS:\n" + errs.join("\n") : ""}`);
      }

      // lua / panorama / auto -> hot reload
      const vc = getVConsole(port);
      try {
        if (!vc.isConnected()) await vc.connect();
      } catch {
        return json({ kind, steps, note: VCON_HINT }, `${steps.join("\n")}\n${VCON_HINT}`);
      }
      const lines = await vc.sendAndCapture("script_reload", nextSentinel(), 2500);
      steps.push("script_reload sent");
      if (kind === "panorama" || kind === "auto") steps.push("panorama hot-reloads automatically after compile");

      let errs = findErrors(lines);
      if (errs.length) {
        steps.push(`detected ${errs.length} error line(s) after reload`);
        if (autoRestart && map) {
          const r = await restartGame(dota, project.addonName, map, port, true, true);
          steps.push(`auto-restarted due to errors (pid ${r.pid}), reconnected: ${r.reconnected}`);
          errs = r.reconnected ? findErrors(getVConsole(port).recent(500)) : errs;
          steps.push(errs.length ? `still ${errs.length} error line(s) after restart` : "no errors after restart");
        }
      }
      return json(
        { kind, steps, errors: errs, output: lines.map((l) => l.text) },
        `${steps.join("\n")}\n\n${formatLines(lines)}`.trim(),
      );
    }),
  );

  server.registerTool(
    "dota_screenshot",
    {
      title: "Capture a screenshot",
      description:
        "Screenshot the running game. method 'console' uses the in-game `jpeg` command (best when a map is " +
        "rendering); 'window' captures the dota2 window via the OS (works in tools mode too, but a 3D viewport may " +
        "be black); 'auto' (default) tries console then falls back to window. Returns the image.",
      inputSchema: {
        method: z.enum(["auto", "console", "window"]).optional(),
        quality: z.number().int().min(1).max(100).optional().describe("JPEG quality for the console method (default 90)."),
        vconPort: z.number().int().min(1).max(65535).optional(),
      },
    },
    guard(async ({ method, quality, vconPort }): Promise<ToolResult> => {
      const dota = await requireDotaPaths();
      const mode = method ?? "auto";

      // Console method: send `jpeg`, then read the new file from the screenshots dir.
      if (mode === "console" || mode === "auto") {
        const vc = getVConsole(vconPort);
        let connected = vc.isConnected();
        if (!connected) {
          try {
            await vc.connect();
            connected = true;
          } catch {
            /* fall through to window capture in auto mode */
          }
        }
        if (connected) {
          const dir = dota.screenshotsDir;
          await ensureDir(dir);
          const before = new Set(await readdir(dir).catch(() => []));
          const sinceMs = Date.now() - 1000;
          vc.send(`jpeg ${quality ?? 90}`);
          const isImg = (n: string) => /\.(jpe?g|png|tga)$/i.test(n);
          let found: string | undefined;
          for (let i = 0; i < 16 && !found; i++) {
            await sleep(250);
            for (const name of (await readdir(dir).catch(() => [])) as string[]) {
              if (!isImg(name)) continue;
              if (before.has(name)) {
                const st = await stat(join(dir, name)).catch(() => null);
                if (!st || st.mtimeMs < sinceMs) continue;
              }
              found = name;
            }
          }
          if (found) {
            await sleep(200);
            const fp = join(dir, found);
            const buf = await readFile(fp);
            const mimeType = /\.png$/i.test(found) ? "image/png" : "image/jpeg";
            return image(buf.toString("base64"), mimeType, `Screenshot (console): ${fp} (${Math.round(buf.length / 1024)} KB)`);
          }
          if (mode === "console") {
            return error(`Sent 'jpeg' but no new screenshot appeared in ${dota.screenshotsDir}. Is a map rendering? Try method 'window'.`);
          }
        } else if (mode === "console") {
          return error(VCON_HINT);
        }
      }

      // Window method (and the auto fallback): capture the dota2 window via the OS.
      const buf = await captureDotaWindowPng();
      if (buf && buf.length) {
        return image(buf.toString("base64"), "image/png", `Screenshot (window capture, ${Math.round(buf.length / 1024)} KB)`);
      }
      return error("Could not capture a screenshot. Is dota2.exe running with a visible window? (A 3D viewport may capture black via the OS method.)");
    }),
  );

  server.registerTool(
    "dota_watch_errors",
    {
      title: "Watch for console errors",
      description:
        "Scan the live console output for Lua/engine errors (script error, stack traceback, attempt to call/index, " +
        "*.lua:NN, assertion failed). Optionally clear first and wait a window to catch errors triggered by an action.",
      inputSchema: {
        windowMs: z.number().int().min(0).max(60000).optional().describe("Wait this long collecting output before scanning (default 0)."),
        clear: z.boolean().optional().describe("Clear the console buffer before watching (catch only new errors)."),
        limit: z.number().int().positive().max(2000).optional(),
        vconPort: z.number().int().min(1).max(65535).optional(),
      },
    },
    guard(async ({ windowMs, clear, limit, vconPort }): Promise<ToolResult> => {
      const vc = getVConsole(vconPort);
      try {
        if (!vc.isConnected()) await vc.connect();
      } catch {
        return error(VCON_HINT);
      }
      if (clear) vc.clearRing();
      if (windowMs && windowMs > 0) await sleep(windowMs);
      const errs = findErrors(vc.recent(limit ?? 500));
      return json(
        { count: errs.length, errors: errs },
        errs.length ? `Found ${errs.length} error line(s):\n${errs.join("\n")}` : "No errors found in recent console output.",
      );
    }),
  );
}
