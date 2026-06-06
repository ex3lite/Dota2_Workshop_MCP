import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isAbsolute, join } from "node:path";
import { resolveProject } from "../config.js";
import { parseKv3, serializeKv3, Kv3Object } from "../kv3/kv3.js";
import { readTextFile, writeTextFile, pathExists } from "../util/fsx.js";
import { readdir } from "node:fs/promises";
import { json, error, guard, ToolResult } from "../util/result.js";

const numOrStr = z.union([z.string(), z.number()]);

export function registerSoundeventsTools(server: McpServer) {
  server.registerTool(
    "kv3_read",
    {
      title: "Read a KV3 file",
      description:
        "Parse any Source 2 KV3 text file (.vsndevts soundevents, .vpcf particles, .vmat materials, …) into JSON for " +
        "inspection. Path is absolute or relative to the addon project root.",
      inputSchema: { projectRoot: z.string().optional(), path: z.string() },
    },
    guard(async ({ projectRoot, path }): Promise<ToolResult> => {
      const project = await resolveProject(projectRoot);
      const target = isAbsolute(path) ? path : join(project.root, path);
      if (!(await pathExists(target))) return error(`File not found: ${target}`);
      const data = parseKv3((await readTextFile(target)).text);
      return json({ path: target, data: data as Record<string, unknown> }, JSON.stringify(data, null, 2).slice(0, 8000));
    }),
  );

  server.registerTool(
    "soundevents_list",
    {
      title: "List sound events",
      description: "List the addon's .vsndevts soundevent files and the event names defined in each.",
      inputSchema: { projectRoot: z.string().optional() },
    },
    guard(async ({ projectRoot }): Promise<ToolResult> => {
      const project = await resolveProject(projectRoot);
      const dir = join(project.contentDir, "soundevents");
      if (!(await pathExists(dir))) return json({ dir, files: [] }, `No soundevents dir yet (${dir}).`);
      const files = (await readdir(dir)).filter((f) => /\.vsndevts$/i.test(f));
      const out = [];
      for (const f of files) {
        try {
          const obj = parseKv3((await readTextFile(join(dir, f))).text) as Kv3Object;
          out.push({ file: f, events: Object.keys(obj) });
        } catch {
          out.push({ file: f, events: [], error: "parse failed" });
        }
      }
      return json(
        { dir, files: out },
        out.map((x) => `${x.file} (${x.events.length}):\n  ${x.events.join("\n  ")}`).join("\n\n") || "No .vsndevts files.",
      );
    }),
  );

  server.registerTool(
    "soundevents_get",
    {
      title: "Get a sound event",
      description: "Get one sound event's definition from a .vsndevts file.",
      inputSchema: {
        projectRoot: z.string().optional(),
        file: z.string().describe("File name under content/soundevents, e.g. 'game_sounds_custom.vsndevts'."),
        event: z.string(),
      },
    },
    guard(async ({ projectRoot, file, event }): Promise<ToolResult> => {
      const project = await resolveProject(projectRoot);
      const target = join(project.contentDir, "soundevents", file);
      if (!(await pathExists(target))) return error(`File not found: ${target}`);
      const obj = parseKv3((await readTextFile(target)).text) as Kv3Object;
      if (!(event in obj)) return error(`Event "${event}" not found in ${file}.`);
      return json({ file, event, value: obj[event] as Record<string, unknown> }, JSON.stringify({ [event]: obj[event] }, null, 2));
    }),
  );

  server.registerTool(
    "soundevents_upsert",
    {
      title: "Add or update a sound event",
      description:
        "Insert or update a sound event in a .vsndevts file (created if missing). Provide the sound file(s) and " +
        "optional mixing params. Recompile content (addon_compile_content) for it to take effect.",
      inputSchema: {
        projectRoot: z.string().optional(),
        file: z.string().optional().describe("Target file (default 'game_sounds_custom.vsndevts')."),
        name: z.string().describe("Event name, e.g. 'MyMod.Hit'."),
        vsnd_files: z.array(z.string()).describe("Sound file path(s), e.g. ['sounds/ui/hit.vsnd']."),
        type: z.string().optional().describe("Sound type (default 'dota_src1_2d')."),
        volume: z.number().optional(),
        pitch: z.number().optional(),
        soundlevel: z.number().optional(),
        extra: z.record(numOrStr).optional().describe("Any extra KV fields."),
      },
    },
    guard(async ({ projectRoot, file, name, vsnd_files, type, volume, pitch, soundlevel, extra }): Promise<ToolResult> => {
      const project = await resolveProject(projectRoot);
      const fileName = file ?? "game_sounds_custom.vsndevts";
      const target = join(project.contentDir, "soundevents", fileName);
      const obj: Kv3Object = (await pathExists(target)) ? (parseKv3((await readTextFile(target)).text) as Kv3Object) : {};
      const existed = name in obj;
      obj[name] = {
        type: type ?? "dota_src1_2d",
        volume: volume ?? 1.0,
        pitch: pitch ?? 1.0,
        ...(soundlevel !== undefined ? { soundlevel } : {}),
        vsnd_files: vsnd_files.length === 1 ? vsnd_files[0] : vsnd_files,
        ...(extra ?? {}),
      };
      await writeTextFile(target, serializeKv3(obj), { encoding: "utf8" });
      return json(
        { file: fileName, event: name, action: existed ? "updated" : "inserted" },
        `${existed ? "Updated" : "Added"} sound event "${name}" in ${target}. Recompile content to apply.`,
      );
    }),
  );
}
