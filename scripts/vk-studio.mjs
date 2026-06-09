// Serve the built _studio gallery on a fixed port and expose it via VK Tunnel
// (@vkontakte/vk-tunnel). VK tunnel needs a one-time interactive OAuth: it prints a login URL;
// after the user confirms in a browser we send ENTER on stdin. Coordination via files under
// <home>/.dota2-workshop-mcp/vktmp: oauth.txt (login URL), proceed (touch to send ENTER),
// url.txt (resulting public URL), full.log (raw output).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const ROOT = process.argv[2];
const PORT = parseInt(process.argv[3] || "8790", 10);
const VER = process.argv[4] || "latest";
const APP = process.argv[5] || "";
const VKD = path.join(os.homedir(), ".dota2-workshop-mcp", "vktmp");
fs.mkdirSync(VKD, { recursive: true });
const f = (n) => path.join(VKD, n);
for (const n of ["oauth.txt", "url.txt", "proceed", "full.log"]) { try { fs.rmSync(f(n)); } catch {} }

const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript", ".css":"text/css", ".png":"image/png", ".jpg":"image/jpeg", ".glb":"model/gltf-binary", ".wav":"audio/wav", ".mp3":"audio/mpeg", ".json":"application/json", ".svg":"image/svg+xml" };
http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p === "/" || p.endsWith("/")) p += "index.html";
  const file = path.join(ROOT, p.replace(/^\/+/, ""));
  if (!file.startsWith(path.normalize(ROOT))) { res.writeHead(403).end(); return; }
  fs.readFile(file, (e, b) => {
    if (e) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "access-control-allow-origin": "*" });
    res.end(b);
  });
}).listen(PORT, "127.0.0.1", () => console.error("SERVING " + PORT));

const appFlag = APP ? ` --app_id=${APP}` : "";
const proc = spawn(`npx -y @vkontakte/vk-tunnel@${VER} --port=${PORT} --http-protocol=http --ws-protocol=ws --host=127.0.0.1 --timeout=10000${appFlag}`, { shell: true });
let raw = "";
const strip = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
let oauthWritten = false, urlWritten = false;
function onData(d) {
  raw += d.toString();
  const clean = strip(raw);
  try { fs.writeFileSync(f("full.log"), clean); } catch {}
  const o = clean.match(/https:\/\/oauth\.vk\.(?:ru|com)\/\S+/);
  if (o && !oauthWritten) { oauthWritten = true; fs.writeFileSync(f("oauth.txt"), o[0]); }
  // Capture the public tunnel URL. With a cached token there is no oauth URL at all, so don't
  // gate on the proceed file — just exclude the auth/portal domains and prefer the tunnel host.
  const urls = (clean.match(/https:\/\/[^\s"')]+/g) || []).filter((u) => !/oauth\.vk|dev\.vk|\/\/vk\.com/.test(u));
  const tunnelUrl = urls.find((u) => /tunnel|vk-apps/.test(u)) || urls[urls.length - 1];
  if (tunnelUrl && !urlWritten) { urlWritten = true; fs.writeFileSync(f("url.txt"), tunnelUrl); console.error("TUNNEL " + tunnelUrl); }
}
proc.stdout.on("data", onData);
proc.stderr.on("data", onData);
proc.on("exit", (c) => console.error("VKTUNNEL_EXIT " + c));
let sent = false;
setInterval(() => { if (!sent && fs.existsSync(f("proceed"))) { sent = true; proc.stdin.write("\n"); console.error("SENT_ENTER"); } }, 800);
