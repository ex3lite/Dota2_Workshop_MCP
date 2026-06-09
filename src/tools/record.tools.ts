// dota_record — record a few seconds of the Dota window (or screen) to an ANIMATED GIF.
// Showing the GIF via the Read tool animates it inline in the chat (the one way to show
// MOTION in chat — GIF/video sent as files don't animate). Uses ffmpeg's gdigrab (Windows).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, stat, rm } from "node:fs/promises";
import { ensureFfmpeg } from "../dota/ffmpeg.js";
import { getDotaWindowRect } from "../dota/capture.js";
import { dotaBlockerHint } from "../dota/diagnose.js";
import { run } from "../dota/process.js";
import { json, error, guard, ToolResult } from "../util/result.js";

export function registerRecordTools(server: McpServer) {
  server.registerTool(
    "dota_record",
    {
      title: "Record a short clip of the game as an animated GIF",
      description:
        "Record a few seconds of the Dota WINDOW (or the whole screen) to an ANIMATED GIF — for showing motion " +
        "(particle effects, gameplay). Then Read the returned .gif path to view it ANIMATED inline in chat (GIF/MP4 sent " +
        "as files don't animate; an animated GIF opened with Read does). Uses ffmpeg (auto-installs on first use, " +
        "Windows). The game must be windowed/borderless — gdigrab can't capture exclusive-fullscreen. " +
        "Handy length presets: 3, 5, 10, 15, 30 s. e.g. dota_record seconds=5 fps=12.",
      inputSchema: {
        seconds: z.number().int().min(1).max(30).optional().describe("Clip length in seconds (default 5; presets 3/5/10/15/30). Longer clips make bigger GIFs — drop fps for length."),
        fps: z.number().int().min(5).max(24).optional().describe("Frames per second (default 12; lower = smaller file)."),
        width: z.number().int().min(120).max(1280).optional().describe("Output width in px, aspect kept (default 480)."),
        target: z.enum(["game", "screen"]).optional().describe("'game' = the Dota window (default), 'screen' = whole desktop."),
      },
    },
    guard(async ({ seconds, fps, width, target }): Promise<ToolResult> => {
      const sec = seconds ?? 5;
      const f = fps ?? 12;
      const w = width ?? 480;
      const tgt = target ?? "game";
      const ff = await ensureFfmpeg();
      const outDir = join(homedir(), ".dota2-workshop-mcp", "recordings");
      await mkdir(outDir, { recursive: true });
      const out = join(outDir, "clip.gif");
      const tmp = join(outDir, "_raw.mp4");

      // gdigrab can grab the whole virtual desktop ("-i desktop"), or a screen REGION via
      // -offset_x/-offset_y/-video_size (raw screen coords). To record just the game we find the
      // dota window rect, bring it to the foreground (so it isn't occluded), and grab that region.
      // Falling back to the full desktop guarantees we never hang waiting for a window by title.
      let rect = null as Awaited<ReturnType<typeof getDotaWindowRect>>;
      if (tgt === "game") {
        rect = await getDotaWindowRect(true).catch(() => null);
      }

      // Two-step, because a single-pass palettegen on a LIVE source HANGS: palettegen buffers the
      // whole stream and only emits the palette at input-EOF, but with a continuous gdigrab feed
      // and `-t` as an output limit no output frame is ever produced, so `-t` never fires → wedge.
      //   1) capture the region/desktop to a finite mp4 (continuous output → `-t` reliably stops),
      //   2) convert that finite file to a high-quality GIF (palettegen is safe on a finite input).
      const pre = ["-hide_banner", "-loglevel", "error", "-f", "gdigrab", "-framerate", String(f)];
      const inputArgs = rect
        ? ["-offset_x", String(rect.left), "-offset_y", String(rect.top), "-video_size", `${rect.width}x${rect.height}`, "-i", "desktop"]
        : ["-i", "desktop"];
      const capArgs = [...pre, ...inputArgs, "-t", String(sec), "-vf", `fps=${f},scale=${w}:-2:flags=lanczos`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", tmp];
      const cap = await run(ff, capArgs, { timeoutMs: (sec + 20) * 1000, maxOutputChars: 60000 });

      const tmpSt = await stat(tmp).catch(() => null);
      if (!tmpSt || !tmpSt.size) {
        const hint =
          tgt === "game"
            ? rect
              ? "Captured the Dota window region but got no frames — is it in exclusive-fullscreen? Try Borderless/Windowed, or target='screen'."
              : "Couldn't find the Dota window (not running, minimized, or exclusive-fullscreen). Try target='screen'."
            : "Screen capture failed.";
        const blocker = await dotaBlockerHint();
        return error(`No clip captured. ${hint}${blocker}\nffmpeg: ${(cap.stderr || cap.stdout).slice(-400)}`);
      }

      const gifVf = `split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3`;
      const conv = await run(ff, ["-hide_banner", "-loglevel", "error", "-i", tmp, "-vf", gifVf, "-y", out], { timeoutMs: 60_000, maxOutputChars: 60000 });
      await rm(tmp, { force: true }).catch(() => {});

      const st = await stat(out).catch(() => null);
      if (!st || !st.size) {
        return error(`Captured the clip but GIF conversion failed.\nffmpeg: ${(conv.stderr || conv.stdout).slice(-400)}`);
      }
      const captured = tgt === "screen" ? "screen" : rect ? "game window" : "screen (Dota window not found)";
      return json(
        { path: out, seconds: sec, fps: f, width: w, bytes: st.size, target: tgt, captured, rect },
        `Recorded ${sec}s GIF — ${Math.round(st.size / 1024)} KB @ ${f}fps, captured: ${captured}.\n${out}\n` +
          `➡ Read this path to view it ANIMATED inline in chat.`,
      );
    }),
  );
}
