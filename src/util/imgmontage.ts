// Compose a contact-sheet montage PNG from decoded asset thumbnails — so previews can be
// returned INLINE in the chat (viewable over remote-access), not just as a local HTML file.
// Dependency-free: a minimal PNG decoder (8-bit, colour types 0/2/4/6) + nearest-neighbour
// resize + grid compositor + a tiny 3x5 digit font for per-cell index labels.

import { inflateSync } from "node:zlib";
import { encodeRgbaPng } from "./png.js";

export interface Rgba {
  width: number;
  height: number;
  rgba: Buffer; // width*height*4
}

/** Decode a PNG buffer to RGBA. Supports 8-bit grayscale/RGB/RGBA (+alpha), all filters. */
export function decodePng(buf: Buffer): Rgba {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let p = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  const idat: Buffer[] = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    p += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let ri = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[ri++];
    for (let x = 0; x < stride; x++) {
      const rawb = raw[ri++];
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v: number;
      switch (filter) {
        case 1: v = rawb + a; break;
        case 2: v = rawb + b; break;
        case 3: v = rawb + ((a + b) >> 1); break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v = rawb + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: v = rawb;
      }
      cur[x] = v & 0xff;
    }
    // expand channels -> RGBA
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      if (channels === 4) { out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = cur[s + 3]; }
      else if (channels === 3) { out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = 255; }
      else if (channels === 2) { out[d] = out[d + 1] = out[d + 2] = cur[s]; out[d + 3] = cur[s + 1]; }
      else { out[d] = out[d + 1] = out[d + 2] = cur[s]; out[d + 3] = 255; }
    }
    cur.copy(prev);
  }
  return { width, height, rgba: out };
}

/** Nearest-neighbour resize to fit within (maxW,maxH) preserving aspect. */
function fit(img: Rgba, maxW: number, maxH: number): Rgba {
  const scale = Math.min(maxW / img.width, maxH / img.height, 1);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  if (w === img.width && h === img.height) return img;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / scale));
      img.rgba.copy(out, (y * w + x) * 4, (sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4);
    }
  }
  return { width: w, height: h, rgba: out };
}

// 3x5 pixel digits (rows top->bottom, bits left->right of 3).
const DIGITS: Record<string, number[]> = {
  "0": [7, 5, 5, 5, 7], "1": [2, 6, 2, 2, 7], "2": [7, 1, 7, 4, 7], "3": [7, 1, 7, 1, 7],
  "4": [5, 5, 7, 1, 1], "5": [7, 4, 7, 1, 7], "6": [7, 4, 7, 5, 7], "7": [7, 1, 2, 2, 2],
  "8": [7, 5, 7, 5, 7], "9": [7, 5, 7, 1, 7],
};

function stamp(canvas: Buffer, cw: number, ox: number, oy: number, text: string, scale = 2): void {
  // dark plate behind the number for legibility
  const plateW = text.length * 4 * scale + 2, plateH = 5 * scale + 2;
  for (let y = 0; y < plateH; y++)
    for (let x = 0; x < plateW; x++) {
      const d = ((oy + y) * cw + (ox + x)) * 4;
      if (d >= 0 && d + 3 < canvas.length) { canvas[d] = 0; canvas[d + 1] = 0; canvas[d + 2] = 0; canvas[d + 3] = 200; }
    }
  let cx = ox + 1;
  for (const ch of text) {
    const g = DIGITS[ch];
    if (g) {
      for (let r = 0; r < 5; r++)
        for (let b = 0; b < 3; b++)
          if (g[r] & (1 << (2 - b)))
            for (let sy = 0; sy < scale; sy++)
              for (let sx = 0; sx < scale; sx++) {
                const px = cx + b * scale + sx, py = oy + 1 + r * scale + sy;
                const d = (py * cw + px) * 4;
                if (d >= 0 && d + 3 < canvas.length) { canvas[d] = 255; canvas[d + 1] = 230; canvas[d + 2] = 120; canvas[d + 3] = 255; }
              }
    }
    cx += 4 * scale;
  }
}

export interface MontageCell {
  img?: Rgba; // decoded thumbnail (omit for assets with no image)
  label: string; // index label, e.g. "1"
}

/** Build a grid contact-sheet PNG. Returns the encoded PNG buffer. */
export function montage(cells: MontageCell[], opts: { cell?: number; cols?: number; pad?: number } = {}): Buffer {
  const cell = opts.cell ?? 200;
  const pad = opts.pad ?? 8;
  const cols = opts.cols ?? Math.min(4, Math.max(1, Math.ceil(Math.sqrt(cells.length))));
  const rows = Math.ceil(cells.length / cols);
  const W = cols * cell + (cols + 1) * pad;
  const H = rows * cell + (rows + 1) * pad;
  const canvas = Buffer.alloc(W * H * 4);
  // dark background
  for (let i = 0; i < W * H; i++) { canvas[i * 4] = 13; canvas[i * 4 + 1] = 16; canvas[i * 4 + 2] = 23; canvas[i * 4 + 3] = 255; }
  cells.forEach((c, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x0 = pad + col * (cell + pad), y0 = pad + row * (cell + pad);
    // checkerboard tile so transparent sprites are visible
    for (let y = 0; y < cell; y++)
      for (let x = 0; x < cell; x++) {
        const on = (((x >> 4) + (y >> 4)) & 1) === 0;
        const d = ((y0 + y) * W + (x0 + x)) * 4;
        const g = on ? 30 : 22;
        canvas[d] = g; canvas[d + 1] = g + 3; canvas[d + 2] = g + 8; canvas[d + 3] = 255;
      }
    if (c.img) {
      const t = fit(c.img, cell, cell);
      const dx = x0 + ((cell - t.width) >> 1), dy = y0 + ((cell - t.height) >> 1);
      for (let y = 0; y < t.height; y++)
        for (let x = 0; x < t.width; x++) {
          const s = (y * t.width + x) * 4;
          const al = t.rgba[s + 3] / 255;
          if (al <= 0) continue;
          const d = ((dy + y) * W + (dx + x)) * 4;
          canvas[d] = Math.round(t.rgba[s] * al + canvas[d] * (1 - al));
          canvas[d + 1] = Math.round(t.rgba[s + 1] * al + canvas[d + 1] * (1 - al));
          canvas[d + 2] = Math.round(t.rgba[s + 2] * al + canvas[d + 2] * (1 - al));
          canvas[d + 3] = 255;
        }
    }
    stamp(canvas, W, x0 + 2, y0 + 2, c.label);
  });
  return encodeRgbaPng(W, H, canvas);
}
