#!/usr/bin/env node
// Parses the @moddota/panorama-types TypeScript declarations into a compact,
// searchable Panorama JS API bundle at src/data/panorama-api.json.
//
// The official Panorama JS API page (developer.valvesoftware.com) returns 403 to
// automated fetches, so we use @moddota/panorama-types — the community-maintained,
// machine-readable form of the same API (with JSDoc + examples). Run: npm run build:panorama-api

import ts from "typescript";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "src", "data", "panorama-api.json");

const SOURCES = [
  "https://cdn.jsdelivr.net/npm/@moddota/panorama-types/types/api.d.ts",
  "https://cdn.jsdelivr.net/npm/@moddota/panorama-types/types/panels.d.ts",
];

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function oneLine(s) {
  return s.replace(/\s+/g, " ").trim();
}

function jsdocOf(node) {
  const docs = ts.getJSDocCommentsAndTags ? ts.getJSDocCommentsAndTags(node) : [];
  let comment = "";
  const examples = [];
  for (const d of docs) {
    if (ts.isJSDoc(d)) {
      if (typeof d.comment === "string") comment += (comment ? "\n" : "") + d.comment;
      else if (Array.isArray(d.comment)) comment += d.comment.map((c) => c.text).join("");
      for (const tag of d.tags ?? []) {
        const tagText = typeof tag.comment === "string" ? tag.comment : Array.isArray(tag.comment) ? tag.comment.map((c) => c.text).join("") : "";
        if (tag.tagName.text === "example") examples.push(tagText.trim());
      }
    }
  }
  return { comment: comment.trim() || undefined, examples };
}

function memberText(member, sf) {
  // Node text excludes leading JSDoc trivia; collapse to one line.
  return oneLine(member.getText(sf));
}

function parseFile(name, text, out) {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);

  const visit = (node) => {
    if (ts.isInterfaceDeclaration(node)) {
      const { comment } = jsdocOf(node);
      const members = [];
      for (const m of node.members) {
        const { comment: mc, examples } = jsdocOf(m);
        let mname;
        if (m.name) mname = m.name.getText(sf);
        else if (ts.isCallSignatureDeclaration(m)) mname = "(call)"; // e.g. $("#id") selector
        else if (ts.isIndexSignatureDeclaration(m)) mname = "[index]";
        else if (ts.isConstructSignatureDeclaration(m)) mname = "(new)";
        else continue;
        const isMethod =
          ts.isMethodSignature(m) || ts.isMethodDeclaration(m) || ts.isCallSignatureDeclaration(m) || ts.isConstructSignatureDeclaration(m);
        members.push({
          name: mname,
          kind: isMethod ? "method" : "property",
          signature: memberText(m, sf).replace(/;$/, ""),
          description: mc,
          examples: examples.length ? examples : undefined,
        });
      }
      const ext = [];
      for (const h of node.heritageClauses ?? []) {
        if (h.token === ts.SyntaxKind.ExtendsKeyword) for (const t of h.types) ext.push(t.expression.getText(sf));
      }
      out.interfaces.push({ name: node.name.text, description: comment, extends: ext.length ? ext : undefined, members });
    } else if (ts.isModuleDeclaration(node) && node.body && ts.isModuleBlock(node.body)) {
      node.body.statements.forEach(visit);
    } else if (ts.isVariableStatement(node)) {
      // `declare var $: DollarStatic;` -> global mapping (isVariableStatement matches var + const)
      const isDeclare = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const { comment } = jsdocOf(node);
        out.globals.push({
          name: decl.name.text,
          type: decl.type ? oneLine(decl.type.getText(sf)) : undefined,
          description: comment,
          declared: !!isDeclare,
        });
      }
    }
  };

  sf.statements.forEach(visit);
}

// Merge inherited members down each `extends` chain so an interface (e.g. LabelPanel)
// exposes everything it actually has, not just its own 1-2 members. Own members win;
// inherited members are deduped by name and tagged with inheritedFrom.
function flattenInherited(out) {
  const byName = new Map(out.interfaces.map((i) => [i.name, i]));
  const own = new Map(out.interfaces.map((i) => [i.name, i.members]));
  const cache = new Map();

  const resolve = (name, stack) => {
    if (cache.has(name)) return cache.get(name);
    if (stack.has(name)) return own.get(name) ?? []; // cycle guard
    stack.add(name);
    const iface = byName.get(name);
    if (!iface) {
      stack.delete(name);
      return [];
    }
    const ownMembers = own.get(name) ?? [];
    const ownNames = new Set(ownMembers.map((m) => m.name));
    const inherited = [];
    const seenInherited = new Set();
    for (const base of iface.extends ?? []) {
      const baseName = base.replace(/<[\s\S]*$/, "").trim(); // strip generic args
      for (const m of resolve(baseName, stack)) {
        if (!ownNames.has(m.name) && !seenInherited.has(m.name)) {
          inherited.push({ ...m, inheritedFrom: m.inheritedFrom ?? baseName });
          seenInherited.add(m.name);
        }
      }
    }
    const all = [...ownMembers, ...inherited];
    stack.delete(name);
    cache.set(name, all);
    return all;
  };

  for (const i of out.interfaces) i.members = resolve(i.name, new Set());
}

async function main() {
  console.error("Fetching @moddota/panorama-types declarations ...");
  const out = { interfaces: [], globals: [], generatedAt: new Date().toISOString() };
  for (const url of SOURCES) {
    const text = await fetchText(url);
    parseFile(url.split("/").pop(), text, out);
  }

  // De-dup interfaces by name (panels.d.ts + api.d.ts shouldn't overlap, but be safe).
  const seen = new Set();
  out.interfaces = out.interfaces.filter((i) => (seen.has(i.name) ? false : seen.add(i.name)));

  flattenInherited(out);

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out), "utf8");
  const memberCount = out.interfaces.reduce((n, i) => n + i.members.length, 0);
  console.error(`Wrote ${OUT}\n  interfaces=${out.interfaces.length} members=${memberCount} globals=${out.globals.length}`);
}

main().catch((err) => {
  console.error("build-panorama-api failed:", err);
  process.exit(1);
});
