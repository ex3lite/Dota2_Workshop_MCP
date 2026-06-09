// Decode a WAV file and render its waveform as an RGBA image — so sound previews are
// VISIBLE inline in chat (viewable over remote-access), alongside the playable audio.
// Dependency-free: parses RIFF/WAVE (PCM int 8/16/24/32-bit + IEEE float 32-bit, incl.
// WAVE_FORMAT_EXTENSIBLE) and draws a min/max amplitude envelope.

import type { Rgba } from "./imgmontage.js";

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  durationSec: number;
  frames: number;
  samples: Float32Array; // mono mix, range ~[-1, 1]
}

/** Parse a WAV buffer to a mono float sample array + metadata. Throws if not a WAV. */
export function parseWav(buf: Buffer): WavInfo {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAV file");
  }
  let p = 12;
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bits: number } | null = null;
  let dataOff = -1;
  let dataLen = 0;
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === "fmt ") {
      let audioFormat = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const sampleRate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE: real format is the first 2 bytes of the SubFormat GUID.
      if (audioFormat === 0xfffe && size >= 26) audioFormat = buf.readUInt16LE(body + 24);
      fmt = { audioFormat, channels: channels || 1, sampleRate: sampleRate || 44100, bits: bits || 16 };
    } else if (id === "data") {
      dataOff = body;
      dataLen = Math.min(size, buf.length - body);
    }
    p = body + size + (size & 1); // chunks are word-aligned
    if (fmt && dataOff >= 0) break;
  }
  if (!fmt) throw new Error("WAV missing fmt chunk");
  if (dataOff < 0) throw new Error("WAV missing data chunk");

  const { audioFormat, channels, sampleRate, bits } = fmt;
  const bytesPerSample = Math.max(1, bits >> 3);
  const frameBytes = bytesPerSample * channels;
  const frames = Math.floor(dataLen / frameBytes);
  const isFloat = audioFormat === 3;

  const readSample = (off: number): number => {
    if (isFloat) return bits === 64 ? buf.readDoubleLE(off) : buf.readFloatLE(off);
    switch (bits) {
      case 8: return (buf.readUInt8(off) - 128) / 128; // 8-bit PCM is unsigned
      case 16: return buf.readInt16LE(off) / 32768;
      case 24: {
        const v = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16);
        return (v & 0x800000 ? v - 0x1000000 : v) / 8388608;
      }
      case 32: return buf.readInt32LE(off) / 2147483648;
      default: return 0;
    }
  };

  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    const base = dataOff + i * frameBytes;
    for (let c = 0; c < channels; c++) acc += readSample(base + c * bytesPerSample);
    samples[i] = acc / channels;
  }
  return { sampleRate, channels, bitsPerSample: bits, frames, durationSec: frames / sampleRate, samples };
}

