// Lenient tokenizer + parser for Dota 2 KeyValues (KV1).
//
// Handles: quoted & bareword tokens, nested { } blocks, `//` comments (and the
// occasional malformed single-`/` comment line seen in real Valve files),
// `#base "file"` includes, and `[$CONDITION]` suffixes. Comments and order are
// preserved so edits round-trip the untouched parts of a file.

import { KVBlock, KVDocument, KVNode, KVPair, KVBase, newBlock } from "./ast.js";

type TokKind = "string" | "lbrace" | "rbrace" | "comment" | "base" | "cond";

interface Token {
  kind: TokKind;
  value: string;
  line: number;
  /** Line of the token's last character (differs from `line` for multi-line quoted strings). */
  endLine?: number;
}

export class KVParseError extends Error {
  constructor(
    message: string,
    public readonly line: number,
  ) {
    super(`KV parse error (line ${line}): ${message}`);
    this.name = "KVParseError";
  }
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const n = input.length;

  const isWs = (c: string) => c === " " || c === "\t" || c === "\r" || c === "\n";

  while (i < n) {
    const c = input[i];

    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (isWs(c)) {
      i++;
      continue;
    }

    // Comment: `//` ... EOL. We also leniently treat a single `/` as a comment when
    // it begins a malformed banner line (e.g. `/====`), but NOT when it starts a real
    // bareword like a leading-slash value, so we don't swallow legitimate content.
    if (c === "/") {
      const n2 = input[i + 1];
      const bannerChar = n2 === "=" || n2 === "*" || n2 === "-" || n2 === "#" || n2 === "~";
      const eolOrWs = n2 === undefined || n2 === "\n" || n2 === "\r" || n2 === " " || n2 === "\t";
      if (n2 === "/" || bannerChar || eolOrWs) {
        let j = i + (n2 === "/" ? 2 : 1);
        let text = "";
        while (j < n && input[j] !== "\n") {
          text += input[j];
          j++;
        }
        tokens.push({ kind: "comment", value: text.trim(), line });
        i = j;
        continue;
      }
      // Otherwise fall through to the bareword branch (a value like "/path").
    }

    if (c === "{") {
      tokens.push({ kind: "lbrace", value: "{", line });
      i++;
      continue;
    }
    if (c === "}") {
      tokens.push({ kind: "rbrace", value: "}", line });
      i++;
      continue;
    }

    // Conditional suffix like [$WIN32] / [!$WIN32]
    if (c === "[") {
      let j = i + 1;
      let text = "";
      while (j < n && input[j] !== "]" && input[j] !== "\n") {
        text += input[j];
        j++;
      }
      if (input[j] === "]") j++; // consume ]
      tokens.push({ kind: "cond", value: text, line });
      i = j;
      continue;
    }

    // Quoted string (supports \" and \\ defensively; KV rarely uses escapes).
    if (c === '"') {
      let j = i + 1;
      let text = "";
      const startLine = line;
      while (j < n) {
        const ch = input[j];
        if (ch === "\\" && j + 1 < n) {
          const next = input[j + 1];
          if (next === '"' || next === "\\") {
            text += next;
            j += 2;
            continue;
          }
          text += ch;
          j++;
          continue;
        }
        if (ch === '"') break;
        if (ch === "\n") line++;
        text += ch;
        j++;
      }
      if (j >= n) throw new KVParseError("unterminated quoted string", startLine);
      j++; // consume closing quote
      tokens.push({ kind: "string", value: text, line: startLine, endLine: line });
      i = j;
      continue;
    }

    // Bareword (unquoted) token: run until whitespace / brace / quote / comment.
    {
      let j = i;
      let text = "";
      while (j < n) {
        const ch = input[j];
        if (isWs(ch) || ch === "{" || ch === "}" || ch === '"' || ch === "[") break;
        if (ch === "/" && input[j + 1] === "/") break;
        text += ch;
        j++;
      }
      const kind: TokKind = text.toLowerCase() === "#base" ? "base" : "string";
      tokens.push({ kind, value: text, line, endLine: line });
      i = j;
      continue;
    }
  }

