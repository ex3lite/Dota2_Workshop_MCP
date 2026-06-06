// Programmatic Dota 2 map (.vmap) authoring. A .vmap is a DMX document; Valve's
// dmxconvert.exe converts between the binary on-disk form and a human-readable
// keyvalues2 text form. We read a map as kv2 text, edit it (add entities, etc.),
// and write it back to binary — then resourcecompiler turns it into a playable .vpk.
//
// Proven pipeline: kv2 text -> dmxconvert (binary) -> resourcecompiler (-game game/dota) -> .vpk.

import { writeFile, readFile, mkdtemp, rm, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { run, RunResult } from "./process.js";

/** Convert a binary .vmap to keyvalues2 text. */
export async function vmapToText(dmxconvert: string, vmapPath: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "d2vmap-"));
  const out = join(dir, "map.kv2.txt");
  try {
    const res = await run(dmxconvert, ["-i", vmapPath, "-o", out, "-oe", "keyvalues2"], { timeoutMs: 120_000 });
    if (res.code !== 0) throw new Error(`dmxconvert (to text) failed: ${res.stderr || res.stdout}`);
    return await readFile(out, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Write keyvalues2 text out as a binary .vmap. */
export async function textToVmap(dmxconvert: string, text: string, vmapPath: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "d2vmap-"));
  const inTxt = join(dir, "map.kv2.txt");
  try {
    await writeFile(inTxt, text, "utf8");
    await mkdir(dirname(vmapPath), { recursive: true });
    const res = await run(dmxconvert, ["-i", inTxt, "-o", vmapPath, "-oe", "binary"], { timeoutMs: 120_000 });
    if (res.code !== 0) throw new Error(`dmxconvert (to binary) failed: ${res.stderr || res.stdout}`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Clone a base .vmap to a new path (binary copy — guaranteed-valid starting point). */
export async function cloneVmap(basePath: string, destPath: string): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });
  await copyFile(basePath, destPath);
}

export function maxNodeId(text: string): number {
  let max = 0;
  for (const m of text.matchAll(/"nodeID"\s+"int"\s+"(\d+)"/g)) max = Math.max(max, Number(m[1]));
  return max;
}

export interface EntitySpec {
  classname: string;
  origin?: string; // "x y z"
  angles?: string; // "pitch yaw roll"
  properties?: Record<string, string | number>;
}

/** Build a CMapEntity keyvalues2 block (whitespace is irrelevant to dmxconvert). */
export function buildEntityBlock(spec: EntitySpec, nodeId: number): string {
  const props = spec.properties ?? {};
  const propLines = Object.entries(props)
    .map(([k, v]) => `\t\t"${k}" "string" "${String(v)}"`)
    .join("\n");
  return `"CMapEntity"
{
	"id" "elementid" "${randomUUID()}"
	"origin" "vector3" "${spec.origin ?? "0 0 0"}"
	"angles" "qangle" "${spec.angles ?? "0 0 0"}"
	"scales" "vector3" "1 1 1"
	"nodeID" "int" "${nodeId}"
	"children" "element_array" [ ]
	"editorOnly" "bool" "0"
	"force_hidden" "bool" "0"
	"variableTargetKeys" "string_array" [ ]
	"variableNames" "string_array" [ ]
	"relayPlugData" "DmePlugList"
	{
		"id" "elementid" "${randomUUID()}"
		"names" "string_array" [ ]
		"dataTypes" "int_array" [ ]
		"plugTypes" "int_array" [ ]
		"descriptions" "string_array" [ ]
	}
	"connectionsData" "element_array" [ ]
	"entity_properties" "EditGameClassProps"
	{
		"id" "elementid" "${randomUUID()}"
		"classname" "string" "${spec.classname}"
${propLines}
	}
	"hitNormal" "vector3" "0 0 1"
}
`;
}

/** Insert an entity block into the CMapWorld children array of a kv2 vmap text. */
export function insertEntity(text: string, entityBlock: string): string {
  const worldIdx = text.indexOf('"world" "CMapWorld"');
  if (worldIdx < 0) throw new Error("Could not find the CMapWorld element in this vmap.");
  const childrenIdx = text.indexOf('"children" "element_array"', worldIdx);
  if (childrenIdx < 0) throw new Error("Could not find the world children array.");
  const openBracket = text.indexOf("[", childrenIdx);
  if (openBracket < 0) throw new Error("Malformed world children array.");
  const insertAt = openBracket + 1;
  const after = text.slice(insertAt);
  // element_array entries are comma-separated (and may be inline definitions or
  // "element" "<id>" references) — add a separating comma when the array is non-empty.
  const isEmpty = /^\s*\]/.test(after);
  const sep = isEmpty ? "" : ",";
  return text.slice(0, insertAt) + "\n" + entityBlock.trimEnd() + sep + after;
}

export interface MapCompileResult extends RunResult {
  vpkPath: string;
}

/** Compile a content .vmap into a game .vpk via resourcecompiler. */
export async function compileVmap(
  resourceCompilerExe: string,
  dotaGameDir: string,
  contentVmapPath: string,
  gameMapsVpkPath: string,
  force = false,
): Promise<MapCompileResult> {
  const args = ["-v", "-nop4", "-i", contentVmapPath, "-game", dotaGameDir];
  if (force) args.splice(2, 0, "-f");
  const res = await run(resourceCompilerExe, args, { timeoutMs: 600_000 });
  return { ...res, vpkPath: gameMapsVpkPath };
}
