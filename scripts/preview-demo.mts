// One-off DEMO: reproduces what asset_preview / sound_preview return, against the real
// downloaded library, and writes the artifacts to a demo dir so they can be shown.
// Run: npx tsx scripts/preview-demo.mts
import { findFiles, resolveVpk } from "../src/dota/reflib.js";
import { ensureVrf, vrfDecode, vrfDecompileText } from "../src/dota/vrf.js";
import { requireDotaPaths } from "../src/dota/paths.js";
import { decodePng, montage } from "../src/util/imgmontage.js";
import { parseWav, renderWaveform, speakerTile, detectAudio, mp3DurationSec, fmtDuration } from "../src/util/waveform.js";
import { encodeRgbaPng } from "../src/util/png.js";
import { readFile, writeFile, mkdir, rm, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const OUT = join(homedir(), ".dota2-workshop-mcp", "previews", "_demo");
await rm(OUT, { recursive: true, force: true }).catch(() => {});
await mkdir(OUT, { recursive: true });
await ensureVrf();
const basePak = (await requireDotaPaths().catch(() => null))?.pak01DirVpk;

async function gather(ext: string, queries: string[], n: number) {
  const out: { id: string; title: string; path: string }[] = [];
  const seen = new Set<string>();
  for (const q of queries) {
    if (out.length >= n) break;
    for (const h of await findFiles(q, { ext, limit: n * 2 })) {
      if (out.length >= n) break;
      if (seen.has(h.id + h.path)) continue;
      seen.add(h.id + h.path);
      out.push(h);
    }
  }
  return out.slice(0, n);
}
const texRefs = (t: string) => [...new Set([...t.matchAll(/"([^"]*\.vtex)"/g)].map((m) => m[1]))];
async function pngToRgba(p: string) { try { return decodePng(await readFile(p)); } catch { return undefined; } }
let ddN = 0;
const ddir = () => join(OUT, "_d", String(ddN++)); // per-asset subdir so shared sprites still render

const result: Record<string, unknown> = {};

// ---- TEXTURES ----
{
  const hits = await gather("vtex_c", ["fire", "spark", "icon"], 8);
  const cells: { img?: ReturnType<typeof decodePng>; label: string }[] = [];
  const legend: string[] = [];
  for (const h of hits) {
    const vpk = await resolveVpk(h.id); if (!vpk) continue;
    const out = await vrfDecode(vpk, h.path, ddir()).catch(() => []);
    const png = out.find((f) => f.endsWith(".png"));
    const rgba = png ? await pngToRgba(png) : undefined;
    cells.push({ img: rgba, label: String(cells.length + 1) });
    legend.push(`${cells.length}. ${h.path.split("/").pop()} (${h.title})`);
  }
  const sheet = montage(cells.map((c) => ({ img: c.img, label: c.label })));
  await writeFile(join(OUT, "textures.png"), sheet);
  result.textures = { png: join(OUT, "textures.png"), count: cells.length, legend };
}

// ---- PARTICLES (show the sprite texture each particle uses; dedupe by sprite) ----
{
  const candidates = await gather("vpcf_c", ["explosion", "spark", "fire", "blood", "lightning", "smoke", "flame"], 40);
  const cells: { img?: ReturnType<typeof decodePng>; label: string }[] = [];
  const legend: string[] = [];
  const usedSprite = new Set<string>();
  for (const h of candidates) {
    if (cells.length >= 6) break;
    const vpk = await resolveVpk(h.id); if (!vpk) continue;
    const text = await vrfDecompileText(vpk, h.path).catch(() => undefined);
    const refs = text ? texRefs(text) : [];
    let rgba: ReturnType<typeof decodePng> | undefined; let usedRef = "";
    for (const ref of refs.slice(0, 3)) {
      const sprite = ref.split("/").pop()!;
      if (usedSprite.has(sprite)) continue; // show variety, not the same flare 4×
      for (const src of [vpk, basePak].filter(Boolean) as string[]) {
        const out = await vrfDecode(src, ref, ddir()).catch(() => []);
        const png = out.find((f) => f.endsWith(".png"));
        if (png) { rgba = await pngToRgba(png); usedRef = sprite; break; }
      }
      if (rgba) break;
    }
    if (!rgba) continue; // only show particles whose sprite we could actually decode
    usedSprite.add(usedRef);
    cells.push({ img: rgba, label: String(cells.length + 1) });
    legend.push(`${cells.length}. ${h.path.split("/").pop()} (${h.title}) → ${usedRef}`);
  }
  const sheet = montage(cells.map((c) => ({ img: c.img, label: c.label })));
  await writeFile(join(OUT, "particles.png"), sheet);
  result.particles = { png: join(OUT, "particles.png"), count: cells.length, legend };
}

// ---- MODELS (decode to GLB; viewable as interactive 3D in the HTML gallery) ----
const modelCards: { name: string; glb: string; title: string }[] = [];
{
  const hits = await gather("vmdl_c", ["tower", "creep", "hero"], 4);
  let n = 0;
  for (const h of hits) {
    const vpk = await resolveVpk(h.id); if (!vpk) continue;
    const out = await vrfDecode(vpk, h.path, ddir(), { glb: true }).catch(() => []);
    const glb = out.find((f) => f.endsWith(".glb"));
    if (glb) { const rel = `model_${n++}.glb`; await copyFile(glb, join(OUT, rel)).catch(() => {}); modelCards.push({ name: h.path.split("/").pop()!.replace(/\.\w+_c$/, ""), glb: rel, title: h.title }); }
  }
  result.models = { count: modelCards.length, files: modelCards.map((m) => m.glb) };
}

// ---- SOUNDS (waveform/speaker tile inline + playable soundboard) ----
const soundRows: { name: string; title: string; uri?: string; mime?: string; fmt: string; dur: string }[] = [];
{
  const hits = await gather("vsnd_c", ["explosion", "hit", "ui"], 6);
  const cells: { img?: ReturnType<typeof decodePng> | ReturnType<typeof speakerTile>; label: string }[] = [];
  const legend: string[] = [];
  for (const h of hits) {
    const vpk = await resolveVpk(h.id); if (!vpk) continue;
    const out = await vrfDecode(vpk, h.path, ddir()).catch(() => []);
    const audio = out.find((f) => /\.(wav|mp3)$/i.test(f));
    if (!audio) continue;
    const buf = await readFile(audio);
    const { format, mime } = detectAudio(buf);
    let dur = 0; let tile;
    if (format === "wav") { const info = parseWav(buf); dur = info.durationSec; tile = renderWaveform(info.samples, { width: 320, height: 96 }); }
    else { dur = mp3DurationSec(buf); tile = speakerTile({ width: 320, height: 96 }); }
    cells.push({ img: tile, label: String(cells.length + 1) });
    const name = h.path.split("/").pop()!.replace(/\.\w+_c$/, "");
    legend.push(`${cells.length}. ${name} (${h.title}) · ${format.toUpperCase()} · ${fmtDuration(dur)}`);
    soundRows.push({ name, title: h.title, uri: buf.length <= 1_400_000 ? `data:${mime};base64,` + buf.toString("base64") : undefined, mime, fmt: format, dur: fmtDuration(dur) });
  }
  const sheet = montage(cells.map((c) => ({ img: c.img as any, label: c.label })), { cell: 320, cols: 1, pad: 6 });
  await writeFile(join(OUT, "sounds.png"), sheet);
  result.sounds = { png: join(OUT, "sounds.png"), count: cells.length, legend };
}

// ---- combined HTML gallery (textures+particles inline, models as 3D) + soundboard ----
const galleryHtml = `<!doctype html><meta charset=utf-8><title>Preview demo</title>
<script type=module src="https://ajax.googleapis.com/ajax/libs/model-viewer/3.5.0/model-viewer.min.js"></script>
<style>body{background:#0d1017;color:#cdd3e0;font:14px system-ui;margin:0;padding:16px}
h2{margin:18px 0 8px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
.card{background:#161b27;border:1px solid #222b3d;border-radius:8px;overflow:hidden}
.card img{width:100%;display:block;background:#11141d}.nm{padding:6px 8px;font-weight:600}.mt{padding:0 8px 8px;color:#8b93a7;font-size:12px}
model-viewer{width:100%;height:220px;background:#11141d}</style>
<h1>Asset preview demo</h1>
<h2>Textures (decoded → PNG, shown inline)</h2><div class=grid><div class=card><img src="textures.png"><div class=nm>textures.png</div></div></div>
<h2>Particles (sprite texture each particle uses)</h2><div class=grid><div class=card><img src="particles.png"><div class=nm>particles.png</div></div></div>
<h2>Models (decoded → GLB, interactive 3D)</h2><div class=grid>
${modelCards.map((m) => `<div class=card><model-viewer src="${m.glb}" camera-controls auto-rotate disable-zoom></model-viewer><div class=nm>${m.name}</div><div class=mt>${m.title}</div></div>`).join("")}
</div>`;
await writeFile(join(OUT, "gallery.html"), galleryHtml);

const soundboardHtml = `<!doctype html><meta charset=utf-8><title>Soundboard demo</title>
<style>body{background:#0d1017;color:#cdd3e0;font:14px system-ui;margin:0;padding:16px}
.row{display:flex;gap:12px;align-items:center;background:#161b27;border:1px solid #222b3d;border-radius:8px;padding:8px 10px;margin-bottom:8px}
.nm{width:280px}.mt{color:#8b93a7;font-size:12px}audio{flex:1;max-width:380px}</style>
<h1>Sound preview demo — press play</h1>
${soundRows.map((s) => `<div class=row><div class=nm><b>${s.name}</b><div class=mt>${s.title} · ${s.fmt.toUpperCase()} · ${s.dur}</div></div>${s.uri ? `<audio controls preload=none src="${s.uri}"></audio>` : "<i>too large to embed</i>"}</div>`).join("")}`;
await writeFile(join(OUT, "soundboard.html"), soundboardHtml);
result.gallery = join(OUT, "gallery.html");
result.soundboard = join(OUT, "soundboard.html");

await rm(ddir(), { recursive: true, force: true }).catch(() => {});
console.log(JSON.stringify(result, null, 2));
