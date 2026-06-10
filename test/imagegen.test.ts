import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  parseSseForImage,
  buildPayload,
  mimeForFormat,
  codexAuthPath,
  codexHome,
} from "../src/imagegen/chatgpt.js";
import { pngSize } from "../src/imagegen/imageops.js";
import { encodeRgbaPng } from "../src/util/png.js";

// A small known payload so we can assert the base64 round-trips back to the original bytes.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const B64 = PNG_MAGIC.toString("base64");

function sse(...events: object[]): string {
  // Mirrors the wire format: an `event:` line, a `data:` line, then a blank separator.
  return (
    events
      .map((e) => `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n`)
      .join("\n") + "\ndata: [DONE]\n"
  );
}

test("parseSseForImage extracts the image from output_item.done", () => {
  const stream = sse(
    { type: "response.created" },
    { type: "response.image_generation_call.in_progress" },
    { type: "response.image_generation_call.partial_image", partial_image_b64: "Zm9v" },
    { type: "response.output_item.done", item: { type: "image_generation_call", result: B64, status: "completed" } },
    { type: "response.completed", response: { output: [] } },
  );
  const { b64, error } = parseSseForImage(stream);
  assert.equal(error, null);
  assert.ok(b64, "expected an image");
  // The final result wins over the earlier partial.
  assert.deepEqual(Buffer.from(b64!, "base64"), PNG_MAGIC);
});

test("parseSseForImage reads the image out of response.completed output", () => {
  const stream = sse({
    type: "response.completed",
    response: { output: [{ type: "reasoning" }, { type: "image_generation_call", result: B64 }] },
  });
  const { b64 } = parseSseForImage(stream);
  assert.deepEqual(Buffer.from(b64!, "base64"), PNG_MAGIC);
});

test("parseSseForImage falls back to the last partial when no final result", () => {
  const stream = sse(
    { type: "response.image_generation_call.partial_image", partial_image_b64: "AAAA" },
    { type: "response.image_generation_call.partial_image", partial_image_b64: B64 },
  );
  const { b64, error } = parseSseForImage(stream);
  assert.equal(error, null);
  assert.equal(b64, B64);
});

test("parseSseForImage surfaces a failure message", () => {
  const stream = sse({ type: "response.failed", response: { error: { message: "content_policy_violation" } } });
  const { b64, error } = parseSseForImage(stream);
  assert.equal(b64, null);
  assert.equal(error, "content_policy_violation");
});

test("parseSseForImage tolerates CRLF, junk lines and non-JSON data", () => {
  const stream =
    ": keep-alive comment\r\n" +
    "event: response.output_item.done\r\n" +
    `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "image_generation_call", result: B64 } })}\r\n` +
    "data: not-json-here\r\n" +
    "data: [DONE]\r\n";
  const { b64, error } = parseSseForImage(stream);
  assert.equal(error, null);
  assert.deepEqual(Buffer.from(b64!, "base64"), PNG_MAGIC);
});

test("parseSseForImage returns nulls for an image-less stream", () => {
  const { b64, error } = parseSseForImage(sse({ type: "response.created" }, { type: "response.completed", response: { output: [] } }));
  assert.equal(b64, null);
  assert.equal(error, null);
});

test("buildPayload wires the prompt into the image_generation tool", () => {
  const p = buildPayload({ prompt: "a red rune", size: "1024x1024", format: "webp", model: "gpt-5.5" }) as any;
  assert.equal(p.model, "gpt-5.5");
  assert.equal(p.stream, true);
  assert.equal(p.store, false);
  assert.equal(p.input[0].content[0].text, "a red rune");
  assert.equal(p.tools[0].type, "image_generation");
  assert.equal(p.tools[0].output_format, "webp");
  assert.equal(p.tools[0].size, "1024x1024");
});

test("buildPayload adds background only when requested (transparency)", () => {
  const plain = buildPayload({ prompt: "x", size: "auto", format: "png", model: "gpt-5.5" }) as any;
  assert.equal("background" in plain.tools[0], false);
  const tr = buildPayload({ prompt: "x", size: "auto", format: "png", model: "gpt-5.5", background: "transparent" }) as any;
  assert.equal(tr.tools[0].background, "transparent");
});

test("buildPayload includes input_image parts for editing", () => {
  const p = buildPayload({
    prompt: "add glow",
    size: "auto",
    format: "png",
    model: "gpt-5.5",
    inputImages: [{ data: Buffer.from([1, 2, 3]), mime: "image/png" }],
  }) as any;
  const content = p.input[0].content;
  assert.equal(content[0].type, "input_image");
  assert.match(content[0].image_url, /^data:image\/png;base64,/);
  assert.equal(content[content.length - 1].type, "input_text");
  assert.equal(content[content.length - 1].text, "add glow");
});

test("pngSize reads dimensions from a PNG header", () => {
  const png = encodeRgbaPng(7, 5, Buffer.alloc(7 * 5 * 4));
  assert.deepEqual(pngSize(png), { width: 7, height: 5 });
  assert.equal(pngSize(Buffer.from("not a png at all")), null);
});

test("mimeForFormat maps formats", () => {
  assert.equal(mimeForFormat("png"), "image/png");
  assert.equal(mimeForFormat("jpeg"), "image/jpeg");
  assert.equal(mimeForFormat("webp"), "image/webp");
});

test("codexAuthPath honors CODEX_HOME, else ~/.codex", () => {
  const prev = process.env.CODEX_HOME;
  try {
    delete process.env.CODEX_HOME;
    assert.equal(codexHome(), join(homedir(), ".codex"));
    assert.equal(codexAuthPath(), join(homedir(), ".codex", "auth.json"));
    process.env.CODEX_HOME = join("C:", "tmp", "codex");
    assert.equal(codexAuthPath(), join("C:", "tmp", "codex", "auth.json"));
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
  }
});
