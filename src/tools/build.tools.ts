import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { join } from "node:path";
import { resolveProject } from "../config.js";
import { requireDotaPaths } from "../dota/paths.js";
import { run, spawnDetached, npmCommand } from "../dota/process.js";
import { AddonProject } from "../dota/project.js";
import { pathExists } from "../util/fsx.js";
import { json, text, error, guard, ToolResult } from "../util/result.js";

async function resolveAddonName(projectRoot: string | undefined, addon: string | undefined): Promise<{ name: string; project?: AddonProject }> {
  if (addon) return { name: addon };
  const project = await resolveProject(projectRoot);
  return { name: project.addonName, project };
}

export function registerBuildTools(server: McpServer) {
  server.registerTool(
    "addon_build",
    {
      title: "Build the addon",
      description:
        "Compile the addon's scripts. For a TS template this runs `npm run build` (typescript-to-lua + panorama). " +
        "Returns compiler output; check for type errors.",
      inputSchema: {
        projectRoot: z.string().optional(),
        dryRun: z.boolean().optional().describe("Return the command without running it."),
      },
    },
    guard(async ({ projectRoot, dryRun }): Promise<ToolResult> => {
      const project = await resolveProject(projectRoot);
      const cmd = `${npmCommand()} run build`;
      if (dryRun) return text(`[dry run] (cwd: ${project.root})\n${cmd}`);
      if (!project.hasTstl) {
        return error(
          "This project is not a TypeScript template (no typescript-to-lua). Use addon_compile_content for raw content, " +
            "or build it with your own toolchain.",
        );
      }
      const res = await run(npmCommand(), ["run", "build"], { cwd: project.root, timeoutMs: 600_000 });
      const ok = res.code === 0;
      return json(
        { command: res.command, exitCode: res.code, ok, timedOut: res.timedOut },
        `${ok ? "BUILD OK" : "BUILD FAILED"} (exit ${res.code})\n$ ${res.command}\n\n${res.stdout}\n${res.stderr}`.trim(),
      );
    }),
  );

  server.registerTool(
    "addon_compile_content",
    {
      title: "Compile addon content (resourcecompiler)",
      description:
        "Run resourcecompiler.exe over the addon's content (maps .vmap, particles .vpcf, materials, panorama) into " +
        "the compiled game tree. The addon must be linked into the Dota content/dota_addons folder.",
      inputSchema: {
        projectRoot: z.string().optional(),
        addon: z.string().optional().describe("Addon folder name (defaults to the project's addon name)."),
        force: z.boolean().optional().describe("Force full rebuild (-f)."),
        dryRun: z.boolean().optional(),
      },
    },
    guard(async ({ projectRoot, addon, force, dryRun }): Promise<ToolResult> => {
      const dota = await requireDotaPaths();
      const { name } = await resolveAddonName(projectRoot, addon);
      const contentPath = join(dota.contentDotaAddons, name);
      const gamePath = join(dota.gameDotaAddons, name);
      const args = ["-v", "-nop4", "-i", join(contentPath, "*"), "-r", "-game", gamePath];
      if (force) args.splice(2, 0, "-f");
      const cmd = `"${dota.resourceCompilerExe}" ${args.join(" ")}`;
      if (dryRun) return text(`[dry run]\n${cmd}`);
      if (!(await pathExists(contentPath))) {
        return error(`Content folder not found: ${contentPath}. Link the addon into Dota first (addon_link / scripts/install.js).`);
      }
      const res = await run(dota.resourceCompilerExe, args, { timeoutMs: 600_000 });
      const ok = res.code === 0;
      return json(
        { command: res.command, exitCode: res.code, ok },
        `${ok ? "COMPILE OK" : "COMPILE FAILED"} (exit ${res.code})\n$ ${res.command}\n\n${res.stdout}\n${res.stderr}`.trim(),
      );
    }),
  );

  server.registerTool(
    "addon_launch_tools",
    {
      title: "Launch Workshop Tools",
      description:
        "Launch Dota 2 in Workshop Tools mode for the addon (dota2.exe -tools -addon <name>). Optionally start a map " +
        "directly. The game runs detached.",
      inputSchema: {
        projectRoot: z.string().optional(),
        addon: z.string().optional(),
        map: z.string().optional().describe("If set, also runs +dota_launch_custom_game <addon> <map>."),
        console: z.boolean().optional().describe("Add -console (default true)."),
        dryRun: z.boolean().optional(),
      },
    },
    guard(async ({ projectRoot, addon, map, console: withConsole, dryRun }): Promise<ToolResult> => {
      const dota = await requireDotaPaths();
      const { name } = await resolveAddonName(projectRoot, addon);
      const args = ["-novid", "-tools", "-addon", name];
      if (withConsole !== false) args.push("-console");
      if (map) args.push("+dota_launch_custom_game", name, map);
      const cmd = `"${dota.dota2Exe}" ${args.join(" ")}`;
      if (dryRun) return text(`[dry run]\n${cmd}`);
      const { pid } = spawnDetached(dota.dota2Exe, args, dota.binWin64);
      return json({ command: cmd, pid, addon: name }, `Launched Workshop Tools (pid ${pid}):\n${cmd}`);
    }),
  );

  server.registerTool(
    "addon_launch_custom_game",
    {
      title: "Launch & start a custom game",
      description:
        "Launch Dota 2 (tools mode) and immediately start the addon's custom game on a map for testing " +
        "(dota2.exe -addon <name> -tools -console -insecure +dota_launch_custom_game <name> <map>).",
      inputSchema: {
        projectRoot: z.string().optional(),
        addon: z.string().optional(),
        map: z.string().describe("Map name from the addon's addoninfo.txt 'maps' list."),
        dryRun: z.boolean().optional(),
      },
    },
    guard(async ({ projectRoot, addon, map, dryRun }): Promise<ToolResult> => {
      const dota = await requireDotaPaths();
      const { name } = await resolveAddonName(projectRoot, addon);
      const args = ["-novid", "-addon", name, "-tools", "-console", "-insecure", "+dota_launch_custom_game", name, map];
      const cmd = `"${dota.dota2Exe}" ${args.join(" ")}`;
      if (dryRun) return text(`[dry run]\n${cmd}`);
      const { pid } = spawnDetached(dota.dota2Exe, args, dota.binWin64);
      return json({ command: cmd, pid, addon: name, map }, `Launching custom game "${name}" on "${map}" (pid ${pid}):\n${cmd}`);
    }),
  );

  server.registerTool(
    "addon_link",
    {
      title: "Link addon into Dota",
      description:
        "Wire the addon's game/ and content/ folders into the Dota install's dota_addons via the template's " +
        "scripts/install.js (creates junctions). Required before launching. Runs in the project root.",
      inputSchema: { projectRoot: z.string().optional(), dryRun: z.boolean().optional() },
    },
    guard(async ({ projectRoot, dryRun }): Promise<ToolResult> => {
      const project = await resolveProject(projectRoot);
      const installScript = join(project.root, "scripts", "install.js");
      if (!(await pathExists(installScript))) {
        return error(`No scripts/install.js in ${project.root}. This linking helper is specific to the ModDota TS template.`);
      }
      const cmd = `node scripts/install.js`;
      if (dryRun) return text(`[dry run] (cwd: ${project.root})\n${cmd}`);
      const res = await run("node", ["scripts/install.js"], { cwd: project.root, timeoutMs: 120_000 });
      const ok = res.code === 0;
      return json(
        { command: res.command, exitCode: res.code, ok },
        `${ok ? "LINKED" : "LINK FAILED"} (exit ${res.code})\n${res.stdout}\n${res.stderr}`.trim(),
      );
    }),
  );
}
