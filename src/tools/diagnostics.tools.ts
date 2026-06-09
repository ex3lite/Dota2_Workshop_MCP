import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readdir, lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import { resolveDotaPaths, hasWorkshopTools } from "../dota/paths.js";
import { configuredAddonDir, resolveProject } from "../config.js";
import { pathExists } from "../util/fsx.js";
import { parseKV, getWrapperBlock, blockToObject } from "../kv/index.js";
import { readTextFile } from "../util/fsx.js";
import { auditAddon } from "../dota/audit.js";
import { json, text, error, guard, ToolResult } from "../util/result.js";

async function listAddons(dir: string): Promise<string[]> {
  if (!(await pathExists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name).sort();
}

export function registerDiagnosticsTools(server: McpServer) {
  server.registerTool(
    "dota_doctor",
    {
      title: "Dota environment check",
      description:
        "Diagnose the Dota 2 + Workshop Tools install and the current addon project: install path, " +
        "key executables, tools DLC, detected project type/addon name, and whether the addon is linked into dota_addons.",
      inputSchema: { projectRoot: z.string().optional().describe("Addon project root. Defaults to DOTA2_ADDON_DIR.") },
    },
    guard(async ({ projectRoot }): Promise<ToolResult> => {
      const dota = await resolveDotaPaths();
      const report: Record<string, unknown> = {};

      if (!dota) {
        report.dota = { found: false, hint: "Set DOTA2_PATH to your 'dota 2 beta' folder." };
      } else {
        report.dota = {
          found: true,
          root: dota.root,
          detectedVia: dota.source,
          dota2Exe: (await pathExists(dota.dota2Exe)) ? dota.dota2Exe : `MISSING: ${dota.dota2Exe}`,
          resourceCompiler: (await pathExists(dota.resourceCompilerExe)) ? dota.resourceCompilerExe : "missing",
          workshopTools: await hasWorkshopTools(dota),
        };
      }

      const root = projectRoot ?? configuredAddonDir();
      if (!root) {
        report.project = { configured: false, hint: "Set DOTA2_ADDON_DIR or pass projectRoot to tools." };
      } else {
        try {
          const p = await resolveProject(root);
          let linked = false;
          let linkInfo = "not linked";
          if (dota) {
            const gameLink = join(dota.gameDotaAddons, p.addonName);
            if (await pathExists(gameLink)) {
              linked = true;
              linkInfo = `present at ${gameLink}`;
            }
            // Is the project's game dir a junction/symlink?
            try {
              const st = await lstat(p.gameDir);
              if (st.isSymbolicLink()) linkInfo += ` (game/ -> ${await readlink(p.gameDir)})`;
            } catch {
              /* ignore */
            }
          }
          report.project = {
            root: p.root,
            type: p.type,
            addonName: p.addonName,
            hasTstl: p.hasTstl,
            tsVscripts: p.tsVscriptsDir ?? null,
            npcDir: p.npcDir,
            linkedIntoDota: linked,
            linkInfo,
          };
          if (!linked) {
            (report.project as any).hint =
              "Addon not found in dota_addons. In a TS template run `node scripts/install.js` (or `npm install` " +
              "without --ignore-scripts) to create the game/content junctions, then the launch tools will work.";
          }
        } catch (e) {
          report.project = { root, error: e instanceof Error ? e.message : String(e) };
        }
      }

      const lines = ["Dota 2 Workshop MCP — environment", JSON.stringify(report, null, 2)];
      return json(report, lines.join("\n"));
    }),
  );

  server.registerTool(
    "addon_list",
    {
      title: "List installed addons",
      description: "List addons present in the Dota install's game/dota_addons and content/dota_addons folders.",
      inputSchema: {},
    },
    guard(async (): Promise<ToolResult> => {
      const dota = await resolveDotaPaths();
      if (!dota) return error("Dota install not found. Set DOTA2_PATH.");
      const game = await listAddons(dota.gameDotaAddons);
      const content = await listAddons(dota.contentDotaAddons);
      return json(
        { game, content },
        `game/dota_addons (${game.length}):\n  ${game.join("\n  ")}\n\ncontent/dota_addons (${content.length}):\n  ${content.join("\n  ")}`,
      );
    }),
  );

  server.registerTool(
    "addon_info",
    {
      title: "Read addoninfo.txt",
      description: "Read and parse an addon's addoninfo.txt (maps, playability flags, per-map settings).",
      inputSchema: {
        addon: z.string().describe("Addon folder name under game/dota_addons."),
      },
    },
    guard(async ({ addon }): Promise<ToolResult> => {
      const dota = await resolveDotaPaths();
      if (!dota) return error("Dota install not found. Set DOTA2_PATH.");
      const path = join(dota.gameDotaAddons, addon, "addoninfo.txt");
      if (!(await pathExists(path))) return error(`addoninfo.txt not found for addon "${addon}" at ${path}`);
      const { text: raw } = await readTextFile(path);
      const doc = parseKV(raw);
      const block = getWrapperBlock(doc);
      const data = block ? blockToObject(block) : {};
      return json({ addon, path, info: data }, `${path}\n\n${JSON.stringify(data, null, 2)}`);
    }),
  );

  server.registerTool(
    "addon_audit",
    {
      title: "Audit the addon for common mistakes",
      description:
        "Static best-practice audit (no game needed), encoding lessons from shipping games: dead custom events " +
        "(client fires an event with no server listener), missing Precache, chatty net-table writes with no debounce, " +
        "Panorama layouts missing from custom_ui_manifest.xml, and non-hidden abilities/items with no tooltip token " +
        "in any addon_*.txt locale. Returns findings with severity + a fix suggestion (often a scaffold_* tool).",
      inputSchema: {
        projectRoot: z.string().optional(),
        severity: z.enum(["all", "warn"]).optional().describe("'warn' shows only warnings; default 'all'."),
      },
    },
    guard(async ({ projectRoot, severity }): Promise<ToolResult> => {
      const project = await resolveProject(projectRoot);
      const { findings, scanned } = await auditAddon(project);
      const filtered = severity === "warn" ? findings.filter((f) => f.severity === "warn") : findings;
      const warns = findings.filter((f) => f.severity === "warn").length;
      const header = `Audited ${project.addonName}: scanned ${scanned.vscripts} vscripts + ${scanned.panorama} panorama files. ${warns} warning(s), ${findings.length - warns} info.`;
      if (!filtered.length) return json({ project: project.addonName, scanned, findings: [] }, `${header}\nNo issues found. 🎉`);
      const body = filtered
        .map((f) => `  [${f.severity.toUpperCase()}] ${f.rule}: ${f.message}${f.file ? `\n      file: ${f.file}` : ""}${f.suggestion ? `\n      fix: ${f.suggestion}` : ""}`)
        .join("\n");
      return json({ project: project.addonName, scanned, findings: filtered }, `${header}\n\n${body}`);
    }),
  );
}
