// Quality validation + compression for generated images, all via ffmpeg (already a project dep).
// Validation catches blank/failed generations and checks that a transparent result actually keyed
// out (background gone, subject preserved). Compression downscales + re-encodes — the real size win
// for an optimized Dota project, since Panorama/VTEX compile a PNG/JPG into a GPU texture whose cost
// is driven by DIMENSIONS. (VTEX/Panorama accept png/jpg/tga/psd/tif — NOT webp; webp is external-only.)
import { ensureFfmpeg } from "../dota/ffmpeg.js";
import { run } from "../dota/process.js";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageFormat } from "./chatgpt.js";

/** Read width/height straight from a PNG's IHDR (no decode). */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function mimeForFormat(format: ImageFormat): string {
  return format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-img-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface GenQuality {
  lumaRange: number; // 0..255 spread of brightness — tiny ⇒ flat/blank
  lumaStd: number;
  blank: boolean; // looks like a failed (near-uniform) generation
}

/** Cheap "did the generation actually produce something" check (downscale to 64² gray, look at spread). */
export async function assessGeneration(buf: Buffer): Promise<GenQuality> {
  const ff = await ensureFfmpeg();
  return withTemp(async (dir) => {
    const inP = join(dir, "in.png");
    const raw = join(dir, "g.raw");
    await writeFile(inP, buf);
    await run(ff, ["-y", "-i", inP, "-vf", "scale=64:64,format=gray", "-f", "rawvideo", "-pix_fmt", "gray", raw]);
    const g = await readFile(raw);
    let min = 255, max = 0, sum = 0, sum2 = 0;
    for (const v of g) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      sum2 += v * v;
    }
    const n = g.length || 1;
    const mean = sum / n;
    const lumaStd = Math.round(Math.sqrt(Math.max(0, sum2 / n - mean * mean)));
    const lumaRange = max - min;
    return { lumaRange, lumaStd, blank: lumaRange < 16 || lumaStd < 5 };
  });
}

export interface TransQuality {
  cornerAlpha: number; // 0..255 mean alpha in the corners — should be ~0 when keyed
  opaquePct: number; // % of pixels that are opaque (the subject)
  warnings: string[];
}

/** Validate a transparent result: background removed at the corners, subject not over/under-keyed. */
export async function assessTransparency(buf: Buffer): Promise<TransQuality> {
  const ff = await ensureFfmpeg();
  return withTemp(async (dir) => {
    const inP = join(dir, "in.png");
    const raw = join(dir, "a.raw");
    await writeFile(inP, buf);
    // alphaextract MUST come before scale — scaling first can negotiate away the alpha plane.
    await run(ff, ["-y", "-i", inP, "-vf", "alphaextract,scale=64:64", "-f", "rawvideo", "-pix_fmt", "gray", raw]);
    const a = await readFile(raw).catch(() => Buffer.alloc(0));
    const W = 64;
    if (a.length < W * W) {
      // No alpha plane → alphaextract produced nothing → the image is fully opaque.
      return { cornerAlpha: 255, opaquePct: 100, warnings: ["the image came back fully opaque (no transparency) — the model didn't honor the transparent request; retry or use engine='codex'."] };
    }
    let opaque = 0;
    for (const v of a) if (v > 128) opaque++;
    const opaquePct = Math.round((100 * opaque) / (a.length || 1));
    const block = (x0: number, y0: number) => {
      let s = 0;
      for (let y = y0; y < y0 + 8; y++) for (let x = x0; x < x0 + 8; x++) s += a[y * W + x];
      return s / 64;
    };
    const cornerAlpha = Math.round((block(0, 0) + block(W - 8, 0) + block(0, W - 8) + block(W - 8, W - 8)) / 4);
    const warnings: string[] = [];
    if (cornerAlpha > 40) warnings.push(`background may not be fully removed (corner alpha ${cornerAlpha}/255)`);
    if (opaquePct < 2) warnings.push(`almost nothing is opaque (${opaquePct}%) — the subject may have been keyed away`);
    if (opaquePct > 98) warnings.push(`almost nothing was removed (${opaquePct}% opaque) — was the background a clean green screen?`);
    return { cornerAlpha, opaquePct, warnings };
  });
}

export interface OptimizeOpts {
  maxSize?: number; // cap the longest side (keeps aspect) — the main size lever
  quality?: number; // 1..100 for lossy webp/jpeg; omit ⇒ lossless (webp) / png
  format: ImageFormat;
}
export interface OptimizeResult {
  buffer: Buffer;
  width: number;
  height: number;
  mimeType: string;
  format: ImageFormat;
}

/** Downscale and/or re-encode to the target format. */
export async function optimizeImage(buf: Buffer, opts: OptimizeOpts): Promise<OptimizeResult> {
  const ff = await ensureFfmpeg();
  const { maxSize, quality, format } = opts;
  return withTemp(async (dir) => {
    const ext = format === "jpeg" ? "jpg" : format;
    const inP = join(dir, "in.png");
    const outP = join(dir, `out.${ext}`);
    await writeFile(inP, buf);
    const args = ["-y", "-i", inP];
    if (maxSize && maxSize > 0) {
      args.push("-vf", `scale=w='min(${maxSize},iw)':h='min(${maxSize},ih)':force_original_aspect_ratio=decrease`);
    }
    if (format === "png") {
      args.push("-c:v", "png");
    } else if (format === "webp") {
      args.push("-c:v", "libwebp", "-compression_level", "6");
      if (quality == null) args.push("-lossless", "1");
      else args.push("-lossless", "0", "-quality", String(quality));
    } else {
      // jpeg: map quality 1..100 → mjpeg qscale 31(worst)..2(best)
      const q = quality == null ? 90 : quality;
      const qscale = Math.max(2, Math.min(31, Math.round(31 - (q / 100) * 29)));
      args.push("-c:v", "mjpeg", "-q:v", String(qscale));
    }
    args.push(outP);
    const r = await run(ff, args, { maxOutputChars: 4000 });
    if (r.code !== 0) throw new Error("image optimize failed: " + (r.stderr || r.stdout).slice(-300));
    const out = await readFile(outP);
    let dims = await probeSize(ff, outP).catch(() => null);
    if (!dims) {
      const s = pngSize(buf);
      dims = s ? scaleDims(s, maxSize) : { width: 0, height: 0 };
    }
    return { buffer: out, width: dims.width, height: dims.height, mimeType: mimeForFormat(format), format };
  });
}

function scaleDims(s: { width: number; height: number }, maxSize?: number) {
  if (!maxSize || Math.max(s.width, s.height) <= maxSize) return s;
  const f = maxSize / Math.max(s.width, s.height);
  return { width: Math.round(s.width * f), height: Math.round(s.height * f) };
}

async function probeSize(ffmpegPath: string, file: string): Promise<{ width: number; height: number }> {
  const ffprobe = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (_m, e) => "ffprobe" + (e || ""));
  const r = await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", file], { timeoutMs: 15000 });
  const m = (r.stdout || "").trim().match(/(\d+)x(\d+)/);
  if (!m) throw new Error("ffprobe size failed");
  return { width: +m[1], height: +m[2] };
}

/** Load an image file and normalise it to a PNG buffer no larger than `maxSize` (for sending as edit input). */
export async function loadImageAsPng(path: string, maxSize = 1024): Promise<Buffer> {
  const raw = await readFile(path);
  const opt = await optimizeImage(raw, { maxSize, format: "png" });
  return opt.buffer;
}
