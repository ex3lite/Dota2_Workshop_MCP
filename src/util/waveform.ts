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
