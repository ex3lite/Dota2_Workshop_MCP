// Parse a decompiled Source 2 particle (.vpcf KV3 text, as emitted by ValveResourceFormat)
// into a SIMPLIFIED spec good enough to drive a believable browser animation. We can't run
// the real Source 2 particle system out-of-engine, so we extract the parameters that matter
// visually — sprite, emission, lifespan, size-over-life, colour start/end, gravity, blend —
// and replay them as additive billboards in a <canvas> (see buildGallery). Heuristic by
// design: the goal is "looks and moves like the effect", not bit-exact simulation.

export interface ParticleSpec {
  sprite?: string; // .vtex resource path the renderer uses
  maxParticles: number;
  emitRate: number; // particles/sec (continuous emitter)
  emitDuration: number; // seconds the continuous emitter runs (0 = unset)
  burst: number; // particles emitted at once (instantaneous emitter)
  lifespan: number; // seconds
  radius: number; // base sprite radius (Source units)
  startScale: number; // radius multiplier at birth
  endScale: number; // radius multiplier at death
  colorStart: [number, number, number];
  colorEnd: [number, number, number];
  baseAlpha: number; // 0..1
  gravityZ: number; // +Z is up in Source; >0 rises (steam), <0 falls
  additive: boolean;
}

// --- KV3 text helpers -------------------------------------------------------

/** Return the inner text of each top-level `{…}` element inside `m_<name> = [ … ]`. */
function arraySection(text: string, name: string): string[] {
  const i = text.indexOf("m_" + name);
  if (i < 0) return [];
  const lb = text.indexOf("[", i);
  if (lb < 0) return [];
  let depth = 0;
  let end = lb;
  for (let j = lb; j < text.length; j++) {
    const c = text[j];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) { end = j; break; }
    }
  }
  const inner = text.slice(lb + 1, end);
  const blocks: string[] = [];
  let d = 0;
  let start = -1;
  for (let k = 0; k < inner.length; k++) {
    const c = inner[k];
    if (c === "{") { if (d === 0) start = k + 1; d++; }
    else if (c === "}") { d--; if (d === 0 && start >= 0) blocks.push(inner.slice(start, k)); }
  }
  return blocks;
}

