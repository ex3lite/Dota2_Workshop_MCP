// Assemble an interactive preview gallery directory from the downloaded games: decode a mix
// of particles / models / sounds / textures out-of-engine and lay them out as files that the
// static server (serve.ts) hosts and the gallery page (gallery.ts) renders. Returns the dir
// + the GalleryData so callers can serve it and/or tunnel it.

import { homedir } from "node:os";
import { join, relative, sep, dirname } from "node:path";
import { readFile, writeFile, mkdir, rm, copyFile } from "node:fs/promises";
import { pathExists } from "../util/fsx.js";
import { findFiles, resolveVpk } from "./reflib.js";
import { ensureVrf, vrfDecode, vrfDecompileText } from "./vrf.js";
import { requireDotaPaths } from "./paths.js";
import { parseVpcf } from "./vpcf.js";
import { parseWav, mp3DurationSec, detectAudio, fmtDuration } from "../util/waveform.js";
import { buildGalleryHtml, ENGINE_JS, GalleryData, MODEL_VIEWER_VERSION, MODEL_VIEWER_CDN } from "./gallery.js";

const FALLBACK = ["explosion", "fire", "spark", "magic", "smoke", "blood", "lightning", "tower", "hit", "ui", "gold"];
const texRefs = (t: string) => [...new Set([...t.matchAll(/"([^"]*\.vtex)"/g)].map((m) => m[1]))];

// Self-host <model-viewer> so the 3D viewer works without reaching an external CDN (googleapis
// is often blocked/slow in some regions, leaving model cards blank). Download once + cache,
// then copy into the gallery dir. Returns the <script src> to use (local, or CDN fallback).
async function ensureModelViewer(destDir: string): Promise<string> {
  const cache = join(homedir(), ".dota2-workshop-mcp", "assets", `model-viewer-${MODEL_VIEWER_VERSION}.min.js`);
  if (!(await pathExists(cache))) {
    const urls = [
      MODEL_VIEWER_CDN,
      `https://cdn.jsdelivr.net/npm/@google/model-viewer@${MODEL_VIEWER_VERSION}/dist/model-viewer.min.js`,
      `https://unpkg.com/@google/model-viewer@${MODEL_VIEWER_VERSION}/dist/model-viewer.min.js`,
    ];
    await mkdir(dirname(cache), { recursive: true });
    for (const url of urls) {
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 50_000) { await writeFile(cache, buf); break; } // sanity: real bundle is ~MBs
      } catch { /* try next mirror */ }
    }
  }
  if (await pathExists(cache)) {
    await copyFile(cache, join(destDir, "model-viewer.min.js")).catch(() => {});
    return "model-viewer.min.js";
  }
  return MODEL_VIEWER_CDN; // couldn't fetch — fall back to CDN (works where it's reachable)
}

export interface StudioOptions {
  query?: string;
  id?: string;
  particles?: number;
  models?: number;
  sounds?: number;
  textures?: number;
  title?: string;
}

export interface ManifestEntry {
  id: string; // P1 / M1 / S1 / T1 — the badge shown in the gallery
  kind: "particle" | "model" | "sound" | "texture";
  name: string;
  game: string;
  gameId: string; // workshop id the asset came from
  path: string; // original VPK inner path (.vpcf_c / .vmdl_c / .vsnd_c / .vtex_c)
  file: string; // served gallery file (relative)
}

export interface StudioResult {
  dir: string;
  data: GalleryData;
  manifest: ManifestEntry[];
  counts: { particles: number; models: number; sounds: number; textures: number };
}

async function gather(ext: string, query: string | undefined, id: string | undefined, n: number) {
  const queries = query ? [query, ...FALLBACK] : FALLBACK;
  const out: { id: string; title: string; path: string }[] = [];
  const seen = new Set<string>();
  for (const q of queries) {
    if (out.length >= n * 3) break;
    for (const h of await findFiles(q, { ext, id, limit: n * 3 })) {
      if (seen.has(h.id + h.path)) continue;
      seen.add(h.id + h.path);
      out.push(h);
    }
  }
  return out;
}

