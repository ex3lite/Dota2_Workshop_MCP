// asset_preview — out-of-engine visual preview of particles / textures / models from the
// downloaded games. Uses ValveResourceFormat (Source2Viewer-CLI) to decode compiled
// assets (vtex_c→png, vmdl_c→glb) WITHOUT launching Dota, then builds a self-contained
// HTML gallery (PNG thumbnails inline + interactive <model-viewer> for models) so you can
// eyeball candidates and pick. Particle previews show the sprite/texture(s) the particle
// uses (resolved from the .vpcf, with the base game pak as a fallback).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir, rm, copyFile } from "node:fs/promises";
import { findFiles, resolveVpk } from "../dota/reflib.js";
import { ensureVrf, vrfDecode, vrfDecompileText } from "../dota/vrf.js";
import { requireDotaPaths } from "../dota/paths.js";
import { json, error, guard, ToolResult } from "../util/result.js";

type Kind = "auto" | "texture" | "particle" | "model";
const EXT: Record<Exclude<Kind, "auto">, string> = { texture: "vtex_c", particle: "vpcf_c", model: "vmdl_c" };

interface Card {
  id: string;
  game: string;
  name: string;
  path: string;
  kind: string;
  png?: string; // data-uri
  glb?: string; // relative filename
  note?: string;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "preview";
}

