// Bring up the interactive preview gallery + a public Cloudflare tunnel, and stay alive.
// Usage: npx tsx scripts/preview-studio.mts [query]
import { buildStudioGallery } from "../src/dota/studio.js";
import { serveDir } from "../src/dota/serve.js";
import { startQuickTunnel } from "../src/dota/tunnel.js";

const query = process.argv[2] || undefined;
const r = await buildStudioGallery({ query });
console.error("COUNTS " + JSON.stringify(r.counts));
const srv = await serveDir(r.dir);
console.error("LOCAL " + srv.url);
try {
  const tun = await startQuickTunnel(srv.url);
  console.error("PUBLIC " + tun.url);
} catch (e) {
  console.error("TUNNEL_FAIL " + (e instanceof Error ? e.message : e));
}
console.error("READY");
setInterval(() => {}, 1 << 30);
