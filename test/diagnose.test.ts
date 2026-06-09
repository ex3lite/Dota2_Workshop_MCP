import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyWindow, pickSafeButton, type RawWindow } from "../src/dota/diagnose.js";

// Real window data captured from a stuck Source 2 tools session (the user's gemtd_1p assert).
function w(p: Partial<RawWindow>): RawWindow {
  return { hwnd: "1", visible: false, left: 0, top: 0, width: 100, height: 30, className: "", title: "", childTexts: [], buttons: [], ...p };
}

test("classifies the real engine assert dialog (#32770)", () => {
  const win = w({
    className: "#32770",
    title: "Code Assertion Failed",
    width: 592,
    height: 397,
    childTexts: [
      "Location:",
      "C:\\buildworker\\source2_dota_rel_2019_win64\\build\\src\\game\\shared\\dynamicprop.cpp (199)",
      "Assert:",
      'Assertion Failed in function CDynamicProp::HandleSpawnBackCompat(): Map "gemtd_1p" is using the obsolete HoldAnimation key',
    ],
    buttons: ["&Break in Debugger", "&Ignore This Assert", "Ignore &All Asserts", "&Copy to Clipboard"],
  });
  assert.equal(classifyWindow(win), "assert");
});

test("classifies the watchdog Stall Detected window", () => {
  assert.equal(classifyWindow(w({ className: "WatchdogThreadWndClass", title: "Stall Detected", width: 300, height: 150 })), "stall");
});

test("classifies the main game render window", () => {
  assert.equal(classifyWindow(w({ className: "SDL_app", title: "Dota 2", visible: true, width: 2116, height: 1029 })), "game");
});

test("Qt tool windows are 'tools', not blockers", () => {
  assert.equal(classifyWindow(w({ className: "Qt5152QWindowIcon", title: "Asset Browser", width: 1066, height: 739 })), "tools");
});

test("IME / shadow / zero-size helper windows are noise", () => {
  assert.equal(classifyWindow(w({ className: "MSCTFIME UI", title: "MSCTFIME UI", width: 0, height: 0 })), "noise");
  assert.equal(classifyWindow(w({ className: "Default IME", title: "Default IME", width: 0, height: 0 })), "noise");
  assert.equal(classifyWindow(w({ className: "Qt5152QWindowPopupDropShadowSaveBits", title: "dota2", width: 100, height: 30 })), "noise");
});

test("a #32770 with crash text is a crash, generic otherwise a dialog", () => {
  assert.equal(classifyWindow(w({ className: "#32770", title: "Error", childTexts: ["Unhandled exception / access violation"] })), "crash");
  assert.equal(classifyWindow(w({ className: "#32770", title: "Confirm", width: 400, height: 200, childTexts: ["Overwrite existing file?"] })), "dialog");
});

test("pickSafeButton prefers 'Ignore All Asserts' and never a dangerous button", () => {
  assert.equal(pickSafeButton(["&Break in Debugger", "&Ignore This Assert", "Ignore &All Asserts", "&Copy to Clipboard"]), "Ignore All Asserts");
  assert.equal(pickSafeButton(["&Ignore This Assert", "&Break in Debugger"]), "Ignore This Assert");
  // Only dangerous buttons available -> refuse (return null) so we don't attach a debugger / kill.
  assert.equal(pickSafeButton(["&Break in Debugger", "Broadcast &Minidump", "Auto &Select Debugger"]), null);
  // Generic OK dialog.
  assert.equal(pickSafeButton(["OK"]), "OK");
});
