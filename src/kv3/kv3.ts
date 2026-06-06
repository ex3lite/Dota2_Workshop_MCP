// A pragmatic parser + serializer for Source 2 KV3 **text** files (.vsndevts, .vpcf,
// .vmat, etc.). KV3 differs from KV1: `key = value` pairs, unquoted identifier keys,
// typed arrays `[ ... ]`, booleans/null, //+/* */ comments, multi-line `"""..."""`
// strings, and an optional `<!-- kv3 ... -->` header.
//
// Reading returns plain JS values (objects preserve key insertion order). This is a
// tolerant reader for inspection/search + a clean writer for files we author
// (soundevents). It is not a byte-exact round-tripper for complex particle files —
// authoring those is the Particle/Material editors' job.

export type Kv3Value = string | number | boolean | null | Kv3Value[] | Kv3Object;
export interface Kv3Object {
  [key: string]: Kv3Value;
}

const KV3_HEADER = "<!-- kv3 encoding:text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d} format:generic:version{7412167c-06e9-4698-aff2-e63eb59037e7} -->";

export class Kv3ParseError extends Error {}

export function parseKv3(input: string): Kv3Value {
  let i = 0;
  const n = input.length;

  function err(msg: string): never {
    const line = input.slice(0, i).split("\n").length;
    throw new Kv3ParseError(`KV3 parse error (line ${line}): ${msg}`);
  }

  function skip(): void {
    while (i < n) {
      const c = input[i];
      if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === ",") {
        i++;
      } else if (c === "<" && input.startsWith("<!--", i)) {
        const end = input.indexOf("-->", i);
        i = end < 0 ? n : end + 3;
      } else if (c === "/" && input[i + 1] === "/") {
        const nl = input.indexOf("\n", i);
        i = nl < 0 ? n : nl + 1;
      } else if (c === "/" && input[i + 1] === "*") {
        const end = input.indexOf("*/", i);
        i = end < 0 ? n : end + 2;
      } else {
        break;
      }
    }
  }

  function readString(): string {
    if (input.startsWith('"""', i)) {
      i += 3;
      // Optional leading newline is dropped by KV3 convention.
      if (input[i] === "\n") i++;
      else if (input[i] === "\r" && input[i + 1] === "\n") i += 2;
      const end = input.indexOf('"""', i);
      if (end < 0) err("unterminated multi-line string");
      let s = input.slice(i, end);
      s = s.replace(/\r?\n[ \t]*$/, ""); // trailing newline before closing """
      i = end + 3;
      return s;
    }
    i++; // opening "
    let s = "";
    while (i < n) {
      const c = input[i];
      if (c === "\\") {
        const nx = input[i + 1];
        if (nx === "n") s += "\n";
        else if (nx === "t") s += "\t";
        else if (nx === "r") s += "\r";
        else s += nx;
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        return s;
      }
      s += c;
      i++;
    }
    err("unterminated string");
  }

  function readBareword(): string {
    const start = i;
    while (i < n && /[A-Za-z0-9_.+\-]/.test(input[i])) i++;
    if (i === start) err(`unexpected character '${input[i]}'`);
    return input.slice(start, i);
  }

  function readArray(): Kv3Value[] {
    i++; // [
    const arr: Kv3Value[] = [];
    skip();
    while (i < n && input[i] !== "]") {
      arr.push(readValue());
      skip();
    }
    if (input[i] !== "]") err("unterminated array");
    i++;
    return arr;
  }

  function readObject(): Kv3Object {
    i++; // {
    const obj: Kv3Object = {};
    skip();
    while (i < n && input[i] !== "}") {
      const key = input[i] === '"' ? readString() : readBareword();
      skip();
      if (input[i] !== "=") err(`expected '=' after key '${key}'`);
      i++;
      skip();
      obj[key] = readValue();
      skip();
    }
    if (input[i] !== "}") err("unterminated object");
    i++;
    return obj;
  }

  function readValue(): Kv3Value {
    skip();
    const c = input[i];
    if (c === '"') return readString();
    if (c === "{") return readObject();
    if (c === "[") return readArray();
    if (c === "#" && input[i + 1] === "[") {
      // binary blob #[ .. ] — skip, return empty string placeholder
      const end = input.indexOf("]", i);
      i = end < 0 ? n : end + 1;
      return "";
    }
    const word = readBareword();
    // Typed value: prefix:"..." / prefix:{...} — keep the inner value (drop the type).
    if (input[i] === ":") {
      i++;
      return readValue();
    }
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    if (/^[-+]?(0x[0-9a-fA-F]+|\d*\.?\d+(e[-+]?\d+)?)$/i.test(word)) return Number(word);
    return word; // bare identifier / enum-like
  }

  skip();
  if (i >= n) err("empty document");
  const value = readValue();
  return value;
}

// --- serializer (clean output, suitable for files we author such as soundevents) ---

export interface Kv3SerializeOptions {
  header?: boolean; // emit the kv3 header comment (default true)
  indent?: string; // default tab
  eol?: string; // default "\n"
}

export function serializeKv3(value: Kv3Value, options: Kv3SerializeOptions = {}): string {
  const indent = options.indent ?? "\t";
  const eol = options.eol ?? "\n";
  const header = options.header !== false ? KV3_HEADER + eol : "";
  return header + writeValue(value, 0) + eol;

  function writeValue(v: Kv3Value, depth: number): string {
    if (v === null) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return String(v);
    if (typeof v === "string") return quote(v);
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      const allScalar = v.every((x) => x === null || typeof x !== "object");
      if (allScalar) return "[" + v.map((x) => writeValue(x, depth)).join(", ") + "]";
      const pad = indent.repeat(depth + 1);
      return "[" + eol + v.map((x) => pad + writeValue(x, depth + 1)).join("," + eol) + eol + indent.repeat(depth) + "]";
    }
    // object
    const entries = Object.entries(v);
    if (entries.length === 0) return "{" + eol + indent.repeat(depth) + "}";
    const pad = indent.repeat(depth + 1);
    const body = entries.map(([k, val]) => `${pad}${keyText(k)} = ${writeValue(val, depth + 1)}`).join(eol);
    return "{" + eol + body + eol + indent.repeat(depth) + "}";
  }

  function keyText(k: string): string {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : quote(k);
  }

  function quote(s: string): string {
    if (s.includes("\n")) return '"""' + eol + s + eol + '"""';
    return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  }
}

export const KV3_HEADER_LINE = KV3_HEADER;
