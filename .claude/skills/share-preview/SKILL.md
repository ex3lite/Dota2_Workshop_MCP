---
name: share-preview
description: >-
  Show or SHARE Dota assets (particles, models, textures, sounds) so the user can SEE them,
  pick them, or open them remotely (phone/browser/over remote-access). Use whenever the user
  asks to show / preview / share / "дай посмотреть" / "шарни" / "на телефоне" / choose an asset,
  or wants a link to browse. Two paths: inline images in chat, or a shareable interactive
  gallery behind a public Cloudflare link.
---

# Sharing & previewing assets

Everything is decoded **out-of-engine** (ValveResourceFormat) — no Dota launch needed. First
run auto-installs the decoder (~100 MB, Windows). Assets come from the downloaded reference
games (grow the corpus with `workshop_download` / `ref_harvest`).

## Pick the path by intent

| User intent | Use | Result |
|---|---|---|
| "покажи / какие есть / превью пару штук" | `asset_preview`, `sound_preview` | **inline image** in chat (numbered contact sheet) — viewable over remote-access, no browser |
| "дай посмотреть / выбрать / на телефоне / шарни / покрутить модель / послушать" | `preview_studio` | **public link** to an interactive gallery (animated particles, 3D models, audio players) |

## A) Inline preview (fastest, in-chat)

- `asset_preview query="spark" kind="particle"` (kinds: `auto`/`texture`/`particle`/`model`)
- `sound_preview query="explosion"`
- Returns a numbered montage **image inline** + a self-contained HTML file on disk.
- Limits to state honestly: **models** can't rasterize inline (only show in the 3D gallery);
  **MP3 sounds** show a speaker tile + duration (MP3 can't be waveformed out-of-engine; PCM/WAV
  gets a real waveform). Particles show the **sprite**, not an animated render.

## B) Shareable interactive gallery + link (browse / pick on any device)

1. `preview_studio query="tower"` (optional `query`, `id`, per-kind counts, `share=false` for
   local-only). It builds the gallery, serves it, opens a **Cloudflare quick tunnel**, and returns
   a **public https URL** + a **manifest** (each card's ID → kind, name, source game id, VPK path).
2. Give the user the URL. In the gallery each card has an **ID badge** (`P#`/`M#`/`S#`/`T#`) and a
   **«выбрать»** button: they click the ones they want, then press **«Отправить»** (or just tell
   you the IDs in chat).
3. Read their choice:
   - `preview_selections` → the assets they **clicked + submitted** (resolved to game + path).
   - `preview_pick ids="M3,P7"` → resolve **named** IDs (when they say the IDs in chat).
4. `preview_studio_stop` when done.

Notes:
- The tunnel URL is **ephemeral** (changes when the gallery restarts). If an always-on daemon is
  running on the machine, the current URL is in `~/.claude-remote-control/preview-url.txt`.
- Particles in the gallery are an **approximation** (additive billboards driven by the real .vpcf
  params: sprite, emission, lifespan, size-over-life, colour, gravity) — they move and glow, but
  it's not the engine renderer. Models carry their textures when those are bundled in the game's
  VPK; models reusing base-Dota textures render untextured (the textures aren't in that VPK).

## C) Record MOTION (animated GIF in chat)

A static screenshot can't show a particle effect playing or gameplay moving. To show **motion**
directly in chat, record a short clip:

- `dota_record seconds=5 fps=12 width=480 target="game"` — records the **Dota window** (default;
  it finds the window, brings it to the foreground, grabs just that region) or `target="screen"`
  for the whole desktop. Returns a `.gif` path.
- **Length presets** (pick by what you're showing): `3` (a single cast/burst), `5` (default — one
  effect or action), `10` (a short sequence), `15` (a wave / rotation), `30` (a longer clip — drop
  `fps` to ~8–10 to keep the GIF small enough for Read to render smoothly).
- **Then `Read` that path** — an animated GIF opened with the Read tool **plays animated inline**
  in chat. (This is the one way to show motion: a GIF/MP4 sent as a *file* does NOT animate; Read
  does. Read also can't open mp4/webm — GIF is the format that works.)
- Needs Dota in **Windowed/Borderless** (gdigrab can't grab exclusive-fullscreen). Uses ffmpeg
  (auto-installs on first use, Windows). Keep clips short (≤ ~6s, 12fps, 480px) so the file stays
  small and Read renders it smoothly.

## Security

The Cloudflare link is **public** — anyone with it can view (and the gallery server runs on the
user's machine). Share it only with the user's own devices, don't post it publicly, and call
`preview_studio_stop` when finished.

## Sending a generated file directly

If you only need to hand over one artifact (a montage PNG, the gallery HTML), surface it with the
harness's file-send tool (e.g. `SendUserFile`) instead of a link — good when there's no need for a
live, browsable gallery.
