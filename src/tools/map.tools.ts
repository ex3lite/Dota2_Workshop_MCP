import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { join } from "node:path";
import { resolveProject } from "../config.js";
import { requireDotaPaths, DotaPaths } from "../dota/paths.js";
import { AddonProject } from "../dota/project.js";
import { vmapToText, textToVmap, cloneVmap, maxNodeId, buildEntityBlock, insertEntity, compileVmap } from "../dota/vmap.js";
import { parseKV, serializeKV, getWrapperBlock, findPair, upsertPair, objectToBlock, isBlock, blockToObject } from "../kv/index.js";
import { readTextFile, writeTextFile, pathExists } from "../util/fsx.js";
import { json, text, error, guard, ToolResult } from "../util/result.js";

const NAME_RE = /^[a-z][a-z0-9_]+$/;
const numOrStr = z.union([z.string(), z.number()]);

interface MapPaths {
  contentVmap: string;
  gameVpk: string;
  addoninfo: string;
  baseTemplate: string;
}
function mapPaths(dota: DotaPaths, project: AddonProject, name: string): MapPaths {
  return {
    contentVmap: join(dota.contentDotaAddons, project.addonName, "maps", `${name}.vmap`),
    gameVpk: join(dota.gameDotaAddons, project.addonName, "maps", `${name}.vpk`),
    addoninfo: join(project.gameDir, "addoninfo.txt"),
    baseTemplate: join(dota.contentDotaAddons, "addon_template", "maps", "template_map.vmap"),
  };
}

async function registerMap(addoninfoPath: string, name: string, maxPlayers: number): Promise<void> {
  let doc;
  if (await pathExists(addoninfoPath)) {
    doc = parseKV((await readTextFile(addoninfoPath)).text);
  } else {
    doc = parseKV(`"AddonInfo"\n{\n\t"maps" ""\n\t"IsPlayable" "1"\n}\n`);
  }
  const wrapper = getWrapperBlock(doc);
  if (!wrapper) throw new Error("addoninfo.txt has no AddonInfo wrapper.");
  const mapsPair = findPair(wrapper, "maps");
  const current = mapsPair && !isBlock(mapsPair.value) ? (mapsPair.value as string) : "";
  const list = current.split(/\s+/).filter(Boolean);
  if (!list.includes(name)) list.push(name);
  upsertPair(wrapper, "maps", list.join(" "));
  if (!findPair(wrapper, name)) {
    upsertPair(wrapper, name, objectToBlock({ MaxPlayers: String(maxPlayers) }));
  }
  await writeTextFile(addoninfoPath, serializeKV(doc), { encoding: "utf8" });
}

