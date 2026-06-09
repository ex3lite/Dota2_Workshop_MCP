import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteLua } from "../src/tools/debugsdk.tools.js";

test("quoteLua wraps simple code", () => {
  assert.equal(quoteLua("1+1"), '"1+1"');
});

test("quoteLua converts double quotes to single (equivalent Lua delimiters)", () => {
  assert.equal(quoteLua('print("hi")'), "\"print('hi')\"");
});

test("quoteLua collapses newlines to spaces (one console token)", () => {
  assert.equal(quoteLua("a\nb\r\nc"), '"a b c"');
});

test("quoteLua escapes backslashes (regression: console treats \\ as escape)", () => {
  // input is x\y (single backslash) -> x\\y inside the quoted token
  assert.equal(quoteLua("x\\y"), '"x\\\\y"');
});
