// Real transparency for the ChatGPT-account path, since the Codex `image_generation` tool flatly
// rejects background:transparent (verified: HTTP 400 "Transparent background is not supported for
// this model", for every model/param combo). Workaround we fully control: ask the model to paint the
// subject on a flat green screen, then knock that green out locally with ffmpeg → a true alpha PNG.
// Best for ISOLATED subjects (icons, items, a single character) — not full scenes.
import { ensureFfmpeg } from "../dota/ffmpeg.js";
import { run } from "../dota/process.js";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Appended to the user's prompt when transparency is requested, to force a keyable background.
export const GREEN_SCREEN_SUFFIX =
  " Place the single subject centered and fully visible, isolated on a perfectly flat uniform solid " +
  "chroma-green background (RGB 0,255,0). Fill the entire background edge-to-edge with that exact green. " +
  "No gradient, no vignette, no shadow, no reflection, no extra elements.";

export interface KnockoutResult {
  png: Buffer; // RGBA PNG with the background removed
  keyHex: string; // the background colour we sampled + keyed
  avgAlpha: number; // 0..255 mean alpha (sanity signal that something became transparent)
}

/** Knock out the (near-pure-green) background of a generated PNG → RGBA PNG. Throws if it isn't a green screen. */
export async function knockoutGreenScreen(
  srcPng: Buffer,
  opts: { similarity?: number; blend?: number } = {},
): Promise<KnockoutResult> {
  const ff = await ensureFfmpeg();
  const sim = opts.similarity ?? 0.3;
  const blend = opts.blend ?? 0.1;
  const dir = await mkdtemp(join(tmpdir(), "mcp-chroma-"));
  const inP = join(dir, "in.png");
  const outP = join(dir, "out.png");
  try {
    await writeFile(inP, srcPng);

    // Sample the real corner colour (avg of a 60×60 patch → 1px) so we key the exact green produced,
    // not a guessed constant. run() returns stdout as a (binary-unsafe) string, so go via a raw file.
    const cornerRaw = join(dir, "corner.raw");
    await run(ff, ["-y", "-i", inP, "-vf", "crop=60:60:6:6,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", cornerRaw]);
    const cb = await readFile(cornerRaw);
    const [r, g, b] = [cb[0], cb[1], cb[2]];
    const keyHex = "0x" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
    // Guard: if the corner isn't clearly green, the model didn't give us a green screen — bail loudly
    // rather than keying some arbitrary colour out of the subject.
    if (!(g > 140 && r < 130 && b < 130)) {
      throw new Error(
        `background isn't a clean green screen (corner ${keyHex}) — can't isolate it. Try a simpler/single subject, or regenerate.`,
      );
    }

    const vf = `colorkey=${keyHex}:${sim}:${blend},despill=type=green:mix=0.5:expand=0.3,format=rgba`;
    const res = await run(ff, ["-y", "-i", inP, "-vf", vf, outP], { maxOutputChars: 4000 });
    if (res.code !== 0) throw new Error("ffmpeg knockout failed: " + (res.stderr || res.stdout).slice(-300));
    const png = await readFile(outP);

    // Mean alpha as a quick sanity signal (fully-opaque output would be 255).
    const aRaw = join(dir, "a.raw");
    await run(ff, ["-y", "-i", outP, "-vf", "alphaextract,scale=1:1", "-f", "rawvideo", "-pix_fmt", "gray", aRaw]);
    const avgAlpha = (await readFile(aRaw))[0] ?? 255;

    return { png, keyHex, avgAlpha };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