export function registerMapTools(server: McpServer) {
  server.registerTool(
    "map_create",
    {
      title: "Create a playable map",
      description:
        "Create a new, immediately-playable Dota map for the addon by cloning the official template map (which has " +
        "the required ground, lighting and team spawns), then register it in addoninfo.txt. Edit it afterwards with " +
        "map_add_entity / map_from_text, then map_compile. Building bespoke geometry still needs Hammer.",
      inputSchema: {
        projectRoot: z.string().optional(),
        name: z.string().describe("Map name (file/addoninfo name, lowercase)."),
        maxPlayers: z.number().int().min(1).max(24).optional().describe("Per-map MaxPlayers (default 10)."),
        compile: z.boolean().optional().describe("Also compile to a .vpk after creating (default false)."),
        overwrite: z.boolean().optional(),
      },
    },
    guard(async ({ projectRoot, name, maxPlayers, compile, overwrite }): Promise<ToolResult> => {
      if (!NAME_RE.test(name)) return error(`Invalid map name "${name}" (lowercase letters, digits, underscores).`);
      const dota = await requireDotaPaths();
      const project = await resolveProject(projectRoot);
      const p = mapPaths(dota, project, name);
      if (!(await pathExists(p.baseTemplate))) return error(`Base template map not found: ${p.baseTemplate}`);
      if ((await pathExists(p.contentVmap)) && !overwrite) return error(`Map already exists: ${p.contentVmap} (pass overwrite=true).`);

      await cloneVmap(p.baseTemplate, p.contentVmap);
      await registerMap(p.addoninfo, name, maxPlayers ?? 10);

      const out: Record<string, unknown> = { name, vmap: p.contentVmap, registered: p.addoninfo };
      const steps = [`Created map "${name}":`, `  + ${p.contentVmap}`, `  ~ registered in ${p.addoninfo}`];
      if (compile) {
        const res = await compileVmap(dota.resourceCompilerExe, dota.dotaGameDir, p.contentVmap, p.gameVpk);
        out.compiled = res.code === 0;
        steps.push(res.code === 0 ? `  ✓ compiled -> ${p.gameVpk}` : `  ✗ compile failed (exit ${res.code})`);
        if (res.code !== 0) steps.push(res.stdout.slice(-1500));
      } else {
        steps.push(`Next: map_compile name="${name}", then launch with addon_launch_custom_game map="${name}".`);
      }
      return json(out, steps.join("\n"));
    }),
  );

  server.registerTool(
    "map_add_entity",
    {
      title: "Add an entity to a map",
      description:
        "Place an entity (any classname: npc_dota_spawner, info_player_start_*, env_*, point_*, prop_dynamic, …) into " +
        "a map's vmap with origin/angles/properties. Recompile afterwards (or pass recompile=true).",
      inputSchema: {
        projectRoot: z.string().optional(),
        map: z.string().describe("Map name."),
        classname: z.string(),
        origin: z.string().optional().describe('"x y z" (default "0 0 0").'),
        angles: z.string().optional().describe('"pitch yaw roll".'),
        properties: z.record(numOrStr).optional().describe("Entity keyvalues."),
        recompile: z.boolean().optional(),
      },
    },
    guard(async ({ projectRoot, map, classname, origin, angles, properties, recompile }): Promise<ToolResult> => {
      const dota = await requireDotaPaths();
      const project = await resolveProject(projectRoot);
      const p = mapPaths(dota, project, map);
      if (!(await pathExists(p.contentVmap))) return error(`Map not found: ${p.contentVmap}. Create it with map_create.`);

      const txt = await vmapToText(dota.dmxconvertExe, p.contentVmap);
      const block = buildEntityBlock({ classname, origin, angles, properties }, maxNodeId(txt) + 1);
      await textToVmap(dota.dmxconvertExe, insertEntity(txt, block), p.contentVmap);

      const steps = [`Added ${classname} at ${origin ?? "0 0 0"} to "${map}".`];
      if (recompile) {
        const res = await compileVmap(dota.resourceCompilerExe, dota.dotaGameDir, p.contentVmap, p.gameVpk);
        steps.push(res.code === 0 ? `Recompiled -> ${p.gameVpk}` : `Recompile FAILED (exit ${res.code})\n${res.stdout.slice(-1500)}`);
      } else {
        steps.push(`Recompile with map_compile name="${map}".`);
      }
      return json({ map, classname }, steps.join("\n"));
    }),
  );

  server.registerTool(
    "map_to_text",
    {
      title: "Read a map as DMX text",
      description: "Return a map's full editable keyvalues2 DMX text (for advanced edits). Pair with map_from_text. Large.",
      inputSchema: { projectRoot: z.string().optional(), map: z.string() },
    },
    guard(async ({ projectRoot, map }): Promise<ToolResult> => {
      const dota = await requireDotaPaths();
      const project = await resolveProject(projectRoot);
      const p = mapPaths(dota, project, map);
      if (!(await pathExists(p.contentVmap))) return error(`Map not found: ${p.contentVmap}.`);
      const txt = await vmapToText(dota.dmxconvertExe, p.contentVmap);
      return json({ map, length: txt.length }, txt);
    }),
  );

  server.registerTool(
    "map_from_text",
    {
      title: "Write a map from DMX text",
      description:
        "Write a map's binary .vmap from keyvalues2 DMX text (full programmatic control). The text must be a valid " +
        "vmap DMX document (e.g. obtained via map_to_text and edited). Recompile afterwards.",
      inputSchema: {
        projectRoot: z.string().optional(),
        map: z.string(),
        text: z.string().describe("keyvalues2 DMX vmap text (must start with the dmx header)."),
        recompile: z.boolean().optional(),
      },
    },
    guard(async ({ projectRoot, map, text: dmxText, recompile }): Promise<ToolResult> => {
      const dota = await requireDotaPaths();
      const project = await resolveProject(projectRoot);
      const p = mapPaths(dota, project, map);
      await textToVmap(dota.dmxconvertExe, dmxText, p.contentVmap);
      const steps = [`Wrote ${p.contentVmap} (${dmxText.length} chars).`];
      if (recompile) {
        const res = await compileVmap(dota.resourceCompilerExe, dota.dotaGameDir, p.contentVmap, p.gameVpk);
        steps.push(res.code === 0 ? `Recompiled -> ${p.gameVpk}` : `Recompile FAILED (exit ${res.code})\n${res.stdout.slice(-1500)}`);
      }
      return json({ map }, steps.join("\n"));
    }),
  );

  server.registerTool(
    "map_compile",
    {
      title: "Compile a map",
      description: "Compile a map's content .vmap into a playable game .vpk (resourcecompiler).",
      inputSchema: {
        projectRoot: z.string().optional(),
        name: z.string(),
        force: z.boolean().optional(),
        dryRun: z.boolean().optional(),
      },
    },
    guard(async ({ projectRoot, name, force, dryRun }): Promise<ToolResult> => {
      const dota = await requireDotaPaths();
      const project = await resolveProject(projectRoot);
      const p = mapPaths(dota, project, name);
      if (dryRun) return text(`[dry run]\n"${dota.resourceCompilerExe}" -v -nop4${force ? " -f" : ""} -i "${p.contentVmap}" -game "${dota.dotaGameDir}"`);
      if (!(await pathExists(p.contentVmap))) return error(`Map content not found: ${p.contentVmap}.`);
      const res = await compileVmap(dota.resourceCompilerExe, dota.dotaGameDir, p.contentVmap, p.gameVpk, force);
      const ok = res.code === 0 && (await pathExists(p.gameVpk));
      return json(
        { name, ok, vpk: p.gameVpk, exitCode: res.code },
        `${ok ? "COMPILE OK -> " + p.gameVpk : "COMPILE FAILED (exit " + res.code + ")"}\n\n${res.stdout.slice(-2000)}\n${res.stderr.slice(-500)}`.trim(),
      );
    }),
  );

  server.registerTool(
    "map_list",
    {
      title: "List addon maps",
      description: "List the addon's maps (from addoninfo.txt) with their source (.vmap) and compiled (.vpk) status.",
      inputSchema: { projectRoot: z.string().optional() },
    },
    guard(async ({ projectRoot }): Promise<ToolResult> => {
      const dota = await requireDotaPaths();
      const project = await resolveProject(projectRoot);
      const addoninfo = join(project.gameDir, "addoninfo.txt");
      let names: string[] = [];
      if (await pathExists(addoninfo)) {
        const wrapper = getWrapperBlock(parseKV((await readTextFile(addoninfo)).text));
        const mapsPair = wrapper && findPair(wrapper, "maps");
        if (mapsPair && !isBlock(mapsPair.value)) names = (mapsPair.value as string).split(/\s+/).filter(Boolean);
      }
      const maps = [];
      for (const name of names) {
        const p = mapPaths(dota, project, name);
        maps.push({ name, source: await pathExists(p.contentVmap), compiled: await pathExists(p.gameVpk) });
      }
      return json(
        { count: maps.length, maps },
        maps.length
          ? maps.map((m) => `  ${m.name}  [source: ${m.source ? "yes" : "no"}, compiled: ${m.compiled ? "yes" : "no"}]`).join("\n")
          : "No maps registered in addoninfo.txt.",
      );
    }),
  );
}
