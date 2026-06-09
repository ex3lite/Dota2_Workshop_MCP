// Single source of truth for the server's self-description and the asset
// preview / share / record guidance. Surfaced three MCP-native ways so the knowledge travels
// WITH the server wherever it is installed — no repo-local Claude Code skill required:
//   - server `instructions`  (auto-injected into the client on connect)      -> SERVER_INSTRUCTIONS
//   - a readable resource    dota://guide/sharing                            -> SHARING_GUIDE
//   - invocable prompts      share_assets / record_motion                    -> SHARING_GUIDE
// Keep this in sync with .claude/skills/share-preview/SKILL.md (same content, different delivery).

/** Full how-to for showing / sharing / recording assets. Served as a resource + prompt body. */
export const SHARING_GUIDE = `# Sharing, previewing & recording Dota assets

Everything is decoded **out-of-engine** (ValveResourceFormat) — no Dota launch needed. First run
auto-installs the decoder (~100 MB, Windows). Assets come from the downloaded reference games
(grow the corpus with \`workshop_download\` / \`ref_harvest\`). Recording uses ffmpeg (also
auto-installed on first use).

## Pick the path by intent

| User intent | Use | Result |
|---|---|---|
| "покажи / какие есть / превью пару штук" | \`asset_preview\`, \`sound_preview\` | **inline image** in chat (numbered contact sheet) — viewable over remote-access, no browser |
| "дай посмотреть / выбрать / на телефоне / шарни / покрутить модель / послушать" | \`preview_studio\` | **public link** to an interactive gallery (animated particles, 3D models, audio players) |
| "покажи как это двигается / запиши / гифку / эффект в движении" | \`dota_record\` then **Read** the .gif | **animated GIF inline** in chat (the one way to show motion) |

## A) Inline preview (fastest, in-chat)

- \`asset_preview query="spark" kind="particle"\` (kinds: \`auto\`/\`texture\`/\`particle\`/\`model\`)
- \`sound_preview query="explosion"\`
- Returns a numbered montage **image inline** + a self-contained HTML file on disk.
- State limits honestly: **models** can't rasterize inline (only in the 3D gallery); **MP3 sounds**
  show a speaker tile + duration (MP3 can't be waveformed out-of-engine; PCM/WAV gets a real
  waveform). Particles show the **sprite**, not an animated render.

## B) Shareable interactive gallery + link (browse / pick on any device)

1. \`preview_studio query="tower"\` (optional \`query\`, \`id\`, per-kind counts, \`share=false\` for
   local-only). Builds the gallery, serves it, opens a **Cloudflare quick tunnel**, returns a
   **public https URL** + a **manifest** (each card's ID → kind, name, source game id, VPK path).
2. Give the user the URL. Each card has an **ID badge** (\`P#\`/\`M#\`/\`S#\`/\`T#\`) and a **«выбрать»**
   button: they click what they want, then press **«Отправить»** (or just tell you the IDs in chat).
3. Read their choice:
   - \`preview_selections\` → the assets they **clicked + submitted** (resolved to game + path).
   - \`preview_pick ids="M3,P7"\` → resolve **named** IDs (when they say the IDs in chat).
4. \`preview_studio_stop\` when done.

Notes:
- The tunnel URL is **ephemeral** (changes when the gallery restarts). If an always-on daemon is
  running on the machine, the current URL is in \`~/.claude-remote-control/preview-url.txt\`.
- Particles in the gallery are an **approximation** (additive billboards driven by the real .vpcf
  params: sprite, emission, lifespan, size-over-life, colour, gravity) — they move and glow, but
  it's not the engine renderer. Models carry their textures when those are bundled in the game's
  VPK; models reusing base-Dota textures render untextured (textures aren't in that VPK).

## C) Record MOTION (animated GIF in chat)

A static screenshot can't show a particle effect playing or gameplay moving. To show **motion**
directly in chat, record a short clip:

- \`dota_record seconds=5 fps=12 width=480 target="game"\` — records the **Dota window** (default; it
  finds the window, brings it to the foreground, grabs just that region) or \`target="screen"\` for
  the whole desktop. Returns a \`.gif\` path.
- **Length presets** (pick by what you're showing): \`3\` (a single cast/burst), \`5\` (default — one
  effect or action), \`10\` (a short sequence), \`15\` (a wave / rotation), \`30\` (a longer clip — drop
  \`fps\` to ~8–10 to keep the GIF small enough for Read to render smoothly).
- **Then \`Read\` that path** — an animated GIF opened with the Read tool **plays animated inline** in
  chat. (This is the one way to show motion: a GIF/MP4 sent as a *file* does NOT animate; Read does.
  Read also can't open mp4/webm — GIF is the format that works.)
- Needs Dota in **Windowed/Borderless** (gdigrab can't grab exclusive-fullscreen). Internally it's a
  two-step pipeline (capture region → finite mp4 → GIF) so it never hangs.

## Security

The Cloudflare link is **public** — anyone with it can view (and the gallery server runs on the
user's machine). Share it only with the user's own devices, don't post it publicly, and call
\`preview_studio_stop\` when finished.

## Sending a generated file directly

If you only need to hand over one artifact (a montage PNG, the gallery HTML), surface it with the
harness's file-send tool (e.g. \`SendUserFile\`) instead of a link — good when there's no need for a
live, browsable gallery.`;

/**
 * Server-wide instructions injected into the client on connect (MCP `initialize` result).
 * A high-signal map of what the server does, with the show/share/record decision built in so any
 * connecting agent knows how to surface assets without a separate skill file.
 */
export const SERVER_INSTRUCTIONS = `dota2-workshop-mcp — a toolkit for building Dota 2 custom games (Source 2 Workshop Tools).

Capability map:
- Authoring: KV/KV3 read+write, soundevents, custom events & net tables, VScript/Panorama API docs, scaffolding new addons, building maps from a spec, top-down map generation.
- Reference corpus: download & index Workshop custom games (workshop_download / ref_harvest), browse and search their assets (reflib), SQLite-backed asset index across all downloaded games.
- Decoding (out-of-engine, no Dota launch, ValveResourceFormat): textures → PNG, models → glTF/GLB with materials, particles (.vpcf) → params, sounds → wav/mp3.
- Live game: launch/control Dota, in-engine screenshots, OS-level window capture, and short GIF recordings of the running game.

SHOWING / SHARING / RECORDING ASSETS — the most common request. Choose by intent:
- "покажи / превью пару штук" → asset_preview / sound_preview → a numbered montage IMAGE inline in chat (works over remote-access, no browser).
- "дай выбрать / на телефоне / шарни / покрутить модель / послушать" → preview_studio → a PUBLIC Cloudflare link to an interactive gallery (animated particles, 3D models, audio); read their picks with preview_selections / preview_pick; preview_studio_stop when done.
- "покажи в движении / запиши / гифку" → dota_record (seconds preset 3/5/10/15/30, default 5) → then Read the returned .gif path: an animated GIF opened with Read PLAYS ANIMATED inline (a GIF/MP4 sent as a file does not; Read can't open mp4/webm).

Honest limits: models don't rasterize as inline images (gallery only); MP3 has no out-of-engine waveform (speaker tile + duration); gallery particles are an additive-billboard approximation, not the engine renderer; gdigrab can't capture exclusive-fullscreen (use Windowed/Borderless). The Cloudflare link is PUBLIC — share only with the user's own devices.

Full how-to: read the resource dota://guide/sharing, or invoke the prompt share_assets (or record_motion).`;
