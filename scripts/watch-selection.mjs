// Auto-hook watcher: emit a line the instant the preview gallery's selection is submitted.
// Event-driven via fs.watch (near-instant on write), with a low-frequency mtime backstop in
// case a watch event is missed. Fires once per submit (debounced) — even if the same set is
// re-submitted — and updates the mtime baseline in emit() so the backstop never double-fires.
// Used by the Monitor tool: `node scripts/watch-selection.mjs [selections.json]`.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const file = process.argv[2] || path.join(os.homedir(), ".dota2-workshop-mcp", "previews", "_studio", "selections.json");
const dir = path.dirname(file);
let lastMtime = "";
try { lastMtime = String(fs.statSync(file).mtimeMs); } catch { /* not created yet */ }

let debounce = null;
function emit() {
  try {
    lastMtime = String(fs.statSync(file).mtimeMs); // claim this write so the backstop won't re-fire
    const c = fs.readFileSync(file, "utf8").trim();
    process.stdout.write("SELECTION " + (c || "[]") + "\n");
  } catch { /* file vanished mid-rewrite; next event will catch it */ }
}
function trigger() { clearTimeout(debounce); debounce = setTimeout(emit, 80); }

// Primary: event-driven watch on the directory (the file is rewritten in place on submit).
try { fs.watch(dir, (_ev, name) => { if (name === "selections.json") trigger(); }); } catch { /* fall back to poll only */ }

// Backstop: catch anything fs.watch missed (some filesystems are flaky), low frequency.
setInterval(() => {
  try { const m = String(fs.statSync(file).mtimeMs); if (m !== lastMtime) trigger(); } catch { /* ignore */ }
}, 1500);

// Keep alive.
setInterval(() => {}, 1 << 30);
