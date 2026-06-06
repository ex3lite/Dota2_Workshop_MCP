// Serialize a KV AST back to Valve-style KeyValues text (tab indentation, quoted
// keys/values, aligned values), preserving comments and `#base` directives.

import { KVBlock, KVDocument, KVNode, KVValue, isBlock } from "./ast.js";

export interface SerializeOptions {
  /** Indentation unit. Defaults to a tab (Valve convention). */
  indent?: string;
  /** Column (in chars, counted after indentation) to align scalar values to. */
  valueColumn?: number;
  /** Newline sequence. Defaults to CRLF to match Valve's Windows files. */
  eol?: string;
}

const DEFAULTS: Required<SerializeOptions> = {
  indent: "\t",
  valueColumn: 44,
  eol: "\r\n",
};

function escape(value: string): string {
  // KV rarely needs escapes; only escape embedded quotes/backslashes to stay safe.
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function serializeKV(doc: KVDocument | KVBlock, options: SerializeOptions = {}): string {
  const opts = { ...DEFAULTS, ...options };
  const out: string[] = [];
  const nodes = doc.kind === "document" ? doc.nodes : doc.nodes;
  writeNodes(nodes, 0, out, opts);
  return out.join(opts.eol) + opts.eol;
}

function writeNodes(nodes: KVNode[], depth: number, out: string[], opts: Required<SerializeOptions>) {
  const pad = opts.indent.repeat(depth);
  for (const node of nodes) {
    if (node.kind === "comment") {
      out.push(`${pad}//${node.text ? " " + node.text : ""}`);
      continue;
    }

    if (node.kind === "base") {
      if (node.leadingComments) for (const c of node.leadingComments) out.push(`${pad}//${c ? " " + c : ""}`);
      out.push(`${pad}#base "${escape(node.path)}"${node.inlineComment ? `\t// ${node.inlineComment}` : ""}`);
      continue;
    }

    // pair
    if (node.leadingComments) for (const c of node.leadingComments) out.push(`${pad}//${c ? " " + c : ""}`);

    if (isBlock(node.value)) {
      out.push(`${pad}"${escape(node.key)}"`);
      out.push(`${pad}{`);
      writeNodes(node.value.nodes, depth + 1, out, opts);
      out.push(`${pad}}`);
    } else {
      const keyField = `"${escape(node.key)}"`;
      const gap = computeGap(keyField.length, opts.valueColumn);
      const cond = node.condition ? ` [${node.condition}]` : "";
      const inline = node.inlineComment ? `\t// ${node.inlineComment}` : "";
      out.push(`${pad}${keyField}${gap}"${escape(node.value as string)}"${cond}${inline}`);
    }
  }
}

function computeGap(keyLen: number, valueColumn: number): string {
  if (keyLen + 1 >= valueColumn) return "\t";
  return " ".repeat(valueColumn - keyLen);
}

/** Convenience: serialize just the value tree (no document wrapper). */
export function serializeValue(value: KVValue, options?: SerializeOptions): string {
  if (!isBlock(value)) return `"${value}"`;
  return serializeKV(value, options);
}
