// Conversions between the KV AST and plain JS objects, plus entry-level helpers
// used by the editing tools.

import { KVBlock, KVDocument, KVNode, KVPair, KVValue, isBlock, newBlock } from "./ast.js";

/** A plain-object view of KV data (blocks become nested objects). */
export type KVObject = { [key: string]: string | KVObject | (string | KVObject)[] };

/** Convert a block (or document's wrapper block) into a plain nested object.
 *  Repeated keys collapse into an array to avoid silent data loss. */
export function blockToObject(block: KVBlock): KVObject {
  const obj: KVObject = {};
  for (const node of block.nodes) {
    if (node.kind !== "pair") continue;
    const val: string | KVObject = isBlock(node.value) ? blockToObject(node.value) : node.value;
    const existing = obj[node.key];
    if (existing === undefined) {
      obj[node.key] = val;
    } else if (Array.isArray(existing)) {
      existing.push(val);
    } else {
      obj[node.key] = [existing, val];
    }
  }
  return obj;
}

/** Convert a plain JS object into a KVBlock. Scalars are stringified;
 *  numbers/booleans are coerced ("1"/"0" for booleans). Nested objects become
 *  blocks; arrays expand into repeated keys. */
export function objectToBlock(obj: Record<string, unknown>): KVBlock {
  const nodes: KVNode[] = [];
  for (const [key, raw] of Object.entries(obj)) {
    pushValue(nodes, key, raw);
  }
  return newBlock(nodes);
}

function pushValue(nodes: KVNode[], key: string, raw: unknown) {
  if (raw === null || raw === undefined) {
    nodes.push({ kind: "pair", key, value: "" });
    return;
  }
  if (Array.isArray(raw)) {
    for (const item of raw) pushValue(nodes, key, item);
    return;
  }
  if (typeof raw === "object") {
    nodes.push({ kind: "pair", key, value: objectToBlock(raw as Record<string, unknown>) });
    return;
  }
  if (typeof raw === "boolean") {
    nodes.push({ kind: "pair", key, value: raw ? "1" : "0" });
    return;
  }
  nodes.push({ kind: "pair", key, value: String(raw) });
}

/** Find the top-level wrapper pair (e.g. "DOTAAbilities" -> { ... }). */
export function findWrapper(doc: KVDocument): KVPair | undefined {
  return doc.nodes.find((n): n is KVPair => n.kind === "pair" && isBlock(n.value));
}

export function getWrapperBlock(doc: KVDocument): KVBlock | undefined {
  const w = findWrapper(doc);
  return w && isBlock(w.value) ? w.value : undefined;
}

/** List the `#base` include paths declared at the top of a document. */
export function listBases(doc: KVDocument): string[] {
  return doc.nodes.filter((n) => n.kind === "base").map((n) => (n as { path: string }).path);
}

function eq(a: string, b: string, caseInsensitive: boolean): boolean {
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function findPair(block: KVBlock, key: string, caseInsensitive = true): KVPair | undefined {
  return block.nodes.find((n): n is KVPair => n.kind === "pair" && eq(n.key, key, caseInsensitive));
}

/** Insert or replace a pair in a block, preserving position of an existing key. */
export function upsertPair(block: KVBlock, key: string, value: KVValue, caseInsensitive = true): "inserted" | "updated" {
  const idx = block.nodes.findIndex((n) => n.kind === "pair" && eq((n as KVPair).key, key, caseInsensitive));
  if (idx >= 0) {
    const existing = block.nodes[idx] as KVPair;
    block.nodes[idx] = { ...existing, key, value };
    return "updated";
  }
  block.nodes.push({ kind: "pair", key, value });
  return "inserted";
}

/** Remove all pairs matching key. Returns the number removed. */
export function removePair(block: KVBlock, key: string, caseInsensitive = true): number {
  const before = block.nodes.length;
  block.nodes = block.nodes.filter((n) => !(n.kind === "pair" && eq((n as KVPair).key, key, caseInsensitive)));
  return before - block.nodes.length;
}

/** Add a `#base "path"` directive at the top of the document if not already present. */
export function ensureBase(doc: KVDocument, path: string): boolean {
  const has = doc.nodes.some((n) => n.kind === "base" && (n as { path: string }).path.toLowerCase() === path.toLowerCase());
  if (has) return false;
  // Insert after any leading comments but before the wrapper pair.
  const wrapperIdx = doc.nodes.findIndex((n) => n.kind === "pair");
  const baseNode: KVNode = { kind: "base", path };
  if (wrapperIdx >= 0) doc.nodes.splice(wrapperIdx, 0, baseNode);
  else doc.nodes.push(baseNode);
  return true;
}
