// Real transparency for the ChatGPT-account path, since the Codex `image_generation` tool flatly
// rejects background:transparent (verified live across gpt-5.5 / gpt-image-1.5 / gpt-image-2). The
// official OpenAI imagegen skill uses the same workaround: generate the subject on a flat green
// screen, then key it out locally. This is a TS port of that skill's remove_chroma_key.py matte —
// a SOFT matte (smoothstep alpha ramp) combined with a key-channel DOMINANCE alpha and despill, for
// clean anti-aliased edges on glows. We decode the PNG to raw RGBA with ffmpeg, matte in JS, and
// re-encode with the bundled PNG encoder (no extra deps). Best for ISOLATED subjects.
import { ensureFfmpeg } from "../dota/ffmpeg.js";
import { run } from "../dota/process.js";
import { encodeRgbaPng } from "../util/png.js";
import { pngSize } from "./imageops.js";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Appended to the user's prompt when transparency is requested, to force a keyable background.
export const GREEN_SCREEN_SUFFIX =
  " Place the single subject centered and fully visible, isolated on a perfectly flat uniform solid " +
  "chroma-green background (RGB 0,255,0). Fill the entire background edge-to-edge with that exact green. " +
  "No gradient, no vignette, no shadow, no reflection, no extra elements.";

type RGB = [number, number, number];

// Channels that carry the key colour (e.g. green for a green screen) — used for spill math.
function spillChannels(key: RGB): number[] {
  const keyMax = Math.max(key[0], key[1], key[2]);
  if (keyMax < 128) return [];
  const out: number[] = [];
  for (let i = 0; i < 3; i++) if (key[i] >= keyMax - 16 && key[i] >= 128) out.push(i);
  return out;
}
function smoothstep(v: number): number {
  v = v < 0 ? 0 : v > 1 ? 1 : v;
  return v * v * (3 - 2 * v);
}

export interface KnockoutResult {
  png: Buffer; // RGBA PNG with the background removed
  keyHex: string; // the sampled key colour
  avgAlpha: number; // 0..255 mean alpha (sanity signal)
}

/** Knock out a (near-pure-green) background → RGBA PNG with a soft, despilled matte. Throws if it isn't a green screen. */
export async function knockoutGreenScreen(
  srcPng: Buffer,
  opts: { transparentThreshold?: number; opaqueThreshold?: number } = {},
): Promise<KnockoutResult> {
  const tT = opts.transparentThreshold ?? 12; // distance ≤ this ⇒ fully transparent
  const oT = opts.opaqueThreshold ?? 200; // distance ≥ this ⇒ fully opaque (soft ramp between)
  const ff = await ensureFfmpeg();
  const size = pngSize(srcPng);
  if (!size) throw new Error("knockout: source is not a PNG");
  const { width, height } = size;
  const dir = await mkdtemp(join(tmpdir(), "mcp-chroma-"));
  const inP = join(dir, "in.png");
  const rawP = join(dir, "rgba.raw");
  try {
    await writeFile(inP, srcPng);
    // run() returns stdout as a (binary-unsafe) string, so decode to a raw file and read the bytes.
    const dec = await run(ff, ["-y", "-i", inP, "-f", "rawvideo", "-pix_fmt", "rgba", rawP], { maxOutputChars: 4000 });
    if (dec.code !== 0) throw new Error("knockout decode failed: " + (dec.stderr || dec.stdout).slice(-200));
    const px = await readFile(rawP);
    if (px.length < width * height * 4) throw new Error("knockout: short raw buffer");

    const key = sampleCornerKey(px, width, height);
    const keyHex = "0x" + key.map((v) => v.toString(16).padStart(2, "0")).join("");
    // Guard: if the corners aren't clearly green, the model didn't give us a green screen — bail loudly.
    if (!(key[1] > 140 && key[0] < 130 && key[2] < 130)) {
      throw new Error(`background isn't a clean green screen (corner ${keyHex}) — can't isolate it. Try a simpler/single subject, or regenerate.`);
    }
    const sp = spillChannels(key);
    const isSpill = [sp.includes(0), sp.includes(1), sp.includes(2)];
    const nonSp = [0, 1, 2].filter((i) => !isSpill[i]);
    const keyMax = Math.max(key[0], key[1], key[2]);
    const chanOf = (r: number, g: number, b: number, i: number) => (i === 0 ? r : i === 1 ? g : b);
    const keyStrength = (r: number, g: number, b: number) => {
      if (sp.length > 1) {
        let m = 255;
        for (const i of sp) m = Math.min(m, chanOf(r, g, b, i));
        return m;
      }
      return chanOf(r, g, b, sp[0]);
    };
    const nonKeyStrength = (r: number, g: number, b: number) => {
      let m = 0;
      for (const i of nonSp) m = Math.max(m, chanOf(r, g, b, i));
      return m;
    };

    const out = Buffer.allocUnsafe(width * height * 4);
    let alphaSum = 0;
    const n = width * height;
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      let r = px[i], g = px[i + 1], b = px[i + 2];
      const a0 = px[i + 3];
      const d = Math.max(Math.abs(r - key[0]), Math.abs(g - key[1]), Math.abs(b - key[2]));
      // Only green-dominant pixels are matted; everything else stays opaque (protects the subject).
      const dom = sp.length ? keyStrength(r, g, b) - nonKeyStrength(r, g, b) : 0;
      const keyLike = d <= 32 || dom >= 16;
      let alpha: number;
      if (!keyLike) {
        alpha = 255;
      } else {
        const soft = d <= tT ? 0 : d >= oT ? 255 : Math.round(255 * smoothstep((d - tT) / (oT - tT)));
        let domA = 255;
        if (sp.length && dom > 0) {
          const denom = Math.max(1, keyMax - nonKeyStrength(r, g, b));
          domA = Math.round((1 - Math.min(1, dom / denom)) * 255);
        }
        alpha = Math.min(soft, domA);
      }
      alpha = Math.round(alpha * (a0 / 255));
      if (alpha > 0 && alpha <= 8) alpha = 0; // noise floor
      if (alpha === 0) {
        out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0;
        continue;
      }
      // Despill: pull the key channel(s) down to the strongest non-key channel on partial pixels.
      if (keyLike && alpha < 252 && sp.length && nonSp.length) {
        const cap = Math.max(0, nonKeyStrength(r, g, b) - 1);
        if (isSpill[0] && r > cap) r = cap;
        if (isSpill[1] && g > cap) g = cap;
        if (isSpill[2] && b > cap) b = cap;
      }
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = alpha;
      alphaSum += alpha;
    }
    return { png: encodeRgbaPng(width, height, out), keyHex, avgAlpha: Math.round(alphaSum / n) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Median RGB across the four corner patches — robust to a little noise in the flat background.
function sampleCornerKey(px: Buffer, w: number, h: number): RGB {
  const p = Math.max(1, Math.min(w, h, 12));
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  for (const [x0, y0] of [[0, 0], [w - p, 0], [0, h - p], [w - p, h - p]]) {
    for (let y = y0; y < y0 + p; y++) {
      for (let x = x0; x < x0 + p; x++) {
        const i = (y * w + x) * 4;
        rs.push(px[i]); gs.push(px[i + 1]); bs.push(px[i + 2]);
      }
    }
  }
  const med = (a: number[]) => (a.sort((x, y) => x - y), a[a.length >> 1]);
  return [med(rs), med(gs), med(bs)];
}