const numIn = (s: string, re: RegExp, d: number): number => {
  const m = s.match(re);
  return m ? parseFloat(m[1]) : d;
};
const classOf = (b: string): string => (b.match(/_class\s*=\s*"([^"]+)"/) || [, ""])[1] as string;
function colorIn(s: string, re: RegExp): [number, number, number, number] | undefined {
  const m = s.match(re);
  if (!m) return undefined;
  const v = m[1].split(",").map((x) => parseFloat(x.trim()));
  if (v.length < 3 || v.some((n) => Number.isNaN(n))) return undefined;
  return [v[0], v[1], v[2], v[3] ?? 255];
}
/** Average value of an InitFloat-style input (random min/max, or literal). */
function avgInputValue(b: string): number {
  const mn = b.match(/m_flRandomMin\s*=\s*(-?[\d.]+)/);
  const mx = b.match(/m_flRandomMax\s*=\s*(-?[\d.]+)/);
  if (mn && mx) return (parseFloat(mn[1]) + parseFloat(mx[1])) / 2;
  const lit = b.match(/m_flLiteralValue\s*=\s*(-?[\d.]+)/);
  if (lit) return parseFloat(lit[1]);
  return 0;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Parse decompiled .vpcf KV3 text into a ParticleSpec (with sane fallbacks). */
export function parseVpcf(text: string): ParticleSpec {
  const topMax = numIn(text, /m_nMaxParticles\s*=\s*(\d+)/, 0);
  const constColor = colorIn(text, /m_ConstantColor\s*=\s*\[([^\]]+)\]/);

  // Renderers → sprite + blend mode.
  let sprite: string | undefined;
  let additive = true;
  for (const b of arraySection(text, "Renderers")) {
    const t = b.match(/m_hTexture\s*=\s*resource:"([^"]+)"/);
    if (t && !sprite) sprite = t[1];
    if (/m_nOutputBlendMode/.test(b)) additive = /ADD|ADDITIVE/i.test(b);
  }

  // Emitters → continuous rate/duration or instantaneous burst.
  let emitRate = 0;
  let emitDuration = 0;
  let burst = 0;
  for (const b of arraySection(text, "Emitters")) {
    if (/Continuous/i.test(b)) {
      emitRate = avgInputValue(matchBlock(b, "m_flEmitRate")) || emitRate;
      emitDuration = avgInputValue(matchBlock(b, "m_flEmissionDuration")) || emitDuration;
    }
    if (/Instantaneous|Noise/i.test(b)) {
      burst = avgInputValue(matchBlock(b, "m_nParticlesToEmit")) || numIn(b, /m_nParticlesToEmit\s*=\s*(\d+)/, 0) || burst;
    }
  }

  // Initializers → lifespan (field 1), radius (field 3 / default), start colour.
  let lifespan = 0;
  let radius = 0;
  let colorStart: [number, number, number] | undefined;
  for (const b of arraySection(text, "Initializers")) {
    const cls = classOf(b);
    if (cls === "C_INIT_InitFloat" || cls === "C_INIT_RandomScalar") {
      const field = numIn(b, /m_nOutputField\s*=\s*(\d+)/, 3);
      const v = avgInputValue(b);
      if (field === 1 && v) lifespan = v;
      else if (field === 3 && v) radius = v;
    } else if (cls === "C_INIT_RandomColor") {
      const mn = colorIn(b, /m_ColorMin\s*=\s*\[([^\]]+)\]/);
      const mx = colorIn(b, /m_ColorMax\s*=\s*\[([^\]]+)\]/);
      const one = colorIn(b, /m_ColorMax\s*=\s*\[([^\]]+)\]/) || colorIn(b, /m_ColorMin\s*=\s*\[([^\]]+)\]/);
      if (mn && mx) colorStart = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
      else if (one) colorStart = [one[0], one[1], one[2]];
    } else if (cls === "C_INIT_RandomRadius" || cls === "C_INIT_CreateWithinSphere") {
      const r = numIn(b, /m_flRadiusMax\s*=\s*([\d.]+)/, 0) || numIn(b, /m_flRadius\s*=\s*([\d.]+)/, 0);
      if (r && !radius) radius = r;
    }
  }

  // Operators → gravity, size-over-life, colour fade (end colour).
  let gravityZ = 0;
  let startScale = 1;
  let endScale = 1;
  let colorEnd: [number, number, number] | undefined;
  for (const b of arraySection(text, "Operators")) {
    const cls = classOf(b);
    if (cls === "C_OP_BasicMovement") {
      const g = colorIn(b, /m_Gravity\s*=\s*\[([^\]]+)\]/);
      if (g) gravityZ = g[2];
    } else if (cls === "C_OP_InterpolateRadius") {
      startScale = numIn(b, /m_flStartScale\s*=\s*(-?[\d.]+)/, 1);
      endScale = numIn(b, /m_flEndScale\s*=\s*(-?[\d.]+)/, 1);
    } else if (cls === "C_OP_ColorInterpolate") {
      const c = colorIn(b, /m_ColorFade\s*=\s*\[([^\]]+)\]/);
      if (c) colorEnd = [c[0], c[1], c[2]];
    }
  }

  // Fallbacks.
  lifespan = lifespan || numIn(text, /m_flConstantLifespan\s*=\s*([\d.]+)/, 0) || 1.2;
  radius = radius || numIn(text, /m_flConstantRadius\s*=\s*([\d.]+)/, 0) || 32;
  colorStart = colorStart || (constColor ? [constColor[0], constColor[1], constColor[2]] : [255, 255, 255]);
  colorEnd = colorEnd || colorStart;
  const baseAlpha = constColor ? clamp(constColor[3] / 255, 0.15, 1) : 1;
  let maxParticles = topMax || burst || Math.ceil(emitRate * Math.max(emitDuration || lifespan, 0.5)) || 40;
  maxParticles = clamp(maxParticles, 1, 400);
  if (!emitRate && !burst) burst = Math.min(maxParticles, 40); // ensure something emits

  return {
    sprite,
    maxParticles,
    emitRate,
    emitDuration,
    burst,
    lifespan: clamp(lifespan, 0.15, 6),
    radius: clamp(radius, 2, 400),
    startScale: clamp(startScale, 0, 20), // 0 is valid (grow from nothing); defaults to 1 when no op
    endScale: clamp(endScale, 0, 20),
    colorStart,
    colorEnd,
    baseAlpha,
    gravityZ: clamp(gravityZ, -2000, 2000),
    additive,
  };
}

/** Grab the small `{ … }` block that immediately follows `m_<name> =` (e.g. an input value). */
function matchBlock(b: string, name: string): string {
  const i = b.indexOf("m_" + name.replace(/^m_/, ""));
  if (i < 0) return "";
  const lb = b.indexOf("{", i);
  const eq = b.indexOf("=", i);
  // literal on same line: "m_flEmitRate = 20.0"
  if (lb < 0 || (eq >= 0 && lb > b.indexOf("\n", i) && b.indexOf("\n", i) >= 0)) {
    const line = b.slice(i, b.indexOf("\n", i) < 0 ? b.length : b.indexOf("\n", i));
    return line;
  }
  let d = 0;
  for (let j = lb; j < b.length; j++) {
    if (b[j] === "{") d++;
    else if (b[j] === "}") { d--; if (d === 0) return b.slice(lb + 1, j); }
  }
  return b.slice(i);
}
