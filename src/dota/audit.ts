// Static best-practice audit for a custom-game addon, encoding lessons from analyzing
// shipping games (see dota_patterns + the design docs). Pure file scanning — no game
// needed. Catches the bugs that bite custom games: dead custom events (client fires an
// event no server listener handles), missing precache, chatty net-table writes, panorama
// layouts not in the manifest, and abilities/items with no tooltip token.

import { join, dirname } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { AddonProject } from "./project.js";
import { pathExists, readTextFile } from "../util/fsx.js";
import { parseKV, getWrapperBlock, blockToObject } from "../kv/index.js";

export type Severity = "warn" | "info";

export interface AuditFinding {
  severity: Severity;
  rule: string;
  message: string;
  file?: string;
  suggestion?: string;
}

async function walk(dir: string, exts: string[], out: string[] = [], depth = 0): Promise<string[]> {
  if (depth > 8 || !(await pathExists(dir))) return out;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      await walk(full, exts, out, depth + 1);
    } else if (exts.some((x) => e.name.toLowerCase().endsWith(x))) {
      out.push(full);
    }
  }
  return out;
}

async function readAll(files: string[]): Promise<{ file: string; text: string }[]> {
  const out: { file: string; text: string }[] = [];
  for (const f of files) {
    try {
      out.push({ file: f, text: await readFile(f, "utf8") });
    } catch {
      /* skip */
    }
  }
  return out;
}

function matchAll(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[1]);
}