/** Build the gallery directory; returns its path + the data used to render it. */
export async function buildStudioGallery(opts: StudioOptions = {}): Promise<StudioResult> {
  const want = {
    particles: opts.particles ?? 10,
    models: opts.models ?? 8,
    sounds: opts.sounds ?? 10,
    textures: opts.textures ?? 10,
  };
  await ensureVrf();
  const dir = join(homedir(), ".dota2-workshop-mcp", "previews", "_studio");
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  await mkdir(join(dir, "_d"), { recursive: true });
  const basePak = (await requireDotaPaths().catch(() => null))?.pak01DirVpk;
  let dn = 0;
  const dd = () => join(dir, "_d", String(dn++));

  const data: GalleryData = {
    title: opts.title || `Asset preview${opts.query ? ` — "${opts.query}"` : ""}`,
    particles: [],
    models: [],
    sounds: [],
    textures: [],
  };
  const manifest: ManifestEntry[] = [];

  // --- particles: parse spec + decode the sprite (dedupe by sprite for variety) ---
  {
    const cands = await gather("vpcf_c", opts.query, opts.id, want.particles);
    const usedSprite = new Set<string>();
    const usedName = new Set<string>();
    for (const h of cands) {
      if (data.particles.length >= want.particles) break;
      const name = h.path.split("/").pop()!.replace(/\.\w+_c$/, "");
      if (usedName.has(name)) continue; // don't show the same effect name 3×
      const vpk = await resolveVpk(h.id);
      if (!vpk) continue;
      const text = await vrfDecompileText(vpk, h.path).catch(() => undefined);
      if (!text) continue;
      const spec = parseVpcf(text);
      let spriteRel: string | undefined;
      let allDup = false;
      const refs = [...new Set([spec.sprite, ...texRefs(text)].filter(Boolean) as string[])].slice(0, 3);
      for (const ref of refs) {
        const base = ref.split("/").pop()!;
        if (usedSprite.has(base)) { allDup = true; continue; } // try a different ref
        for (const src of [vpk, basePak].filter(Boolean) as string[]) {
          const produced = await vrfDecode(src, ref, dd()).catch(() => [] as string[]);
          const png = produced.find((f) => f.endsWith(".png"));
          if (png) {
            const rel = `sprite_${data.particles.length}.png`;
            await copyFile(png, join(dir, rel)).catch(() => {});
            spriteRel = rel;
            usedSprite.add(base);
            break;
          }
        }
        if (spriteRel) break;
      }
      if (!spriteRel && allDup) continue; // pure duplicate of an effect we already show
      usedName.add(name);
      const id = `P${data.particles.length + 1}`;
      data.particles.push({ id, name, game: h.title, sprite: spriteRel, spec });
      manifest.push({ id, kind: "particle", name, game: h.title, gameId: h.id, path: h.path, file: spriteRel || "" });
    }
  }

  // --- models -> glb (with embedded/sibling textures) ---
  {
    const cands = await gather("vmdl_c", opts.query, opts.id, want.models);
    for (const h of cands) {
      if (data.models.length >= want.models) break;
      const vpk = await resolveVpk(h.id);
      if (!vpk) continue;
      const i = data.models.length;
      // Decode into a KEPT per-model dir: VRF emits the .glb plus its textures as sibling
      // .png files the glb references by relative uri — they must travel together and be served.
      const mdir = join(dir, `m${i}`);
      const produced = await vrfDecode(vpk, h.path, mdir, { glb: true }).catch(() => [] as string[]);
      const glb = produced.find((f) => f.endsWith(".glb"));
      if (!glb) { await rm(mdir, { recursive: true, force: true }).catch(() => {}); continue; }
      const rel = `m${i}/` + relative(mdir, glb).split(sep).join("/");
      const name = h.path.split("/").pop()!.replace(/\.\w+_c$/, "");
      const id = `M${data.models.length + 1}`;
      data.models.push({ id, name, game: h.title, glb: rel });
      manifest.push({ id, kind: "model", name, game: h.title, gameId: h.id, path: h.path, file: rel });
    }
  }

  // --- sounds -> playable file + duration ---
  {
    const cands = await gather("vsnd_c", opts.query, opts.id, want.sounds);
    for (const h of cands) {
      if (data.sounds.length >= want.sounds) break;
      const vpk = await resolveVpk(h.id);
      if (!vpk) continue;
      const produced = await vrfDecode(vpk, h.path, dd()).catch(() => [] as string[]);
      const audio = produced.find((f) => /\.(wav|mp3)$/i.test(f));
      if (!audio) continue;
      const buf = await readFile(audio);
      const { format } = detectAudio(buf);
      const ext = format === "wav" ? "wav" : "mp3";
      const rel = `sound_${data.sounds.length}.${ext}`;
      await copyFile(audio, join(dir, rel)).catch(() => {});
      let dur = 0;
      try { dur = format === "wav" ? parseWav(buf).durationSec : mp3DurationSec(buf); } catch { /* unknown */ }
      const name = h.path.split("/").pop()!.replace(/\.\w+_c$/, "");
      const id = `S${data.sounds.length + 1}`;
      data.sounds.push({ id, name, game: h.title, src: rel, fmt: format.toUpperCase(), dur: fmtDuration(dur) });
      manifest.push({ id, kind: "sound", name, game: h.title, gameId: h.id, path: h.path, file: rel });
    }
  }

  // --- textures -> png ---
  {
    const cands = await gather("vtex_c", opts.query, opts.id, want.textures);
    for (const h of cands) {
      if (data.textures.length >= want.textures) break;
      const vpk = await resolveVpk(h.id);
      if (!vpk) continue;
      const produced = await vrfDecode(vpk, h.path, dd()).catch(() => [] as string[]);
      const png = produced.find((f) => f.endsWith(".png"));
      if (!png) continue;
      const rel = `tex_${data.textures.length}.png`;
      await copyFile(png, join(dir, rel)).catch(() => {});
      const name = h.path.split("/").pop()!.replace(/\.\w+_c$/, "");
      const id = `T${data.textures.length + 1}`;
      data.textures.push({ id, name, game: h.title, src: rel });
      manifest.push({ id, kind: "texture", name, game: h.title, gameId: h.id, path: h.path, file: rel });
    }
  }

  data.modelViewerSrc = await ensureModelViewer(dir);
  await writeFile(join(dir, "engine.js"), ENGINE_JS, "utf8");
  await writeFile(join(dir, "index.html"), buildGalleryHtml(data), "utf8");
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  await rm(join(dir, "_d"), { recursive: true, force: true }).catch(() => {});

  return {
    dir,
    data,
    manifest,
    counts: { particles: data.particles.length, models: data.models.length, sounds: data.sounds.length, textures: data.textures.length },
  };
}
