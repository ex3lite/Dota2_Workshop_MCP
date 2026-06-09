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
import { decodePng, montage, Rgba } from "../util/imgmontage.js";
import { encodeRgbaPng } from "../util/png.js";
import { parseWav, renderWaveform, fmtDuration, detectAudio, mp3DurationSec, speakerTile } from "../util/waveform.js";
import { error, guard, ToolResult } from "../util/result.js";

type Kind = "auto" | "texture" | "particle" | "model";
const EXT: Record<Exclude<Kind, "auto">, string> = { texture: "vtex_c", particle: "vpcf_c", model: "vmdl_c" };

interface Card {
  id: string;
  game: string;
  name: string;
  path: string;
  kind: string;
  png?: string; // data-uri (for the HTML gallery)
  rgba?: Rgba; // decoded pixels (for the inline montage)
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

// Load a decoded PNG both as a data-uri (HTML gallery) and as raw RGBA (inline montage).
async function loadPreview(pngPath: string): Promise<{ uri?: string; rgba?: Rgba }> {
  const buf = await readFile(pngPath).catch(() => undefined);
  if (!buf || !buf.length) return {};
  let rgba: Rgba | undefined;
  try {
    rgba = decodePng(buf);
  } catch {
    rgba = undefined; // exotic encoding VRF emitted that our decoder doesn't handle — montage skips it
  }
  // Cap embedded thumbnails so the HTML gallery stays light (montage still uses rgba).
  const uri = buf.length > 4_000_000 ? undefined : "data:image/png;base64," + buf.toString("base64");
  return { uri, rgba };
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

interface Sound {
  id: string;
  game: string;
  name: string;
  path: string;
  format?: string; // "wav" | "mp3"
  durationSec?: number;
  bytes?: number;
  audioUri?: string; // data-uri (HTML player); omitted if too large
  mime?: string; // audio/wav | audio/mpeg
  waveUri?: string; // waveform/icon PNG data-uri
  wave?: Rgba; // waveform/icon pixels (inline montage)
  note?: string;
}

function soundboardHtml(query: string, sounds: Sound[]): string {
  const rows = sounds
    .map((s, i) => {
      const player = s.audioUri
        ? `<audio controls preload="none" src="${s.audioUri}"></audio>`
        : `<span class="big">${s.note || "audio too large to embed — open the file on disk"}</span>`;
      const wave = s.waveUri ? `<img class="wave" src="${s.waveUri}" />` : "";
      return `<div class="row" data-name="${(s.name + " " + s.game).toLowerCase()}">
  <div class="idx">${i + 1}</div>
  <div class="info"><div class="nm" title="${s.path}">${s.name}</div><div class="meta">${s.game}${s.durationSec ? " · " + fmtDuration(s.durationSec) : ""}</div></div>
  ${wave}
  <div class="play">${player}</div>
</div>`;
    })
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sounds: ${query}</title>
<style>
  body{background:#0d1017;color:#cdd3e0;font:14px/1.4 system-ui,Segoe UI,sans-serif;margin:0;padding:16px}
  h1{font-size:18px;margin:0 0 4px}.sub{color:#7c879c;margin-bottom:12px}
  #q{width:320px;padding:6px 10px;border-radius:6px;border:1px solid #2a3346;background:#161b27;color:#fff;margin-bottom:14px}
  .row{display:flex;align-items:center;gap:12px;background:#161b27;border:1px solid #222b3d;border-radius:8px;padding:8px 10px;margin-bottom:8px}
  .idx{width:22px;color:#ffd27a;font-weight:700;text-align:right}
  .info{width:240px;min-width:200px}.nm{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .meta{color:#8b93a7;font-size:12px}
  img.wave{height:48px;width:240px;background:#11141d;border-radius:4px}
  .play{flex:1;display:flex;justify-content:flex-end}.play audio{width:100%;max-width:380px}
  .big{color:#5b647a;font-size:12px}
</style></head><body>
<h1>Sound preview — "${query}"</h1>
<div class="sub">${sounds.length} sound(s). Decoded out-of-engine via ValveResourceFormat. Press play. Type to filter:</div>
<input id="q" placeholder="filter by name / game…" oninput="for(const r of document.querySelectorAll('.row')){r.style.display=r.dataset.name.includes(this.value.toLowerCase())?'':'none'}">
${rows}
</body></html>`;
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
            if (png) {
              const p = await loadPreview(png);
              card.png = p.uri;
              card.rgba = p.rgba;
            }
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
            if (decoded) {
              const p = await loadPreview(decoded);
              card.png = p.uri;
              card.rgba = p.rgba;
            } else card.note = refs.length ? `uses ${refs[0].split("/").pop()} (texture not found locally)` : "no texture ref";
          }
        } catch (e) {
          card.note = `decode failed: ${e instanceof Error ? e.message : e}`;
        }
        if (card.png || card.rgba) pngN++;
        cards.push(card);
      }
      await rm(join(outDir, "_d"), { recursive: true, force: true }).catch(() => {});

      const htmlPath = join(outDir, "gallery.html");
      await writeFile(htmlPath, galleryHtml(query, cards), "utf8");

      // Contact-sheet montage so the previews render INLINE in chat — viewable over
      // remote-access where opening the local HTML in a browser isn't possible.
      const sheet = montage(cards.map((c, i) => ({ img: c.rgba, label: String(i + 1) })));
      const montagePath = join(outDir, "montage.png");
      await writeFile(montagePath, sheet).catch(() => {});

      const legend = cards
        .map((c, i) => `  ${String(i + 1).padStart(2)}. ${c.rgba ? "🖼" : c.glb ? "🧊" : "·"} ${c.name}  (${c.game})${c.note ? "  — " + c.note : ""}`)
        .join("\n");
      const summary =
        `Preview "${query}": ${cards.length} asset(s) — ${pngN} image(s)${glbN ? `, ${glbN} model(s)` : ""}. ` +
        `Contact sheet below (numbered); models (🧊) are 3D — open the HTML gallery to rotate them.\n` +
        `Gallery: ${htmlPath}\n${legend}`;

      return {
        content: [
          { type: "text", text: summary },
          { type: "image", data: sheet.toString("base64"), mimeType: "image/png" },
        ],
        structuredContent: {
          query,
          outDir,
          gallery: htmlPath,
          montage: montagePath,
          count: cards.length,
          images: pngN,
          models: glbN,
          cards: cards.map(({ rgba, ...c }) => c), // drop raw pixels from structured output
        },
      };
    }),
  );

  server.registerTool(
    "sound_preview",
    {
      title: "Preview sounds (out of engine, with a player)",
      description:
        "Audition sound assets WITHOUT launching Dota. Searches the downloaded games for matching sounds (.vsnd), " +
        "decodes them to WAV with ValveResourceFormat, RENDERS each waveform as an image (returned inline so you can " +
        "SEE the sounds over remote-access) and builds an HTML SOUNDBOARD with a real <audio> player per sound. Small " +
        "sounds are also embedded inline as playable audio. e.g. sound_preview query=\"explosion\". First run " +
        "auto-installs the decoder (~100MB, Windows).",
      inputSchema: {
        query: z.string().describe("Name substring, e.g. 'explosion', 'coin', 'levelup', 'hit'."),
        id: z.string().optional().describe("Restrict to one game id."),
        limit: z.number().int().positive().max(24).optional().describe("Max sounds to decode (default 8; higher = slower/heavier)."),
      },
    },
    guard(async ({ query, id, limit }): Promise<ToolResult> => {
      const cap = limit ?? 8;
      const matches = await findFiles(query, { ext: "vsnd_c", id, limit: cap });
      if (!matches.length) {
        return error(`No sounds matching "${query}" in the downloaded games. (Download more with workshop_download, or try ref_find ext="vsnd_c".)`);
      }
      await ensureVrf();

      const outDir = join(homedir(), ".dota2-workshop-mcp", "previews", "snd-" + slug(query));
      await rm(outDir, { recursive: true, force: true }).catch(() => {});
      await mkdir(outDir, { recursive: true });

      const MAX_INLINE_AUDIO = 6; // cap heavy base64 audio blocks in the chat payload
      const MAX_EMBED_BYTES = 1_400_000; // don't embed huge music loops as data-uris
      const sounds: Sound[] = [];
      let inlineAudio = 0;
      for (const m of matches.slice(0, cap)) {
        const vpk = await resolveVpk(m.id);
        if (!vpk) continue;
        const name = m.path.split("/").pop()!.replace(/\.\w+_c$/, "");
        const snd: Sound = { id: m.id, game: m.title, name, path: m.path };
        try {
          const out = await vrfDecode(vpk, m.path, join(outDir, "_d"));
          const audio = out.find((f) => /\.(wav|mp3)$/i.test(f));
          if (!audio) {
            snd.note = "decode produced no audio";
          } else {
            const buf = await readFile(audio);
            snd.bytes = buf.length;
            const { format, mime } = detectAudio(buf);
            snd.format = format;
            snd.mime = mime;
            const fileExt = format === "wav" ? "wav" : format === "mp3" ? "mp3" : "bin";
            await copyFile(audio, join(outDir, `sound_${sounds.length}.${fileExt}`)).catch(() => {});
            // Visual tile: a real amplitude waveform for PCM, a speaker icon for MP3.
            let tile: Rgba;
            if (format === "wav") {
              try {
                const info = parseWav(buf);
                snd.durationSec = info.durationSec;
                tile = renderWaveform(info.samples, { width: 320, height: 96 });
              } catch (e) {
                tile = speakerTile({ width: 320, height: 96 });
                snd.note = `waveform failed: ${e instanceof Error ? e.message : e}`;
              }
            } else {
              if (format === "mp3") snd.durationSec = mp3DurationSec(buf) || undefined;
              tile = speakerTile({ width: 320, height: 96 });
            }
            snd.wave = tile;
            snd.waveUri = "data:image/png;base64," + encodeRgbaPng(tile.width, tile.height, tile.rgba).toString("base64");
            if (buf.length <= MAX_EMBED_BYTES) snd.audioUri = `data:${mime};base64,` + buf.toString("base64");
          }
        } catch (e) {
          snd.note = `decode failed: ${e instanceof Error ? e.message : e}`;
        }
        sounds.push(snd);
      }
      await rm(join(outDir, "_d"), { recursive: true, force: true }).catch(() => {});

      const htmlPath = join(outDir, "soundboard.html");
      await writeFile(htmlPath, soundboardHtml(query, sounds), "utf8");

      // Stack the waveforms into one tall montage so the sounds are VISIBLE inline.
      const sheet = montage(
        sounds.map((s, i) => ({ img: s.wave, label: String(i + 1) })),
        { cell: 320, cols: 1, pad: 6 },
      );
      await writeFile(join(outDir, "waveforms.png"), sheet).catch(() => {});

      const decoded = sounds.filter((s) => s.wave).length;
      const wavCount = sounds.filter((s) => s.format === "wav").length;
      const mp3Count = sounds.filter((s) => s.format === "mp3").length;
      const legend = sounds
        .map((s, i) => `  ${String(i + 1).padStart(2)}. ${s.wave ? "🔊" : "·"} ${s.name}  (${s.game})${s.format ? " · " + s.format.toUpperCase() : ""}${s.durationSec ? " · " + fmtDuration(s.durationSec) : ""}${s.note ? "  — " + s.note : ""}`)
        .join("\n");
      const summary =
        `Sound preview "${query}": ${sounds.length} sound(s), ${decoded} decoded` +
        `${mp3Count ? ` (${wavCount} PCM waveform, ${mp3Count} MP3 → speaker icon, can't waveform MP3 out-of-engine)` : ""}. ` +
        `Tiles below (numbered). Playable audio is inlined for the first few; the HTML soundboard plays them all.\n` +
        `Soundboard: ${htmlPath}\n${legend}`;

      const content: ToolResult["content"] = [
        { type: "text", text: summary },
        { type: "image", data: sheet.toString("base64"), mimeType: "image/png" },
      ];
      // Inline playable audio for the first few small sounds (clients that render audio).
      for (const s of sounds) {
        if (inlineAudio >= MAX_INLINE_AUDIO) break;
        if (s.audioUri && s.mime) {
          content.push({ type: "audio", data: s.audioUri.split(",")[1], mimeType: s.mime });
          inlineAudio++;
        }
      }

      return {
        content,
        structuredContent: {
          query,
          outDir,
          soundboard: htmlPath,
          count: sounds.length,
          decoded,
          sounds: sounds.map(({ wave, audioUri, waveUri, ...s }) => s), // drop heavy blobs/pixels
        },
      };
    }),
  );
}
