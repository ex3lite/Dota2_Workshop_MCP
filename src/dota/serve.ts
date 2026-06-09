// Minimal static file server (no deps) for previewing a gallery directory locally and
// exposing it through a tunnel. Read-only, binds to 127.0.0.1, path-traversal guarded.

import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
};

export interface StaticServer {
  url: string; // http://127.0.0.1:<port>
  port: number;
  close: () => Promise<void>;
}

/** Serve `root` over HTTP on 127.0.0.1. Port 0 = pick a free port. */
export function serveDir(root: string, port = 0): Promise<StaticServer> {
  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      let rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
      if (rel === "" || rel.endsWith("/")) rel = join(rel, "index.html");
      const full = join(root, rel);
      if (!full.startsWith(normalize(root))) {
        res.writeHead(403).end("forbidden");
        return;
      }
      const st = await stat(full).catch(() => null);
      if (!st || !st.isFile()) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": MIME[extname(full).toLowerCase()] || "application/octet-stream",
        "content-length": st.size,
        "cache-control": "no-cache",
        "access-control-allow-origin": "*",
      });
      createReadStream(full).pipe(res);
    } catch {
      res.writeHead(500).end("error");
    }
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        url: `http://127.0.0.1:${p}`,
        port: p,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
