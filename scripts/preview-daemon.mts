// Always-on preview gallery: serve the built _studio gallery + a Cloudflare tunnel, and
// write the current public URL to a status file (the quick-tunnel URL changes only on
// restart). A watchdog exits the process if the tunnel stops responding, so the keep-alive
// supervisor (autostart.ps1) respawns the whole thing. Run: npx tsx scripts/preview-daemon.mts
import { buildStudioGallery } from "../src/dota/studio.js";
import { serveDir } from "../src/dota/serve.js";
import { startQuickTunnel } from "../src/dota/tunnel.js";
import { existsSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const STATUS = join(HOME, ".claude-remote-control", "preview-url.txt");
const LOG = join(HOME, ".claude-remote-control", "preview.log");
const DIR = join(HOME, ".dota2-workshop-mcp", "previews", "_studio");
const PORT = 8791;
const log = (m: string) => { try { appendFileSync(LOG, new Date().toISOString() + "  " + m + "\n"); } catch { /* ignore */ } };

log("preview daemon starting (pid " + process.pid + ")");

// Reuse an already-built gallery (fast restart); build only if missing.
if (!existsSync(join(DIR, "index.html"))) {
  log("no gallery found — building...");
  await buildStudioGallery({});
  log("gallery built");
} else {
  log("reusing existing gallery at " + DIR);
}

const srv = await serveDir(DIR, PORT);
log("serving locally at " + srv.url);

let publicUrl: string | undefined;
try {
  const tun = await startQuickTunnel(srv.url);
  publicUrl = tun.url;
  writeFileSync(STATUS, tun.url, "utf8");
  log("tunnel up: " + tun.url);
} catch (e) {
  writeFileSync(STATUS, "LOCAL " + srv.url, "utf8");
  log("tunnel failed (" + (e instanceof Error ? e.message : e) + ") — serving locally only");
}

// Watchdog: if the public tunnel stops responding, exit(1) so the supervisor respawns us
// (which gets a fresh tunnel URL). Only meaningful when the tunnel came up.
if (publicUrl) {
  let fails = 0;
  setInterval(async () => {
    try {
      const r = await fetch(publicUrl + "/index.html", { signal: AbortSignal.timeout(12000) });
      fails = r.ok ? 0 : fails + 1;
    } catch {
      fails++;
    }
    if (fails >= 3) { log("tunnel unhealthy (" + fails + " fails) — exiting for respawn"); process.exit(1); }
  }, 60000);
}

setInterval(() => {}, 1 << 30); // keep alive
