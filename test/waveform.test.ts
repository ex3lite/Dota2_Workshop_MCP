import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWav, renderWaveform, fmtDuration } from "../src/util/waveform.js";

// Build a canonical 16-bit PCM WAV in memory.
function makeWav(samples: Float32Array, sampleRate: number, channels = 1): Buffer {
  const bytesPerSample = 2;
  const dataLen = samples.length * bytesPerSample; // already interleaved by caller
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // audioFormat = PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

test("parseWav reads 16-bit PCM metadata + samples", () => {
  const sr = 8000;
  const n = 800; // 0.1s
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = Math.sin((2 * Math.PI * 200 * i) / sr); // 200Hz tone
  const info = parseWav(makeWav(data, sr));
  assert.equal(info.sampleRate, sr);
  assert.equal(info.channels, 1);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.frames, n);
  assert.ok(Math.abs(info.durationSec - 0.1) < 1e-6);
  // sample values reconstructed within 16-bit quantisation error
  for (let i = 0; i < n; i += 50) assert.ok(Math.abs(info.samples[i] - data[i]) < 0.001, `sample ${i}`);
});

test("parseWav mixes stereo channels to mono", () => {
  const sr = 4000;
  // interleaved L,R: L=+1, R=-1 -> mono mix ~0
  const inter = new Float32Array(8);
  for (let i = 0; i < 4; i++) { inter[i * 2] = 1; inter[i * 2 + 1] = -1; }
  const info = parseWav(makeWav(inter, sr, 2));
  assert.equal(info.channels, 2);
  assert.equal(info.frames, 4);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(info.samples[i]) < 0.001, `mono mix ${i}`);
});

test("parseWav rejects non-WAV input", () => {
  assert.throws(() => parseWav(Buffer.from("nope, not riff wave")), /not a WAV/);
});

test("renderWaveform returns an image of the requested size", () => {
  const data = new Float32Array(1000);
  for (let i = 0; i < data.length; i++) data[i] = Math.sin(i / 5);
  const img = renderWaveform(data, { width: 200, height: 60 });
  assert.equal(img.width, 200);
  assert.equal(img.height, 60);
  assert.equal(img.rgba.length, 200 * 60 * 4);
  // empty input still yields a valid (background-only) image
  const empty = renderWaveform(new Float32Array(0), { width: 50, height: 20 });
  assert.equal(empty.rgba.length, 50 * 20 * 4);
});

test("fmtDuration formats sub-10s and longer", () => {
  assert.equal(fmtDuration(0.4), "0.4s");
  assert.equal(fmtDuration(75), "1:15");
  assert.equal(fmtDuration(0), "0:00");
});
