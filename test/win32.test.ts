import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeSendKeys } from "../src/dota/win32.js";

test("escapeSendKeys wraps SendKeys metacharacters in braces", () => {
  // + ^ % ~ ( ) { } [ ] are special to WScript.Shell SendKeys.
  assert.equal(escapeSendKeys("a+b"), "a{+}b");
  assert.equal(escapeSendKeys("100%"), "100{%}");
  assert.equal(escapeSendKeys("f(x)"), "f{(}x{)}");
  assert.equal(escapeSendKeys("a^b~c"), "a{^}b{~}c");
  assert.equal(escapeSendKeys("arr[0]"), "arr{[}0{]}");
});

test("escapeSendKeys leaves ordinary text untouched", () => {
  assert.equal(escapeSendKeys("hello world 123"), "hello world 123");
  assert.equal(escapeSendKeys("npc_dota_hero_axe"), "npc_dota_hero_axe");
});

test("escapeSendKeys escapes literal braces so they are not parsed as key names", () => {
  assert.equal(escapeSendKeys("{ENTER}"), "{{}ENTER{}}");
});
