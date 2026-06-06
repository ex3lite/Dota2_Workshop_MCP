#!/usr/bin/env node
// Fetches the ModDota dota-data VScript API + enums and transforms them into a
// compact, searchable bundle at src/data/dota-api.json.
//
// Source: https://github.com/ModDota/dota-data  (files/vscripts/{api,enums}.json)
// Run with:  npm run build:api   (network required; the result is committed so the
// MCP server itself never needs network at runtime).

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "src", "data", "dota-api.json");

const SOURCES = [
  "https://raw.githubusercontent.com/ModDota/dota-data/master/files/vscripts/",
  "https://cdn.jsdelivr.net/npm/@moddota/dota-data/files/vscripts/",
];

async function fetchJson(file) {
  let lastErr;
  for (const base of SOURCES) {
    try {
      const res = await fetch(base + file);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${base + file}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      console.error(`  ! ${base + file} failed: ${err.message}`);
    }
  }
  throw lastErr;
}

// A "type" entry is either a plain string ("string", "CDOTA_BaseNPC", "nil") or an
// object discriminated by `kind` (array / nullable / literal / function / table).
function typeStr(t) {
  if (typeof t === "string") return t;
  if (t == null) return "nil";
  switch (t.kind) {
    case "array":
      return typeList(t.types ?? []) + "[]";
    case "nullable":
      return typeList(t.types ?? []) + "?";
    case "literal":
      return JSON.stringify(t.value);
    case "table":
      return t.key ? `table<${typeList(t.key)}, ${typeList(t.value ?? [])}>` : "table";
    case "function": {
      const ps = (t.args ?? []).map((a) => typeList(a.types ?? [])).join(", ");
      return `func(${ps}) => ${typeList(t.returns ?? ["nil"])}`;
    }
    default:
      return "any";
  }
}

function typeList(types) {
  return types && types.length ? types.map(typeStr).join("|") : "nil";
}

function convFn(m) {
  const args = (m.args ?? []).map((a, i) => ({
    name: a.name ?? `arg${i + 1}`,
    type: typeList(a.types ?? []),
    description: a.description ?? undefined,
  }));
  const returns = typeList(m.returns ?? []);
  const signature = `${m.name}(${args
    .map((a) => `${a.name}: ${a.type}`)
    .join(", ")}): ${returns}`;
  return {
    name: m.name,
    signature,
    args,
    returns,
    description: m.description ?? undefined,
    available: m.available ?? undefined,
  };
}

async function main() {
  console.error("Fetching ModDota dota-data api.json + enums.json ...");
  const [api, enums] = await Promise.all([
    fetchJson("api.json"),
    fetchJson("enums.json"),
  ]);

  const out = { classes: [], functions: [], enums: [], generatedAt: new Date().toISOString() };

  for (const e of api) {
    if (e.kind === "class") {
      out.classes.push({
        name: e.name,
        clientName: e.clientName ?? undefined,
        extends: e.extend ?? undefined,
        description: e.description ?? undefined,
        methods: (e.members ?? [])
          .filter((m) => m.kind === "function")
          .map(convFn),
      });
    } else if (e.kind === "function") {
      out.functions.push(convFn(e));
    }
  }

  for (const e of enums) {
    if (e.kind === "enum") {
      out.enums.push({
        name: e.name,
        kind: "enum",
        available: e.available ?? undefined,
        members: (e.members ?? []).map((m) => ({
          name: m.name,
          value: m.value,
          description: m.description ?? undefined,
        })),
      });
    } else if (e.kind === "constant") {
      out.enums.push({
        name: e.name,
        kind: "constant",
        value: e.value,
        available: e.available ?? undefined,
      });
    }
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out), "utf8");
  console.error(
    `Wrote ${OUT}\n  classes=${out.classes.length} functions=${out.functions.length} enums/constants=${out.enums.length}`
  );
}

main().catch((err) => {
  console.error("build-api failed:", err);
  process.exit(1);
});