export async function auditAddon(project: AddonProject): Promise<{ findings: AuditFinding[]; scanned: { vscripts: number; panorama: number } }> {
  const findings: AuditFinding[] = [];

  // Collect server (vscripts) + client (panorama) source.
  const vscriptDirs = [project.tsVscriptsDir, project.vscriptsOutDir].filter(Boolean) as string[];
  const vscriptFiles: string[] = [];
  for (const d of vscriptDirs) await walk(d, [".lua", ".ts"], vscriptFiles);
  const panoramaDirs = [project.tsPanoramaDir, join(project.panoramaContentDir, "scripts")].filter(Boolean) as string[];
  const panoramaFiles: string[] = [];
  for (const d of panoramaDirs) await walk(d, [".js", ".ts"], panoramaFiles);

  const server = await readAll(vscriptFiles);
  const client = await readAll(panoramaFiles);
  const serverBlob = server.map((s) => s.text).join("\n");
  const clientBlob = client.map((s) => s.text).join("\n");

  // --- 1) Precache ---------------------------------------------------------
  if (server.length && !/\bPrecache\w*\(/.test(serverBlob)) {
    findings.push({
      severity: "warn",
      rule: "precache-missing",
      message: "No Precache() found in vscripts. Particles/models/sounds loaded at runtime cause frame hitches.",
      suggestion: "Add a Precache(context) function in addon_game_mode that PrecacheResource/PrecacheUnitByNameSync's your assets.",
    });
  }

  // --- 2) Custom-event client/server wiring --------------------------------
  const clientSends = new Set(matchAll(clientBlob, /SendCustomGameEventToServer\(\s*["']([^"']+)["']/g));
  const clientSubs = new Set(matchAll(clientBlob, /GameEvents\.Subscribe\(\s*["']([^"']+)["']/g));
  const serverListens = new Set(matchAll(serverBlob, /RegisterListener\(\s*["']([^"']+)["']/g));
  // Player/Team sends put the event name in the SECOND arg; AllClients (first-arg) is
  // captured separately below — exclude it here so a string payload isn't read as an event.
  const serverSends = new Set(matchAll(serverBlob, /Send_ServerTo(?:Player|Team)\w*\(\s*[^,]+,\s*["']([^"']+)["']/g));
  // also Send_ServerToAllClients("name", ...) where first arg is the name
  for (const n of matchAll(serverBlob, /Send_ServerToAllClients\(\s*["']([^"']+)["']/g)) serverSends.add(n);

  for (const ev of clientSends) {
    if (!serverListens.has(ev)) {
      findings.push({
        severity: "warn",
        rule: "custom-event-no-listener",
        message: `Client fires custom event "${ev}" but no server CustomGameEventManager:RegisterListener("${ev}") was found — the event is dropped.`,
        suggestion: `Register it server-side, or use scaffold_rpc for request/response.`,
      });
    }
  }
  for (const ev of serverSends) {
    if (!clientSubs.has(ev) && clientFilesExist(client)) {
      findings.push({
        severity: "info",
        rule: "custom-event-no-subscriber",
        message: `Server sends custom event "${ev}" but no client GameEvents.Subscribe("${ev}") was found — no panel handles it.`,
        suggestion: "Subscribe to it in a panel script, or remove the send.",
      });
    }
  }

  // --- 3) Net-table write churn -------------------------------------------
  const setCount = (serverBlob.match(/CustomNetTables:SetTableValue/g) || []).length;
  const hasDebounce = /SetContextThink|NetSync|GetGameFrameCount|Timers:CreateTimer/.test(serverBlob);
  if (setCount >= 8 && !hasDebounce) {
    findings.push({
      severity: "info",
      rule: "nettable-churn",
      message: `${setCount} CustomNetTables:SetTableValue calls and no debounce/throttle found. Chatty setters spam the network.`,
      suggestion: "Use scaffold_nettable_binding (NetSync:SetDebounced) to collapse same-frame writes into one push.",
    });
  }

  // --- 4) Panorama layouts not in the manifest -----------------------------
  const layoutDir = join(project.panoramaContentDir, "layout", "custom_game");
  const manifestPath = join(layoutDir, "custom_ui_manifest.xml");
  if (await pathExists(manifestPath)) {
    const manifest = await readFile(manifestPath, "utf8").catch(() => "");
    const layouts = (await readdir(layoutDir).catch(() => [])).filter((f) => /\.xml$/i.test(f) && f.toLowerCase() !== "custom_ui_manifest.xml");
    for (const lay of layouts) {
      if (!manifest.includes(lay)) {
        findings.push({
          severity: "info",
          rule: "panorama-not-in-manifest",
          message: `Layout "${lay}" is not referenced in custom_ui_manifest.xml — it won't load as a HUD element.`,
          file: join(layoutDir, lay),
          suggestion: "Add a <CustomUIElement> (or <CustomLoadingScreen>/etc.) entry pointing at it, or load it at runtime from JS.",
        });
      }
    }
  }

  // --- 5) Abilities/items without a tooltip token --------------------------
  // Check ALL locale files (resource/addon_*.txt), not just english — a token defined
  // in any locale counts (ports often keep tokens in addon_schinese.txt etc.).
  let locTokens = "";
  const resourceDir = dirname(project.localizationFile);
  for (const f of await readdir(resourceDir).catch(() => [])) {
    if (/^addon_.*\.txt$/i.test(f)) {
      try {
        locTokens += "\n" + (await readTextFile(join(resourceDir, f))).text;
      } catch {
        /* skip unreadable locale */
      }
    }
  }
  // Extract the exact set of localized ability/item keys once (exact match avoids the
  // prefix-collision false negative, e.g. "gemtd_remove" vs "gemtd_remove_all").
  const tokenKeys = new Set([...locTokens.matchAll(/DOTA_Tooltip_ability_([A-Za-z0-9_]+)/g)].map((m) => m[1]));
  const haveLocales = locTokens.length > 0;
  const SINGULAR: Record<string, string> = { abilities: "ability", items: "item" };
  for (const [logical, file] of [
    ["abilities", "npc_abilities_custom.txt"],
    ["items", "npc_items_custom.txt"],
  ] as const) {
    const p = join(project.npcDir, file);
    if (!(await pathExists(p))) continue;
    try {
      const doc = parseKV((await readTextFile(p)).text);
      const block = getWrapperBlock(doc);
      const obj = (block ? blockToObject(block) : {}) as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        const entry = obj[key];
        if (key === "Version" || typeof entry !== "object" || Array.isArray(entry)) continue;
        // Skip hidden/internal abilities (build dummies, no-hp-bar markers, etc.) — they
        // don't surface a tooltip to the player so a missing token is intentional.
        const beh = (entry as Record<string, unknown>).AbilityBehavior;
        const behStr = Array.isArray(beh) ? beh.join(" ") : String(beh ?? "");
        if (/HIDDEN/i.test(behStr)) continue;
        if (haveLocales && !tokenKeys.has(key)) {
          findings.push({
            severity: "info",
            rule: "missing-tooltip",
            message: `${SINGULAR[logical]} "${key}" has no DOTA_Tooltip_ability_${key} in any addon_*.txt locale — it'll show the raw key in-game.`,
            file: p,
            suggestion: "Re-run scaffold_ability/scaffold_item, or add the localization token.",
          });
        }
      }
    } catch {
      /* parse error — skip */
    }
  }

  return { findings, scanned: { vscripts: server.length, panorama: client.length } };
}

function clientFilesExist(client: { file: string }[]): boolean {
  return client.length > 0;
}