  return tokens;
}

/** Parse KV1 text into a document AST. Throws KVParseError on malformed input. */
export function parseKV(input: string): KVDocument {
  // Strip a UTF-8/UTF-16 BOM if present.
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);

  const tokens = tokenize(input);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseNodes(insideBlock: boolean): KVNode[] {
    const nodes: KVNode[] = [];
    let pendingComments: string[] = [];

    const flushCommentsAsStandalone = () => {
      for (const text of pendingComments) nodes.push({ kind: "comment", text });
      pendingComments = [];
    };

    while (pos < tokens.length) {
      const tok = peek();

      if (tok.kind === "rbrace") {
        if (!insideBlock) throw new KVParseError("unexpected '}'", tok.line);
        flushCommentsAsStandalone();
        next();
        return nodes;
      }

      if (tok.kind === "comment") {
        next();
        pendingComments.push(tok.value);
        continue;
      }

      if (tok.kind === "base") {
        next();
        const arg = peek();
        if (!arg || arg.kind !== "string") {
          throw new KVParseError("#base must be followed by a quoted path", tok.line);
        }
        next();
        const baseNode: KVBase = { kind: "base", path: arg.value };
        if (pendingComments.length) {
          baseNode.leadingComments = pendingComments;
          pendingComments = [];
        }
        attachInlineComment(baseNode, arg);
        nodes.push(baseNode);
        continue;
      }

      if (tok.kind === "lbrace") {
        throw new KVParseError("unexpected '{' (missing key?)", tok.line);
      }

      if (tok.kind === "cond") {
        // A stray conditional with no preceding pair — ignore but don't crash.
        next();
        continue;
      }

      // tok.kind === "string": this is a key.
      next();
      const key = tok.value;

      // A comment and/or [$cond] may sit between the key and its value/'{' (a legal
      // Valve pattern). Drain them so we don't reject valid files.
      const betweenComments: string[] = [];
      let betweenCond: string | undefined;
      while (peek() && (peek().kind === "comment" || peek().kind === "cond")) {
        const t = next();
        if (t.kind === "comment") betweenComments.push(t.value);
        else betweenCond = t.value;
      }

      const afterKey = peek();
      if (!afterKey) {
        throw new KVParseError(`key "${key}" has no value`, tok.line);
      }

      const pair: KVPair = { kind: "pair", key, value: "" };
      if (pendingComments.length) {
        pair.leadingComments = pendingComments;
        pendingComments = [];
      }
      if (betweenCond) pair.condition = betweenCond;
      if (betweenComments.length) pair.inlineComment = betweenComments.join(" ");

      if (afterKey.kind === "lbrace") {
        next(); // consume {
        const block: KVBlock = newBlock(parseNodes(true));
        pair.value = block;
      } else if (afterKey.kind === "string") {
        next();
        pair.value = afterKey.value;
        // optional [$cond] suffix after the value
        if (peek() && peek().kind === "cond") {
          pair.condition = next().value;
        }
        attachInlineComment(pair, afterKey);
      } else {
        throw new KVParseError(`key "${key}" must be followed by a value or '{'`, tok.line);
      }

      nodes.push(pair);
    }

    if (insideBlock) {
      throw new KVParseError("unexpected end of input (missing '}')", tokens[tokens.length - 1]?.line ?? 0);
    }
    flushCommentsAsStandalone();
    return nodes;
  }

  // If the next token after a value is a comment on the same line as the value's last
  // line, attach it inline (multi-line quoted values end on a later line than they start).
  function attachInlineComment(node: KVPair | KVBase, valueTok: Token) {
    const t = peek();
    if (t && t.kind === "comment" && t.line === (valueTok.endLine ?? valueTok.line)) {
      node.inlineComment = t.value;
      next();
    }
  }

  const nodes = parseNodes(false);
  return { kind: "document", nodes };
}