/** Render a min/max waveform envelope as an RGBA image. */
export function renderWaveform(
  samples: Float32Array,
  opts: { width?: number; height?: number } = {},
): Rgba {
  const W = opts.width ?? 320;
  const H = opts.height ?? 120;
  const rgba = Buffer.alloc(W * H * 4);
  // dark background
  for (let i = 0; i < W * H; i++) { rgba[i * 4] = 18; rgba[i * 4 + 1] = 22; rgba[i * 4 + 2] = 32; rgba[i * 4 + 3] = 255; }

  const mid = (H - 1) / 2;
  // faint centre line
  for (let x = 0; x < W; x++) {
    const d = (Math.round(mid) * W + x) * 4;
    rgba[d] = 45; rgba[d + 1] = 52; rgba[d + 2] = 70; rgba[d + 3] = 255;
  }
  if (!samples.length) return { width: W, height: H, rgba };

  const per = samples.length / W;
  for (let x = 0; x < W; x++) {
    const s0 = Math.floor(x * per);
    const s1 = Math.min(samples.length, Math.max(s0 + 1, Math.floor((x + 1) * per)));
    let mn = 1, mx = -1;
    for (let i = s0; i < s1; i++) {
      const v = samples[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    // clamp & map [-1,1] -> [H-1,0]
    const yTop = Math.max(0, Math.min(H - 1, Math.round(mid - mx * mid)));
    const yBot = Math.max(0, Math.min(H - 1, Math.round(mid - mn * mid)));
    for (let y = yTop; y <= yBot; y++) {
      const d = (y * W + x) * 4;
      rgba[d] = 90; rgba[d + 1] = 200; rgba[d + 2] = 140; rgba[d + 3] = 255; // green waveform
    }
  }
  return { width: W, height: H, rgba };
}

export function fmtDuration(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return sec < 10 ? `${sec.toFixed(1)}s` : `${m}:${String(s).padStart(2, "0")}`;
}

// ----- audio container detection ------------------------------------------
// Dota ships most sounds MP3-compressed; ValveResourceFormat dumps the original stream,
// so a decoded ".vsnd" is often MP3, sometimes PCM WAV. We can render a real waveform from
// PCM, but not from MP3 without a decoder — so MP3 gets duration (cheaply, by walking frame
// headers) + a speaker-icon placeholder tile, and still plays in the soundboard / inline.

export type AudioFormat = "wav" | "mp3" | "unknown";

export function detectAudio(buf: Buffer): { format: AudioFormat; mime: string } {
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") {
    return { format: "wav", mime: "audio/wav" };
  }
  // ID3v2 tag or an MPEG audio frame sync (0xFFE.)
  if (buf.length >= 3 && buf.toString("ascii", 0, 3) === "ID3") return { format: "mp3", mime: "audio/mpeg" };
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return { format: "mp3", mime: "audio/mpeg" };
  return { format: "unknown", mime: "application/octet-stream" };
}

const MP3_BITRATE = {
  // [versionGroup][bitrateIndex] in kbps. versionGroup: 1 = MPEG1, 2 = MPEG2/2.5 (Layer III).
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
} as const;
const MP3_SAMPLERATE = {
  3: [44100, 48000, 32000, 0], // MPEG1
  2: [22050, 24000, 16000, 0], // MPEG2
  0: [11025, 12000, 8000, 0], // MPEG2.5
} as const;

/** Sum MP3 frame durations by walking frame headers (handles CBR + VBR). Returns seconds. */
export function mp3DurationSec(buf: Buffer): number {
  let p = 0;
  // Skip an ID3v2 tag (syncsafe size in bytes 6..9).
  if (buf.length > 10 && buf.toString("ascii", 0, 3) === "ID3") {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    p = 10 + size;
  }
  let samples = 0;
  let sampleRate = 0;
  let frames = 0;
  while (p + 4 <= buf.length && frames < 500_000) {
    if (buf[p] !== 0xff || (buf[p + 1] & 0xe0) !== 0xe0) { p++; continue; } // resync
    const verBits = (buf[p + 1] >> 3) & 0x3; // 0=2.5,2=2,3=1
    const layerBits = (buf[p + 1] >> 1) & 0x3; // 1=III
    const brIndex = (buf[p + 2] >> 4) & 0xf;
    const srIndex = (buf[p + 2] >> 2) & 0x3;
    const padding = (buf[p + 2] >> 1) & 0x1;
    if (verBits === 1 || layerBits === 0 || brIndex === 0 || brIndex === 15 || srIndex === 3) { p++; continue; }
    const verGroup = verBits === 3 ? 1 : 2;
    const bitrate = MP3_BITRATE[verGroup][brIndex] * 1000;
    const sr = MP3_SAMPLERATE[verBits as 0 | 2 | 3][srIndex];
    if (!bitrate || !sr) { p++; continue; }
    const spf = verBits === 3 ? 1152 : 576; // samples/frame, Layer III
    const frameLen = Math.floor((spf / 8 * bitrate) / sr) + padding;
    if (frameLen < 4) { p++; continue; }
    samples += spf;
    sampleRate = sr;
    frames++;
    p += frameLen;
  }
  return sampleRate ? samples / sampleRate : 0;
}

/** A speaker-icon placeholder tile (for sounds we can play but can't waveform, e.g. MP3). */
export function speakerTile(opts: { width?: number; height?: number } = {}): Rgba {
  const W = opts.width ?? 320;
  const H = opts.height ?? 96;
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { rgba[i * 4] = 22; rgba[i * 4 + 1] = 27; rgba[i * 4 + 2] = 38; rgba[i * 4 + 3] = 255; }
  const cx = W >> 1;
  const cy = H >> 1;
  const s = Math.min(W, H) * 0.28; // icon scale
  const put = (x: number, y: number, r: number, g: number, b: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const d = (y * W + x) * 4;
    rgba[d] = r; rgba[d + 1] = g; rgba[d + 2] = b; rgba[d + 3] = 255;
  };
  // speaker body (square) + cone (triangle), in a soft cyan
  const [r, g, b] = [120, 200, 220];
  const bodyX0 = Math.round(cx - s * 1.1), bodyX1 = Math.round(cx - s * 0.5);
  for (let y = Math.round(cy - s * 0.4); y <= Math.round(cy + s * 0.4); y++)
    for (let x = bodyX0; x <= bodyX1; x++) put(x, y, r, g, b);
  for (let y = Math.round(cy - s); y <= Math.round(cy + s); y++) {
    const frac = 1 - Math.abs(y - cy) / s; // widens toward centre line
    const x1 = Math.round(cx - s * 0.5 + s * frac);
    for (let x = bodyX1; x <= x1; x++) put(x, y, r, g, b);
  }
  // two "sound wave" arcs
  for (let a = -45; a <= 45; a += 2) {
    const rad = (a * Math.PI) / 180;
    for (const rr of [s * 1.0, s * 1.5]) {
      put(Math.round(cx + s * 0.7 + Math.cos(rad) * rr), Math.round(cy + Math.sin(rad) * rr), r, g, b);
    }
  }
  return { width: W, height: H, rgba };
}