// Pull the texture(s) a particle references out of its decompiled KV3.
function texRefs(vpcfText: string): string[] {
  return [...new Set([...vpcfText.matchAll(/"([^"]*\.vtex)"/g)].map((m) => m[1]))];
}

async function dataUri(pngPath: string): Promise<string | undefined> {
  const buf = await readFile(pngPath).catch(() => undefined);
  if (!buf || !buf.length) return undefined;
  // Cap embedded thumbnails so the gallery stays light.
  if (buf.length > 4_000_000) return undefined;
  return "data:image/png;base64," + buf.toString("base64");
}

function galleryHtml(query: string, cards: Card[]): string {
  const cardHtml = cards
    .map((c) => {
      const media = c.png
        ? `<img loading="lazy" src="${c.png}" />`
        : c.glb
          ? `<model-viewer src="${c.glb}" camera-controls auto-rotate disable-zoom style="width:100%;height:200px;background:#111"></model-viewer>`
          : `<div class="noprev">${c.note || "no preview"}</div>`;
      return `<div class="card" data-name="${(c.name + " " + c.game).toLowerCase()}">
  <div class="media">${media}</div>
  <div class="name" title="${c.path}">${c.name}</div>
  <div class="meta">${c.kind} · ${c.game}</div>
  <div class="path">${c.path}</div>
</div>`;
    })
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Preview: ${query}</title>
<script type="module" src="https://ajax.googleapis.com/ajax/libs/model-viewer/3.5.0/model-viewer.min.js"></script>
<style>
  body{background:#0d1017;color:#cdd3e0;font:14px/1.4 system-ui,Segoe UI,sans-serif;margin:0;padding:16px}
  h1{font-size:18px;margin:0 0 4px} .sub{color:#7c879c;margin-bottom:12px}
  #q{width:320px;padding:6px 10px;border-radius:6px;border:1px solid #2a3346;background:#161b27;color:#fff;margin-bottom:14px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
  .card{background:#161b27;border:1px solid #222b3d;border-radius:8px;overflow:hidden}
  .media{height:200px;display:flex;align-items:center;justify-content:center;background:
     repeating-conic-gradient(#1a1f2c 0% 25%, #11141d 0% 50%) 50% / 24px 24px}
  .media img{max-width:100%;max-height:200px;image-rendering:auto}
  .noprev{color:#5b647a;font-size:12px;padding:12px;text-align:center}
  .name{padding:6px 8px 0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .meta{padding:0 8px;color:#8b93a7;font-size:12px}
  .path{padding:2px 8px 8px;color:#5b647a;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style></head><body>
<h1>Asset preview — "${query}"</h1>
<div class="sub">${cards.length} result(s). Decoded out-of-engine via ValveResourceFormat. Type to filter:</div>
<input id="q" placeholder="filter by name / game…" oninput="for(const c of document.querySelectorAll('.card')){c.style.display=c.dataset.name.includes(this.value.toLowerCase())?'':'none'}">
<div class="grid">
${cardHtml}
</div></body></html>`;
}

export function registerPreviewTools(server: McpServer) {
  server.registerTool(
    "asset_preview",
    {
      title: "Preview particles / textures / models (out of engine)",
      description:
        "Visually preview assets WITHOUT launching Dota. Searches the downloaded games for matching particles " +
        "(.vpcf), textures (.vtex) or models (.vmdl), decodes them with ValveResourceFormat (textures→PNG, models→GLB, " +
        "particles→their sprite texture), and builds a self-contained HTML GALLERY (inline PNG thumbnails + interactive " +
        "3D <model-viewer> for models) you open in a browser to eyeball and pick. e.g. asset_preview query=\"spark\" " +
        "kind=\"particle\". First run auto-installs the decoder (~100MB, Windows).",
      inputSchema: {
        query: z.string().describe("Name substring, e.g. 'spark', 'fire', 'tower', 'phoenix'."),
        kind: z.enum(["auto", "texture", "particle", "model"]).optional().describe("Asset type (default 'auto' = particles, then textures)."),
        id: z.string().optional().describe("Restrict to one game id."),
        limit: z.number().int().positive().max(40).optional().describe("Max assets to decode (default 12; higher = slower)."),
      },
    },
    guard(async ({ query, kind, id, limit }): Promise<ToolResult> => {
      const k = (kind ?? "auto") as Kind;
      const cap = limit ?? 12;

      // Resolve which compiled assets to preview (auto: particles, fall back to textures).
      const kinds: Exclude<Kind, "auto">[] = k === "auto" ? ["particle", "texture"] : [k];
      let matches: { id: string; title: string; path: string; kind: Exclude<Kind, "auto"> }[] = [];
      for (const kk of kinds) {
        if (matches.length >= cap) break;
        const hits = await findFiles(query, { ext: EXT[kk], id, limit: cap - matches.length });
        matches.push(...hits.map((h) => ({ ...h, kind: kk })));
      }
      if (!matches.length) {
        return error(`No ${k === "auto" ? "particles/textures" : k + "s"} matching "${query}" in the downloaded games. (Download more with workshop_download, or try ref_find to see what exists.)`);
      }
      await ensureVrf(); // only download the ~100MB decoder once we have something to decode

      const outDir = join(homedir(), ".dota2-workshop-mcp", "previews", slug(query));
      await rm(outDir, { recursive: true, force: true }).catch(() => {});
      await mkdir(outDir, { recursive: true });
      const basePak = (await requireDotaPaths().catch(() => null))?.pak01DirVpk;

      const cards: Card[] = [];
      let glbN = 0;
      let pngN = 0;
      for (const m of matches.slice(0, cap)) {
        const vpk = await resolveVpk(m.id);
        if (!vpk) continue;
        const name = m.path.split("/").pop()!.replace(/\.\w+_c$/, "");
        const card: Card = { id: m.id, game: m.title, name, path: m.path, kind: m.kind };
        try {
          if (m.kind === "texture") {
            const out = await vrfDecode(vpk, m.path, join(outDir, "_d"));
            const png = out.find((f) => f.endsWith(".png"));
            if (png) card.png = await dataUri(png);
          } else if (m.kind === "model") {
            const out = await vrfDecode(vpk, m.path, outDir, { glb: true });
            const glb = out.find((f) => f.endsWith(".glb"));
            if (glb) {
              const rel = `model_${glbN++}.glb`;
              await copyFile(glb, join(outDir, rel)).catch(() => {});
              card.glb = rel;
            } else card.note = "model export failed";
          } else {
            // particle: decompile, find a texture ref, decode it (game vpk, else base pak).
            const text = await vrfDecompileText(vpk, m.path);
            const refs = text ? texRefs(text) : [];
            let decoded: string | undefined;
            for (const ref of refs.slice(0, 3)) {
              for (const src of [vpk, basePak].filter(Boolean) as string[]) {
                const out = await vrfDecode(src, ref, join(outDir, "_d")).catch(() => [] as string[]);
                decoded = out.find((f) => f.endsWith(".png"));
                if (decoded) break;
              }
              if (decoded) break;
            }
            if (decoded) card.png = await dataUri(decoded);
            else card.note = refs.length ? `uses ${refs[0].split("/").pop()} (texture not found locally)` : "no texture ref";
          }
        } catch (e) {
          card.note = `decode failed: ${e instanceof Error ? e.message : e}`;
        }
        if (card.png) pngN++;
        cards.push(card);
      }
      await rm(join(outDir, "_d"), { recursive: true, force: true }).catch(() => {});

      const htmlPath = join(outDir, "gallery.html");
      await writeFile(htmlPath, galleryHtml(query, cards), "utf8");
      const summary =
        `Preview "${query}": ${cards.length} asset(s) — ${pngN} image(s)${glbN ? `, ${glbN} model(s)` : ""}.\n` +
        `Open the gallery: ${htmlPath}\n` +
        cards.map((c) => `  ${c.png ? "🖼" : c.glb ? "🧊" : "·"} ${c.name}  (${c.game})  ${c.path}`).join("\n");
      return json({ query, outDir, gallery: htmlPath, count: cards.length, images: pngN, models: glbN, cards }, summary);
    }),
  );
}
