import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { decodePng, montage, Rgba } from "../src/util/imgmontage.js";
import { encodeRgbaPng } from "../src/util/png.js";

// CRC32 + chunk writer so we can hand-build PNGs with arbitrary scanline filters.
const CRC = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Build a colorType-2 (RGB) PNG where each row is encoded with a chosen filter, so the
// decoder must invert Sub/Up/Average/Paeth correctly to reconstruct `pixels` (w*h*3).
function rgbPngWithFilters(w: number, h: number, pixels: Buffer, filters: number[]): Buffer {
  const ch = 3, stride = w * ch;
  const raw = Buffer.alloc(h * (1 + stride));
  let o = 0;
  for (let y = 0; y < h; y++) {
    const f = filters[y % filters.length];
    raw[o++] = f;
    for (let x = 0; x < stride; x++) {
      const cur = pixels[y * stride + x];
      const a = x >= ch ? pixels[y * stride + x - ch] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= ch && y > 0 ? pixels[(y - 1) * stride + x - ch] : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) pred = paeth(a, b, c);
      raw[o++] = (cur - pred) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// A small RGBA gradient so the round-trip exercises real pixel values (not all-equal rows).
function gradient(w: number, h: number): Rgba {
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = (y * w + x) * 4;
      rgba[d] = (x * 17) & 0xff;
      rgba[d + 1] = (y * 23) & 0xff;
      rgba[d + 2] = ((x + y) * 9) & 0xff;
      rgba[d + 3] = x % 2 ? 255 : 128; // mix of opaque/translucent
    }
  return { width: w, height: h, rgba };
}

test("decodePng round-trips an encodeRgbaPng image", () => {
  const src = gradient(7, 5);
  const png = encodeRgbaPng(src.width, src.height, src.rgba);
  const out = decodePng(png);
  assert.equal(out.width, src.width);
  assert.equal(out.height, src.height);
  assert.deepEqual(out.rgba, src.rgba);
});

test("decodePng rejects non-PNG input", () => {
  assert.throws(() => decodePng(Buffer.from("not a png at all")), /not a PNG/);
});

test("decodePng inverts all scanline filters (Sub/Up/Average/Paeth) on RGB", () => {
  const w = 6, h = 5, ch = 3;
  const pixels = Buffer.alloc(w * h * ch);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = (y * w + x) * ch;
      pixels[d] = (x * 40 + y * 7) & 0xff;
      pixels[d + 1] = (y * 50 + x * 3) & 0xff;
      pixels[d + 2] = (x * x + y * y) & 0xff;
    }
  const png = rgbPngWithFilters(w, h, pixels, [0, 1, 2, 3, 4]); // one filter per row
  const out = decodePng(png);
  assert.equal(out.width, w);
  assert.equal(out.height, h);
  // verify every pixel reconstructed, and RGB→RGBA expansion set alpha=255
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * ch, d = (y * w + x) * 4;
      assert.equal(out.rgba[d], pixels[s], `R @ ${x},${y}`);
      assert.equal(out.rgba[d + 1], pixels[s + 1], `G @ ${x},${y}`);
      assert.equal(out.rgba[d + 2], pixels[s + 2], `B @ ${x},${y}`);
      assert.equal(out.rgba[d + 3], 255, `A @ ${x},${y}`);
    }
});

test("montage produces a valid PNG that decodes back", () => {
  const cells = [
    { img: gradient(10, 10), label: "1" },
    { img: gradient(20, 8), label: "2" },
    { label: "3" }, // no image — should render an empty checkerboard tile + label
  ];
  const png = montage(cells, { cell: 60, cols: 2, pad: 4 });
  const decoded = decodePng(png);
  // 2 cols, 2 rows: W = 2*60 + 3*4 = 132, H = 2*60 + 3*4 = 132
  assert.equal(decoded.width, 132);
  assert.equal(decoded.height, 132);
  // background pixel (top-left corner) is the dark theme colour, fully opaque
  assert.equal(decoded.rgba[3], 255);
});

test("montage handles an empty cell list", () => {
  const png = montage([], { cell: 50, cols: 4 });
  const decoded = decodePng(png);
  assert.ok(decoded.width > 0 && decoded.height > 0);
});
