import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isAbsolute, join } from "node:path";
import { resolveProject } from "../config.js";
import { AddonProject, NpcFileKey, NPC_WRAPPER } from "../dota/project.js";
import { loadNpcFile, writeNpcEntry, removeNpcEntry, npcFilePath } from "../dota/kvfiles.js";
import {
  parseKV,
  serializeKV,
  KVParseError,
  getWrapperBlock,
  blockToObject,
  findPair,
  listBases,
  objectToBlock,
  isBlock,
} from "../kv/index.js";
import { readTextFile, writeTextFile, pathExists } from "../util/fsx.js";
import { json, text, error, guard, ToolResult } from "../util/result.js";

const fileEnum = z.enum(["abilities", "items", "units", "heroes"]);

async function resolvePath(project: AddonProject, file: NpcFileKey | undefined, path: string | undefined): Promise<string> {
  if (path) return isAbsolute(path) ? path : join(project.root, path);
  if (file) return npcFilePath(project, file);
  throw new Error("Specify either `file` (abilities|items|units|heroes) or `path`.");
}

export function registerKvTools(server: McpServer) {
  server.registerTool(
    "kv_read",
    {
      title: "Read a KeyValues file",
      description:
        "Parse a Dota KV file into JSON. Use `file` for the addon's npc_*_custom.txt, or `path` for any KV file " +
        "(relative to the project root or absolute). Returns the wrapper block as a nested object plus any #base includes.",
      inputSchema: {
        projectRoot: z.string().optional(),
        file: fileEnum.optional().describe("Logical npc file."),
        path: z.string().optional().describe("Explicit KV file path."),
      },
    },
    guard(async ({ projectRoot, file, path }): Promise<ToolResult> => {
      const project = await resolveProject(projectRoot);
      const target = await resolvePath(project, file, path);
      if (!(await pathExists(target))) return error(`File not found: ${target}`);
      const { text: raw } = await readTextFile(target);
      const doc = parseKV(raw);
      const wrapper = getWrapperBlock(doc);
      const data = wrapper ? blockToObject(wrapper) : {};
      const bases = listBases(doc);
      const keys = wrapper ? wrapper.nodes.filter((n) => n.kind === "pair").map((n: any) => n.key) : [];
      return json(
        { path: target, bases, entryCount: keys.length, data },
        `${target}\n#base: ${bases.join(", ") || "(none)"}\nentries: ${keys.join(", ")}`,
      );
    }),
  );

  server.registerTool(
    "kv_get_entry",
    {
      title: "Get one KV entry",
      description: "Get a single entity (ability/item/unit/hero) by key from an npc_*_custom.txt file.",
      inputSchema: { projectRoot: z.string().optional(), file: fileEnum, key: z.string() },
    },
    guard(async ({ projectRoot, file, key }): Promise<ToolResult> => {
      const project = await resolveProject(projectRoot);
      const { doc, path } = await loadNpcFile(project, file);
      const wrapper = getWrapperBlock(doc);
      const pair = wrapper && findPair(wrapper, key);
      if (!pair) return error(`Entry "${key}" not found in ${path}.`);
      const value = isBlock(pair.value) ? blockToObject(pair.value) : pair.value;
      return json({ path, key, value }, JSON.stringify({ [key]: value }, null, 2));
    }),
  );

  server.registerTool(
    "kv_upsert_entry",
    {
      title: "Add or update a KV entry",
      description:
        "Insert or replace an entity in an npc_*_custom.txt file. `data` is a JSON object; nested objects become " +
        "KV sub-blocks, numbers/booleans are stringified. Comments on other entries are preserved.",
      inputSchema: {
        projectRoot: z.string().optional(),
        file: fileEnum,
        key: z.string().describe("Entity key, e.g. an ability name or item_*/npc_dota_* key."),
        data: z.record(z.any()).describe("The entity's fields as a JSON object."),
      },
    },
    guard(async ({ projectRoot, file, key, data }): Promise<ToolResult> => {
      const project = await resolveProject(projectRoot);
      const { path, action } = await writeNpcEntry(project, file as NpcFileKey, key, objectToBlock(data));
      return text(`${action} "${key}" in ${path}`);
    }),
  );

  server.registerTool(
    "kv_remove_entry",
    {
      title: "Remove a KV entry",
      description: "Delete an entity by key from an npc_*_custom.txt file.",
      inputSchema: { projectRoot: z.string().optional(), file: fileEnum, key: z.string() },
    },
    guard(async ({ projectRoot, file, key }): Promise<ToolResult> => {
      const project = await resolveProject(projectRoot);
      const { path, removed } = await removeNpcEntry(project, file as NpcFileKey, key);
      return text(removed > 0 ? `Removed "${key}" from ${path}.` : `"${key}" not found in ${path}.`);
    }),
  );

  server.registerTool(
    "kv_validate",
    {
      title: "Validate a KV file",
      description:
        "Parse a KV file and report syntax errors plus structural warnings (wrong wrapper key, inconsistent " +
        "per-level value counts in abilities). Use `file` or `path`.",
      inputSchema: {
        projectRoot: z.string().optional(),
        file: fileEnum.optional(),
        path: z.string().optional(),
      },
    },
    guard(async ({ projectRoot, file, path }): Promise<ToolResult> => {
      const project = await resolveProject(projectRoot);
      const target = await resolvePath(project, file, path);
      if (!(await pathExists(target))) return error(`File not found: ${target}`);
      const { text: raw } = await readTextFile(target);
      const warnings: string[] = [];
      try {
        const doc = parseKV(raw);
        const wrapper = doc.nodes.find((n) => n.kind === "pair");
        if (file) {
          const expected = NPC_WRAPPER[file];
          if (wrapper && (wrapper as any).key.toLowerCase() !== expected.toLowerCase()) {
            warnings.push(`Top-level wrapper is "${(wrapper as any).key}" but expected "${expected}" for ${file}.`);
          }
        }
        return json(
          { path: target, valid: true, warnings },
          `OK — ${target} parsed successfully.${warnings.length ? "\nWarnings:\n - " + warnings.join("\n - ") : ""}`,
        );
      } catch (e) {
        if (e instanceof KVParseError) {
          return json({ path: target, valid: false, error: e.message, line: e.line }, `INVALID — ${e.message}`);
        }
        throw e;
      }
    }),
  );

  server.registerTool(
    "kv_format",
    {
      title: "Reformat a KV file",
      description: "Parse and re-serialize a KV file in canonical Valve style (tab indentation, aligned values). Rewrites the file in place.",
      inputSchema: {
        projectRoot: z.string().optional(),
        file: fileEnum.optional(),
        path: z.string().optional(),
        write: z.boolean().optional().describe("Write changes to disk (default true). If false, returns the formatted text."),
      },
    },
    guard(async ({ projectRoot, file, path, write }): Promise<ToolResult> => {
      const project = await resolveProject(projectRoot);
      const target = await resolvePath(project, file, path);
      if (!(await pathExists(target))) return error(`File not found: ${target}`);
      const { text: raw, encoding, hadBom } = await readTextFile(target);
      const formatted = serializeKV(parseKV(raw));
      if (write === false) return text(formatted);
      await writeTextFile(target, formatted, { encoding, bom: hadBom });
      return text(`Formatted ${target}.`);
    }),
  );
}
