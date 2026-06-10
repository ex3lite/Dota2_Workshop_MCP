// image_generate — generate OR edit an image using the user's ChatGPT Plus account (the
// "Sign in with ChatGPT" / Codex OAuth token), with no OpenAI API key. Supports transparency
// (via chroma-key), quality validation, and compression (downscale/re-encode) for optimized
// Dota assets. See src/imagegen/{chatgpt,chromakey,imageops}.ts for the mechanics + caveats.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { homedir } from "node:os";
import { join, isAbsolute, dirname } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { generateImage, codexAuthPath, CodexAuthMissingError, SETUP_HELP, type ImageFormat, type InputImage } from "../imagegen/chatgpt.js";
import { knockoutGreenScreen, GREEN_SCREEN_SUFFIX } from "../imagegen/chromakey.js";
import { assessGeneration, assessTransparency, optimizeImage, loadImageAsPng, pngSize } from "../imagegen/imageops.js";
import { json, image, error, guard, ToolResult } from "../util/result.js";

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "image";
}

export function registerImageTools(server: McpServer) {
  server.registerTool(
    "image_generate",
    {
      title: "Generate or edit an image with your ChatGPT Plus account",
      description:
        "Generate (or EDIT) an image using your ChatGPT Plus/Pro/Team subscription — the same " +
        '"Sign in with ChatGPT" OAuth the Codex CLI uses, so NO OpenAI API key and no per-image billing ' +
        "beyond your Plus plan. Shows it inline + saves it. Features: " +
        "(1) EDIT — pass `image` (path(s)) to modify an existing picture ('add a fiery glow', 'remove the text'); " +
        "(2) TRANSPARENCY — transparent=true makes a true alpha PNG via auto green-screen + ffmpeg chroma-key " +
        "(best for isolated subjects: icons/items/one character); " +
        "(3) COMPRESSION — maxSize downscales (the main size win for an optimized project) and quality/format " +
        "re-encode. Default format PNG (Panorama/VTEX accept png/jpg, NOT webp). " +
        "One-time setup if not signed in: `npm i -g @openai/codex` then `codex login`. " +
        "Caveat: undocumented endpoint (may change).",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .describe("What to draw, or — when `image` is given — the edit instruction (e.g. 'add a fiery orange glow and embers')."),
        image: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe("EDIT mode: path(s) to a source image to modify or use as reference. The prompt becomes the edit instruction."),
        out: z.string().optional().describe("Output path — absolute, or relative to the generated cache dir. Default: ~/.dota2-workshop-mcp/generated/<slug>-<id>.<ext>."),
        size: z.string().optional().describe("'auto' (default) or WIDTHxHEIGHT, e.g. '1024x1024', '1024x1536' (portrait), '1536x1024' (landscape)."),
        format: z.enum(["png", "jpeg", "webp"]).optional().describe("Output format (default png). png/jpg are Panorama/VTEX-safe; webp is external-only (engine can't read it)."),
        maxSize: z.number().int().min(16).max(4096).optional().describe("COMPRESS: cap the longest side to this many px (keeps aspect). The biggest size win — e.g. 128/256 for icons. Model renders ≥1024, so this downscales."),
        quality: z.number().int().min(1).max(100).optional().describe("COMPRESS: lossy quality 1–100 for webp/jpeg (omit ⇒ lossless). Lower = smaller. Ignored for png."),
        transparent: z.boolean().optional().describe("Produce a TRUE transparent (alpha) PNG via auto chroma-key (green screen → local knockout). Best for a single isolated subject; forces an alpha format."),
        background: z.enum(["auto", "transparent", "opaque"]).optional().describe("Background mode (default opaque). 'transparent' is an alias for transparent=true."),
        model: z.string().optional().describe("Chat model hosting the image tool (default gpt-5.5)."),
        inline: z.boolean().optional().describe("Show the image inline in chat (default true). Set false to only save to disk and return the path."),
      },
    },
    guard(async ({ prompt, image: imageArg, out, size, format, maxSize, quality, transparent, background, model, inline }): Promise<ToolResult> => {
      const warnings: string[] = [];
      const wantTransparent = transparent === true || background === "transparent";

      // Final container. png/jpg are engine-safe; webp is external-only; jpeg can't hold alpha.
      let fmt = (format ?? "png") as ImageFormat;
      if (wantTransparent && fmt === "jpeg") {
        fmt = "png";
        warnings.push("transparency needs an alpha format — using PNG instead of JPEG.");
      }
      if (fmt === "webp") warnings.push("webp isn't readable by Dota Panorama/VTEX — use png (or jpg) for in-engine assets; webp is fine for external/preview use.");

      // EDIT mode: load + normalise source image(s) to ≤1024 PNG to keep the request reasonable.
      const editPaths = imageArg ? (Array.isArray(imageArg) ? imageArg : [imageArg]).slice(0, 4) : [];
      let inputImages: InputImage[] | undefined;
      if (editPaths.length) {
        inputImages = [];
        for (const p of editPaths) {
          const png = await loadImageAsPng(isAbsolute(p) ? p : join(homedir(), ".dota2-workshop-mcp", "generated", p));
          inputImages.push({ data: png, mime: "image/png" });
        }
      }
      const editing = !!inputImages?.length;

      const genPrompt = wantTransparent ? prompt + GREEN_SCREEN_SUFFIX : prompt;
      const ext = fmt === "jpeg" ? "jpg" : fmt;
      const genDir = join(homedir(), ".dota2-workshop-mcp", "generated");
      const outPath = out ? (isAbsolute(out) ? out : join(genDir, out)) : join(genDir, `${slugify(prompt)}-${Date.now().toString(36)}.${ext}`);
      await mkdir(dirname(outPath), { recursive: true });

      // Always render as PNG from the API (lossless source); the final format/size is produced locally.
      let img;
      try {
        img = await generateImage({ prompt: genPrompt, size, model, inputImages });
      } catch (e) {
        if (e instanceof CodexAuthMissingError) return error(`${SETUP_HELP}\n\n(${e.message})\nAuth file checked: ${codexAuthPath()}`);
        throw e; // guard() turns other errors into a clean error result
      }
      const generatedBytes = img.buffer.length;

      // Validate the generation (catch a blank/failed render before we ship it).
      const gen = await assessGeneration(img.buffer);
      if (gen.blank) warnings.push(`the render looks near-blank/flat (luma range ${gen.lumaRange}) — it may have failed; try rephrasing or regenerate.`);

      // Transparency via chroma-key, then validate the cut-out.
      let buffer = img.buffer;
      let transNote = "";
      const quality_metrics: Record<string, unknown> = { lumaRange: gen.lumaRange, lumaStd: gen.lumaStd, blank: gen.blank };
      if (wantTransparent) {
        const ko = await knockoutGreenScreen(img.buffer); // throws (→ clean error) if not a clean green screen
        buffer = ko.png;
        const t = await assessTransparency(buffer);
        warnings.push(...t.warnings);
        quality_metrics.cornerAlpha = t.cornerAlpha;
        quality_metrics.opaquePct = t.opaquePct;
        transNote = ` · transparent (keyed ${ko.keyHex}, ${t.opaquePct}% opaque)`;
      }

      // Compress / convert: only when the target differs from the lossless PNG we already hold.
      let mimeType = "image/png";
      let dims = pngSize(buffer) ?? { width: 0, height: 0 };
      if (fmt !== "png" || maxSize != null || quality != null) {
        const opt = await optimizeImage(buffer, { maxSize, quality, format: fmt });
        buffer = opt.buffer;
        mimeType = opt.mimeType;
        dims = { width: opt.width, height: opt.height };
      }

      await writeFile(outPath, buffer);

      const kb = (n: number) => `${Math.round(n / 1024)} KB`;
      const optimized = buffer.length !== generatedBytes;
      const sizeNote = optimized ? ` (was ${kb(generatedBytes)} PNG${maxSize ? `, downscaled to ${dims.width}×${dims.height}` : ""})` : "";
      const verb = editing ? "Edited" : "Generated";
      const caption =
        `${verb} via ChatGPT Plus — ${dims.width}×${dims.height} ${fmt.toUpperCase()}, ${kb(buffer.length)}${sizeNote}${transNote}, saved to:\n${outPath}` +
        (warnings.length ? `\n⚠ ${warnings.join("\n⚠ ")}` : "");
      const structured = {
        path: outPath,
        bytes: buffer.length,
        generatedBytes,
        width: dims.width,
        height: dims.height,
        format: fmt,
        mimeType,
        transparent: wantTransparent,
        edited: editing,
        quality: quality_metrics,
        warnings,
      };

      if (inline === false) return json(structured, `${caption}\n➡ Read this path to view it inline.`);
      const result = image(buffer.toString("base64"), mimeType, caption);
      result.structuredContent = structured;
      return result;
    }),
  );
}
