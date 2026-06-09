import { test } from "node:test";
import assert from "node:assert/strict";
import { decompilePanorama, isCompiledPanorama, panoramaSourcePath } from "../src/dota/panorama-decompile.js";

// Build a buffer shaped like a compiled Source 2 panorama resource: short metadata
// runs separated by NULs, then the long embedded source run.
function fakeCompiled(source: string): Buffer {
  const parts = [
    Buffer.from("RED2", "latin1"),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("m_InputDependencies", "latin1"),
    Buffer.from([0, 0]),
    Buffer.from("panorama/styles/custom_game/x.css", "latin1"),
    Buffer.from([0, 0, 0]),
    Buffer.from("m_CompilerIdentifier", "latin1"),
    Buffer.from([0, 0]),
    Buffer.from(source, "latin1"),
    Buffer.from([0]),
  ];
  return Buffer.concat(parts);
}

test("decompilePanorama recovers embedded CSS source", () => {
  const css = ".BaseHud{width: 100%;height: 100%;flow-children: down;}#Wave{horizontal-align: right;margin-top: 62px;}";
  const out = decompilePanorama(fakeCompiled(css), "x.vcss_c");
  assert.equal(out, css);
});

test("decompilePanorama trims XML to the first tag", () => {
  const xml = "<root>\n\t<styles>\n\t\t<include src=\"file://{resources}/styles/x.vcss_c\" />\n\t</styles>\n</root>";
  const out = decompilePanorama(fakeCompiled("#" + xml), "y.vxml_c");
  assert.ok(out.startsWith("<root>"), `expected XML to start at <root>, got: ${out.slice(0, 20)}`);
  assert.ok(out.includes("<include"));
});

test("decompilePanorama recovers JS source", () => {
  const js = "// header\nvar X = 1;\nfunction foo(){ return GameEvents.Subscribe('x', function(){}); }";
  const out = decompilePanorama(fakeCompiled(js), "z.vjs_c");
  assert.equal(out, js);
});

test("decompilePanorama: a long metadata block must not beat the real source (regression)", () => {
  // A >800-char compiler/dependency run must be filtered unconditionally, not win by length.
  const meta = "m_InputDependencies " + "A".repeat(1200);
  const css = ".Hud{width: 100%;}#X{color: #fff;}";
  const buf = Buffer.concat([Buffer.from(meta, "latin1"), Buffer.from([0, 0]), Buffer.from(css, "latin1"), Buffer.from([0])]);
  const out = decompilePanorama(buf, "x.vcss_c");
  assert.equal(out, css, `expected the CSS, got: ${out.slice(0, 60)}`);
});

test("decompilePanorama: trailing compiler metadata after the CSS is trimmed", () => {
  const css = ".A{a: b;}.B{c: d;}";
  const buf = Buffer.concat([
    Buffer.from("m_CompilerIdentifier", "latin1"), Buffer.from([0]),
    Buffer.from(css + "TRAILING_GARBAGE_METADATA_xyz", "latin1"), Buffer.from([0]),
  ]);
  const out = decompilePanorama(buf, "y.vcss_c");
  assert.ok(out.endsWith("}"), `should trim trailing metadata after last }, got: ${out.slice(-30)}`);
  assert.ok(!out.includes("TRAILING_GARBAGE"), "trailing metadata must be trimmed");
});

test("decompilePanorama: picks the source-shaped run over a longer non-source run", () => {
  const longNonSource = "x".repeat(400); // long but not CSS-shaped
  const css = ".only{color: red;}";
  const buf = Buffer.concat([Buffer.from(longNonSource, "latin1"), Buffer.from([0]), Buffer.from(css, "latin1"), Buffer.from([0])]);
  const out = decompilePanorama(buf, "z.vcss_c");
  assert.equal(out, css);
});

test("isCompiledPanorama / panoramaSourcePath map extensions", () => {
  assert.equal(isCompiledPanorama("panorama/styles/a.vcss_c"), true);
  assert.equal(isCompiledPanorama("panorama/styles/a.css"), false);
  assert.equal(panoramaSourcePath("panorama/styles/a.vcss_c"), "panorama/styles/a.css");
  assert.equal(panoramaSourcePath("panorama/layout/a.vxml_c"), "panorama/layout/a.xml");
  assert.equal(panoramaSourcePath("panorama/scripts/a.vjs_c"), "panorama/scripts/a.js");
});
