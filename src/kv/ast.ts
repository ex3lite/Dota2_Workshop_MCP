// AST for Dota 2 / Source engine KeyValues (KV1) files.
//
// A document is an ordered list of nodes. We preserve order, comments and `#base`
// directives so that editing one entity round-trips the rest of the file intact.

export type KVValue = string | KVBlock;

export interface KVBlock {
  kind: "block";
  /** Ordered child nodes (pairs, comments, #base directives). */
  nodes: KVNode[];
}

export interface KVPair {
  kind: "pair";
  key: string;
  value: KVValue;
  /** Conditional suffix such as `[$WIN32]`, kept verbatim (without surrounding spaces). */
  condition?: string;
  /** Comment lines that appeared immediately above this pair. */
  leadingComments?: string[];
  /** Trailing comment on the same line as the value, e.g. `"x" "1" // note`. */
  inlineComment?: string;
}

export interface KVBase {
  kind: "base";
  /** The included file path (the quoted argument of `#base`). */
  path: string;
  leadingComments?: string[];
  inlineComment?: string;
}

/** A standalone comment line (not attached to a following pair). */
export interface KVComment {
  kind: "comment";
  text: string;
}

export type KVNode = KVPair | KVBase | KVComment;

export interface KVDocument {
  kind: "document";
  nodes: KVNode[];
}

export function isBlock(v: KVValue): v is KVBlock {
  return typeof v === "object" && v !== null && (v as KVBlock).kind === "block";
}

export function newBlock(nodes: KVNode[] = []): KVBlock {
  return { kind: "block", nodes };
}
