import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWav, renderWaveform, fmtDuration, detectAudio, mp3DurationSec, speakerTile } from "../src/util/waveform.js";

// K contiguous MPEG1 Layer III frames, 128kbps @ 44100Hz (frame length 417 bytes).
function makeMp3(frames: number): Buffer {
  const FRAME = 417;
  const buf = Buffer.alloc(frames * FRAME);
  for (let f = 0; f < frames; f++) {
    const o = f * FRAME;
    buf[o] = 0xff; buf[o + 1] = 0xfb; buf[o + 2] = 0x90; buf[o + 3] = 0x00; // 128k/44100/LIII/MPEG1
  }
  return buf;
}

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

test("detectAudio distinguishes WAV / MP3 / unknown", () => {
  const wavBuf = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(8)]);
  assert.deepEqual(detectAudio(wavBuf), { format: "wav", mime: "audio/wav" });
  assert.deepEqual(detectAudio(makeMp3(1)), { format: "mp3", mime: "audio/mpeg" });
  assert.deepEqual(detectAudio(Buffer.concat([Buffer.from("ID3"), Buffer.alloc(20)])), { format: "mp3", mime: "audio/mpeg" });
  assert.equal(detectAudio(Buffer.from("random bytes here")).format, "unknown");
});

test("mp3DurationSec walks frames (CBR) within tolerance", () => {
  const frames = 20;
  const expected = (frames * 1152) / 44100; // ~0.522s
  const got = mp3DurationSec(makeMp3(frames));
  assert.ok(Math.abs(got - expected) < 0.02, `expected ~${expected.toFixed(3)}s, got ${got.toFixed(3)}s`);
});

test("mp3DurationSec skips an ID3v2 tag", () => {
  const id3 = Buffer.alloc(10);
  id3.write("ID3", 0, "ascii");
  // syncsafe size = 0 -> tag is just the 10-byte header
  const buf = Buffer.concat([id3, makeMp3(10)]);
  const got = mp3DurationSec(buf);
  assert.ok(Math.abs(got - (10 * 1152) / 44100) < 0.02, `got ${got}`);
});

test("speakerTile returns an opaque image of the requested size", () => {
  const t = speakerTile({ width: 200, height: 80 });
  assert.equal(t.width, 200);
  assert.equal(t.height, 80);
  assert.equal(t.rgba.length, 200 * 80 * 4);
  assert.equal(t.rgba[3], 255); // opaque
});
