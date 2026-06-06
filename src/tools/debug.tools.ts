import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveProject } from "../config.js";
import { requireDotaPaths } from "../dota/paths.js";
import { getVConsole, defaultVconPort } from "../dota/vconsole.js";
import { buildLaunchArgs } from "../dota/launch.js";
import { run, spawnDetached, killProcess, npmCommand } from "../dota/process.js";
import { json, text, error, guard, ToolResult } from "../util/result.js";

let sentinelCounter = 0;
function nextSentinel(): string {
  return `MCP_SENTINEL_${++sentinelCounter}`;
}

function formatLines(lines: { channel: number; text: string }[]): string {
  return lines.map((l) => l.text).join("\n");
}

const VCON_HINT =
  "Could not reach the VConsole channel. Launch the game in tools mode first (addon_launch_custom_game), " +
  "and make sure it was started with -tools (and matching -vconport if you overrode it).";

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
      const args = buildLaunchArgs({ addon: name, map, insecure: true, dev: true, cheats: cheats !== false, vconPort: port });
      const cmd = `"${dota.dota2Exe}" ${args.join(" ")}`;
      if (dryRun) return text(`[dry run]\ntaskkill /F /IM dota2.exe\n${cmd}`);

      // Drop any stale socket, kill the running client, relaunch.
      getVConsole(port).disconnect();
      const kill = await killProcess("dota2.exe");
      await new Promise((r) => setTimeout(r, 1500)); // let the OS release file locks
      const { pid } = spawnDetached(dota.dota2Exe, args, dota.binWin64);

      const report: Record<string, unknown> = { killed: kill.code === 0, pid, command: cmd, reconnected: false };
      if (reconnect !== false) {
        try {
          await getVConsole(port).connectWithRetry(60_000, 1000);
          report.reconnected = true;
        } catch {
          report.reconnectNote = "Relaunched, but VConsole not reachable yet — the game may still be loading.";
        }
      }
      return json(report, `Restarting "${name}" on "${map}" (pid ${pid}). VConsole reconnected: ${report.reconnected}`);
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
        vconPort: z.number().int().min(1).max(65535).optional(),
      },
    },
    guard(async ({ projectRoot, changeType, map, vconPort }): Promise<ToolResult> => {
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

      // 2) Apply.
      if (kind === "kv" || kind === "structural") {
        if (!map) return error(`changeType="${kind}" needs a full restart — pass a 'map' to relaunch on.`);
        getVConsole(port).disconnect();
        await killProcess("dota2.exe");
        await new Promise((r) => setTimeout(r, 1500));
        const args = buildLaunchArgs({ addon: project.addonName, map, insecure: true, dev: true, cheats: true, vconPort: port });
        const { pid } = spawnDetached(dota.dota2Exe, args, dota.binWin64);
        steps.push(`restart: relaunched (pid ${pid})`);
        let reconnected = false;
        try {
          await getVConsole(port).connectWithRetry(60_000, 1000);
          reconnected = true;
        } catch {
          /* still loading */
        }
        steps.push(`vconsole reconnected: ${reconnected}`);
        return json({ kind, steps }, steps.join("\n"));
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
      return json({ kind, steps, output: lines.map((l) => l.text) }, `${steps.join("\n")}\n\n${formatLines(lines)}`.trim());
    }),
  );
}
