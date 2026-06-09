// Self-test: drive the built MCP server over stdio and verify the share-preview integration:
//  1) initialize -> result.instructions present & mentions record/share
//  2) resources/list -> includes dota://guide/sharing
//  3) resources/read dota://guide/sharing -> markdown body
//  4) prompts/list -> includes share_assets & record_motion
//  5) prompts/get share_assets -> messages with the guide
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srv = spawn(process.execPath, [join(root, "dist", "index.js")], { stdio: ["pipe", "pipe", "pipe"] });

let buf = "";
const pending = new Map();
srv.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
srv.stderr.on("data", () => {}); // server logs to stderr

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("timeout " + method)); } }, 15000);
  });
}
function notify(method, params) {
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const checks = [];
const ok = (name, cond, extra = "") => { checks.push({ name, pass: !!cond, extra }); };

try {
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "selftest", version: "0.0.0" },
  });
  notify("notifications/initialized", {});
  const instr = init.result?.instructions || "";
  ok("initialize returns instructions", instr.length > 200, `len=${instr.length}`);
  ok("instructions mention dota_record", /dota_record/.test(instr));
  ok("instructions mention preview_studio", /preview_studio/.test(instr));
  ok("instructions point to dota://guide/sharing", /dota:\/\/guide\/sharing/.test(instr));

  const res = await rpc("resources/list", {});
  const uris = (res.result?.resources || []).map((r) => r.uri);
  ok("resources/list includes dota://guide/sharing", uris.includes("dota://guide/sharing"), uris.join(", "));

  const read = await rpc("resources/read", { uri: "dota://guide/sharing" });
  const text = read.result?.contents?.[0]?.text || "";
  ok("resource read returns the guide markdown", /Record MOTION/.test(text) && /preview_studio/.test(text), `len=${text.length}`);

  const pr = await rpc("prompts/list", {});
  const pnames = (pr.result?.prompts || []).map((p) => p.name);
  ok("prompts/list includes share_assets", pnames.includes("share_assets"), pnames.join(", "));
  ok("prompts/list includes record_motion", pnames.includes("record_motion"));

  const pg = await rpc("prompts/get", { name: "share_assets", arguments: {} });
  const ptext = pg.result?.messages?.[0]?.content?.text || "";
  ok("prompts/get share_assets returns the guide", /Sharing, previewing/.test(ptext), `len=${ptext.length}`);
} catch (e) {
  ok("no exceptions", false, String(e));
} finally {
  srv.kill();
}

let allPass = true;
for (const c of checks) {
  console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.extra ? "  [" + c.extra + "]" : ""}`);
  if (!c.pass) allPass = false;
}
console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
process.exit(allPass ? 0 : 1);
