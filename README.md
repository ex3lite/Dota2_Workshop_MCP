# Dota 2 Workshop MCP

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant (Claude Code, Claude
Desktop, Cursor, …) develop **Dota 2 custom games** with the Workshop Tools: edit KeyValues,
scaffold abilities/modifiers/items/units/heroes/Panorama, search the VScript (Lua) modding API,
and build & launch the game.

It is **template-aware**: for a [ModDota TypeScript addon
template](https://github.com/ModDota/TypeScript-Addon-Template) it scaffolds **TypeScript**
(`@registerAbility` / `@registerModifier`, KV `ScriptFile` pointing at the compiled `.lua`, `#base`
wiring) and drives the template's `npm` scripts. It also has a raw-Lua + `resourcecompiler.exe`
fallback for non-tstl addons.

> Status: working — **107 tools**, end-to-end tested. It can search the Workshop for custom games by
> name and download them outside the client (SteamCMD) to study, generates whole playable maps from a spec
> (terrain shaping via the Dota tile grid + entities + waypoint paths → compile → .vpk), previews them
> top-down as an image without launching the game, edits KV1 + KV3 (soundevents/particles) data, reads
> base-game files straight out of the VPKs, and scaffolds TS/Lua content, Panorama, custom events & net
> tables, and can read/learn from any subscribed custom game's files. The live debug loop runs
> over the **VConsole2** protocol (verified against a running client: connect, send commands, read live
> output, hot-reload, restart, screenshot, error-watch) and a bundled, searchable copy of the VScript
> API, the Panorama JS API, the ModDota guides, and a knowledge base of design patterns distilled from
> shipping games (`dota_patterns`) ships for offline use. `scaffold_td` emits both the canonical
> waypoint tower-defense director and, with `maze: true`, a GemTD-style maze TD (grid A* pathfinder +
> build validation that never lets players fully wall off the path).

## Features

| Area | Tools |
| --- | --- |
| **Diagnostics & status** | `dota_doctor`, `addon_list`, `addon_info`, `dota_status`, `addon_audit` |
| **KeyValues** | `kv_read`, `kv_get_entry`, `kv_upsert_entry`, `kv_remove_entry`, `kv_validate`, `kv_format` |
| **Scaffolding** | `scaffold_ability`, `scaffold_modifier`, `scaffold_item`, `scaffold_unit`, `scaffold_hero`, `scaffold_panorama_panel` |
| **Systems scaffolders** | `scaffold_notifications`, `scaffold_nettable_binding`, `scaffold_rpc`, `scaffold_save_codes`, `scaffold_hud_panel`, `scaffold_wave_system`, `scaffold_shop`, `scaffold_talent_tree` (battle-tested infra distilled from shipping games) |
| **VScript API** | `lua_api_search`, `lua_api_get`, `lua_api_class_methods` |
| **Build & launch** | `addon_build`, `addon_compile_content`, `addon_launch_tools`, `addon_launch_custom_game`, `addon_link` |
| **Live debug loop** | `dota_send_console_command`, `dota_read_console_log`, `dota_reload_scripts`, `dota_restart_game`, `dota_dev_cycle`, `dota_screenshot`, `dota_watch_errors`, `dota_wait_for`, `dota_perf` |
| **Window & input** | `dota_window`, `dota_focus_window`, `dota_click`, `dota_type`, `dota_input` |
| **In-game DebugSDK** | `addon_attach_debug_sdk`, `addon_detach_debug_sdk`, `dota_lua_eval`, `dota_debug_dump`, `dota_selftest` |
| **Reference library** | `ref_harvest`, `ref_harvest_top`, `ref_list`, `ref_search`, `ref_find`, `ref_passport`, `ref_inspect`, `ref_get`, `ref_recipe`, `ref_curate`, `ref_stats`, `asset_db` (SQLite index: fast structured search by kind/ext/name) |
| **Docs & references** | `docs_search`, `docs_get`, `docs_list`, `dota_patterns`, `panorama_api_search`, `panorama_api_get`, `tools_catalog` |
| **Maps** | `map_create`, `map_add_entity`, `map_to_text`, `map_from_text`, `map_compile`, `map_list` |
| **Map generation** | `map_build`, `map_terrain`, `map_preview`, `map_tile_to_world`, `entity_catalog`, `scaffold_td` |
| **Reference games** | `workshop_search`, `workshop_download`, `workshop_list`, `workshop_inspect`, `workshop_read`, `workshop_grep`, `panorama_decompile` |
| **Asset preview (out of engine)** | `asset_preview` (particles/textures/models → inline contact-sheet image + HTML gallery), `sound_preview` (sounds → inline waveform/icon image + playable HTML soundboard + inline audio), `preview_studio` / `preview_studio_stop` (interactive gallery + public share link: animated particles, 3D models, audio players, click-to-select), `preview_pick` / `preview_selections` (resolve the IDs the user picked/clicked → game + asset path) — decoded via ValveResourceFormat, no Dota launch |
| **Sounds & KV3** | `soundevents_list`, `soundevents_get`, `soundevents_upsert`, `kv3_read` |
| **Assets & base game** | `assets_list`, `assets_search`, `vpk_find`, `vpk_read`, `base_kv_entry` |
| **Events & net tables** | `scaffold_custom_event`, `scaffold_net_table` |

Everything is bundled so search works **offline**:
- VScript (Lua) API — 97 classes / 242 globals / 72 enums, from [@moddota/dota-data](https://github.com/ModDota/dota-data).
- Panorama JS API — 62 interfaces / ~880 members / 18 globals, from [@moddota/panorama-types](https://github.com/ModDota/TypeScriptDeclarations).
- 93 guide pages: 83 ModDota articles (scripting, abilities, modifiers, units, panorama, assets, tools) from
  [moddota.com](https://moddota.com), a task-oriented **Custom Game Cookbook** index (`guides/custom-game-cookbook`)
  tying the tools/docs/patterns together, plus nine hand-authored references bundled with the MCP — **Particles &
  Effects in Panorama** (`panorama/particles-and-effects`) and the **Dota 2 Panorama CSS Reference**
  (`panorama/dota-css-reference`), and seven docs *distilled from a deep analysis of 34 shipping custom games*: the
  **Panorama Animations & Effects Cookbook** (`panorama/animations-cookbook`), **Custom Game HUD & UX Patterns**
  (`panorama/hud-ux-patterns`), **Custom Game Architecture & Systems Patterns** (`scripting/custom-game-architecture`),
  **Particles, Sound & Game Feel** (`scripting/particles-sound-gamefeel`), **AI & Combat Patterns**
  (`scripting/ai-combat-patterns`), **Hijacking & Extending Dota's Native HUD** (`panorama/native-hud-hijacking`),
  and **Advanced Techniques & Engine-Limit Workarounds** (`scripting/advanced-techniques`).
- A `dota_patterns` knowledge base of **77** reusable engineering patterns, each attributed to the shipping games
  it was learned from (distilled from a 58-game decompiled reference corpus).
- A curated catalog of Dota 2 modding tools, libraries and references.

Refresh the bundled data anytime with `npm run build:data` (re-fetches all of the above).

## Requirements

- Node.js ≥ 18 (developed on Node 25)
- Dota 2 + the free **Dota 2 Workshop Tools** DLC installed
- Windows (build/launch shell out to `dota2.exe` / `resourcecompiler.exe`; KV + API tools are cross-platform)

## Install

```bash
git clone https://github.com/ex3lite/Dota2_Workshop_MCP.git
cd Dota2_Workshop_MCP
npm install        # also builds via the prepare script
npm run build:data # (optional) refresh bundled VScript API + Panorama API + ModDota guides
```

`npm install` runs `npm run build`, producing `dist/index.js` (the server entry point).

## Configure

The server needs to know two things:

- **Which addon project** you're working on — set `DOTA2_ADDON_DIR` to the addon root (the folder
  with `package.json` / `game` / `content`), or pass `projectRoot` to any tool.
- **Where Dota 2 is** — auto-detected from the Windows registry + `libraryfolders.vdf`. Override
  with `DOTA2_PATH` (point it at your `dota 2 beta` folder) if detection fails.

### Claude Code

Copy [`examples/claude-code.mcp.json`](examples/claude-code.mcp.json) to your addon repo as
`.mcp.json` (adjust the two paths), or:

```bash
claude mcp add dota2-workshop --env DOTA2_ADDON_DIR=C:\path\to\addon -- node C:\path\to\Dota2_Workshop_MCP\dist\index.js
```

### Claude Desktop

Merge [`examples/claude-desktop.config.json`](examples/claude-desktop.config.json) into
`%APPDATA%\Claude\claude_desktop_config.json` (absolute paths; restart the app).

### Cursor / other IDEs

Use [`examples/cursor.mcp.json`](examples/cursor.mcp.json) at `.cursor/mcp.json` or
`~/.cursor/mcp.json`. Any stdio MCP client works — only the config location differs.

## Typical flow

1. `dota_doctor` — confirm Dota is found, the addon is detected, and it's linked into `dota_addons`.
2. `scaffold_ability` `{ name: "my_hero_fireball", behavior: "point" }` — writes the TS source, the
   `npc_abilities_custom.txt` block, and localization tokens.
3. `lua_api_search` / `lua_api_get` — look up the exact VScript signatures while writing the logic.
4. `addon_build` — compile TypeScript → Lua (`npm run build`).
5. `addon_launch_custom_game` `{ map: "..." }` — boot tools mode and start the map.

All build/launch tools accept `dryRun: true` to preview the exact command without running it.

## Live debugging & iteration

The debug tools drive a running game through the **VConsole2** protocol — the same channel
`vconsole2.exe` uses. In `-tools` mode the game listens on `127.0.0.1:29000` (override with
`-vconport`, or the `DOTA2_VCONPORT` env var on the MCP side). This is the reliable path on Windows:
the classic `-netconport` telnet console has been broken on Windows since 2023, and `console.log` is
buffered until the client exits — so live output is read from the VConsole `PRNT` stream instead.

The launch tools already pass `-tools` (and `-vconport`), so the channel is available after
`addon_launch_custom_game`. Then:

- **`dota_send_console_command`** — run any console command and get back the output it printed.
- **`dota_read_console_log`** — read recent live console output (with optional `grep`).
- **`dota_reload_scripts`** — compile + `script_reload` (hot-reload Lua without relaunch).
- **`dota_restart_game`** — `taskkill` + relaunch + reconnect (for changes that can't hot-reload).
- **`dota_dev_cycle`** — one call: build, then pick the cheapest apply path (with `autoRestart` if a reload errors).
- **`dota_screenshot`** — two variants: **`game`** = the in-game render via the `jpeg` console command (the true
  rendered frame); **`window`** = the dota2 window captured with **real screen pixels** (so the 3D viewport is *not*
  black — unlike `PrintWindow`), focusing the window first. (`print` = offscreen PrintWindow for occluded windows.)
- **`dota_watch_errors`** — scan the live console for Lua/engine errors (script error, stack traceback, *.lua:NN, …).
- **`dota_wait_for`** — block until a console line matches (optionally after sending a command) — for sequencing tests.

What hot-reloads vs needs a restart:

| Change | Action |
| --- | --- |
| Lua function bodies | `dota_reload_scripts` (`script_reload`) |
| Panorama (xml/css/js) | auto-reloads after compile — no relaunch |
| KV files (`npc_*_custom.txt`) | `dota_restart_game` (full relaunch) |
| New/removed scripts, changed class structure, registrations | `dota_restart_game` |

> Tip: the ModDota template uses `Dynamic_Wrap`/`GameRules.Addon.Reload()` so reloaded code is
> picked up — keep event listeners wrapped for `script_reload` to take effect.

## Window control & input injection

Drive the game window and inject mouse/keyboard at the OS level (Windows). Coordinates are **client-relative** by
default (the render area's top-left), so they line up with what a `window` screenshot shows; use `nx`/`ny` for a
fraction of the client area. Everything is batched into a single PowerShell call per tool so sequences run fast.

- **`dota_focus_window`** — focus (`focus:true`, beats the Windows foreground lock via `AttachThreadInput`) or send to
  back (`focus:false`). Focus is needed before reliable clicks.
- **`dota_window`** — `info` (geometry + foreground/minimized state), `focus`/`unfocus`/`minimize`/`restore`/
  `maximize`/`show`/`hide`, or `move` (x/y/w/h).
- **`dota_click`** — move + click (left/right/middle, double) at `x,y` or `nx,ny`.
- **`dota_type`** — type literal `text`, or send `keys` chords (`{ENTER}`, `{ESC}`, `^a`, …).
- **`dota_input`** — a whole `actions` sequence (`move`/`click`/`down`/`up`/`drag`/`scroll`/`key`/`text`/`sleep`) in one
  fast call — the way to script a self-test interaction.

## In-game DebugSDK + self-test

The **DebugSDK** is a self-contained Lua module bundled with the MCP. Attach it to any addon and it registers `mcp_*`
console commands the MCP drives over VConsole for **deterministic** control and inspection — the fast, reliable path for
self-testing (no pixel guessing).

- **`addon_attach_debug_sdk`** — copy `mcp_debug.lua` into the addon and wire `require("mcp_debug")` into the game-mode
  bootstrap (TS *or* Lua). Idempotent; `addon_detach_debug_sdk` reverses it. Then `addon_build` (tstl) + `dota_restart_game`.
- **`dota_lua_eval`** — run a Lua snippet on the live server and get the JSON result (`mcp_eval`).
- **`dota_debug_dump`** — dump game state as JSON: `state` (time/phase/players), `heroes`, `units` (`mcp_dump`).
- **`dota_selftest`** — one orchestrated smoke run: optionally launch a map, ping the SDK, run `commands`, check
  `asserts` (Lua booleans → PASS/FAIL via `mcp_assert`), watch for errors, and screenshot — returns a single pass/fail report.

The SDK also exposes `mcp_spawn`, `mcp_gold`, `mcp_level`, `mcp_item`, `mcp_event` (fire a custom UI event), `mcp_hud`
(clean screenshots) and `mcp_pause` — all callable via `dota_send_console_command` too.

## Reference library — collect & search shipping games

Build a **persistent, self-curating** local library of custom-game source code, then search it on demand ("how does a
shipping game do X?"). Stored under `~/.dota2-workshop-mcp/reflib` (override `DOTA2_REFLIB_DIR`).

- **`ref_harvest`** — search the Workshop by `query` (or pass `ids`), optionally `download:true` via SteamCMD, extract
  the code (lua/KV/panorama), **score code quality** (0–100; rewards substance/structure/comments, penalizes
  obfuscation), classify **topics** (tower-defense, auto-chess, arpg, arena, ui-heavy, backend, …), and index it.
- **`ref_search`** — full-text search across all extracted code, ranked so higher-quality games come first.
- **`ref_list` / `ref_inspect` / `ref_get`** — browse the library, list a game's files, read one.
- **`ref_curate`** — prune low-quality / obfuscated games (with `dryRun`). **`ref_stats`** — library summary.

## Generating maps from a description

Turn a request like *"a small square map with a central platform, ringed by a road the monsters
walk — tower defense"* into a real map:

- **`map_build`** — one call: clone the template, shape terrain, place entities, lay waypoint paths,
  register and compile. Terrain ops work on the **Dota tile grid** (`verticesHeight` / `verticesWater` /
  `cellsTileSet`) over shapes (`rect` / `circle` / `ring` / `path`): raise platforms, carve roads
  (different tileset), flood water moats, etc.
- **`map_terrain`** — apply terrain ops to an existing map.
- **`map_preview`** — render the map top-down to an **image straight from the data**, no game launch —
  the fast way to iterate on a layout (water = blue, road = tan, grass = green, shaded by height).
- **`entity_catalog`** — the placeable-entity reference (spawners, `path_track` waypoints, triggers,
  lights, props, …) so you know what to place.
- **`map_tile_to_world`** — convert tile coords to world units so terrain and entities line up.

Coordinates: terrain ops use tile units (default 64×64 grid; world = origin + tile×256); entity/path
positions use world units.

## Learn from other custom games

Find, fetch and dissect any published custom game — the same Steam UGC backend the client uses,
driven from outside the game:

- **`workshop_search`** — search by name (e.g. `"tower defense"`) → ids, titles, subscriber counts.
- **`workshop_download`** — download by id via SteamCMD (anonymous; auto-installs SteamCMD on first
  use). No Steam login needed for Dota custom games. By default it then **extracts the code and
  decompiles the compiled Panorama** into the reference library so it's instantly browsable/searchable
  (`extract:false` to skip).
- **`workshop_grep`** — full-text **search the code across all downloaded/subscribed games** straight
  from their VPKs (lua/KV/panorama, compiled panorama decompiled on the fly) — scope to one `id` or
  search everything; filter by `ext` to go faster.
- **`workshop_list` / `workshop_inspect` / `workshop_read`** — list local items (subscribed +
  downloaded) and read any file straight out of their VPK to study how they're built. Published games ship
  Panorama **compiled** (`.vcss_c`/`.vjs_c`/`.vxml_c`); `workshop_read` (and `vpk_read`) **auto-decompile** these
  back to CSS/JS/XML source so you can study real shipping UI, animations and HUDs.
- **Reference library** (`ref_harvest` / `ref_search` / …) — collect games into a persistent, quality-scored,
  topic-classified local code library (including decompiled Panorama UI) and search across all of it on demand.
- **`asset_db`** — a SQLite index of **every file across all unpacked games**, so finding any
  model/particle/sound/texture by **kind/extension/name** is a fast structured query instead of a scan.
  `action=search` (default) / `stats` / `rebuild`; auto-updates on download/unpack. e.g.
  `asset_db query="tower" kind="model"`.

So you can go from *"how does a popular TD spawn waves?"* to reading its actual `waves.lua` in a couple
of calls.

### Preview assets without launching Dota

Eyeball particles, textures, models and sounds straight from the downloaded games — decoded
out-of-engine via [ValveResourceFormat](https://github.com/ValveResourceFormat/ValveResourceFormat)
(auto-installs on first use, Windows). Both tools return an **inline image in chat** (a numbered
contact sheet), so previews are viewable **over remote-access** where opening a browser isn't possible,
*and* write a self-contained HTML page for richer local viewing.

- **`asset_preview`** — find matching particles (`.vpcf`), textures (`.vtex`) or models (`.vmdl`),
  decode them (textures → PNG, models → GLB, particles → their sprite texture), and return a numbered
  contact-sheet image inline + an HTML gallery with interactive 3D `<model-viewer>` for models. e.g.
  `asset_preview query="spark" kind="particle"`.
- **`sound_preview`** — find matching sounds (`.vsnd`), decode them, and return an inline image (a real
  amplitude waveform for the rare PCM sound; a labelled speaker tile + accurate duration for MP3, the
  usual Dota codec — MP3 can't be waveformed out-of-engine) + an HTML **soundboard** with a real
  `<audio>` player per sound; small sounds are also embedded inline as playable audio. e.g.
  `sound_preview query="explosion"`.
- **`preview_studio`** — build a rich **interactive** gallery and expose it on a **public share link**
  (Cloudflare quick tunnel) you open in any browser, including a phone over remote-access. Particles are
  replayed live as animated additive billboards from their real `.vpcf` parameters (move + glow); models
  are interactive 3D (rotate); sounds get a player. Every card has a stable **ID** (P#/M#/S#/T#) and a
  **«выбрать» button**: pick by clicking (the click posts to the gallery server) or by telling the agent
  the ID. `preview_selections` returns what was clicked, `preview_pick id="M3,P7"` resolves explicit IDs —
  both map the choice back to the source game + asset path. `preview_studio_stop` tears it down.

## Built-in references (offline)

No need to leave the editor to look things up:

- **`lua_api_search` / `lua_api_get`** — the VScript (Lua) server API.
- **`panorama_api_search` / `panorama_api_get`** — the Panorama JS API. Globals resolve to their
  interface: `panorama_api_get $`, `panorama_api_get GameEvents`, `panorama_api_get Players.GetLocalPlayer`.
- **`docs_search` / `docs_get` / `docs_list`** — the ModDota guides. Browse with `docs_list`, search
  with `docs_search modifier`, read with `docs_get abilities/ability-keyvalues`.
- **`tools_catalog`** — the curated list of tools/libraries/references (filter by category or query).

## Building maps

`.vmap` files are DMX documents. The MCP edits them as text via Valve's `dmxconvert.exe`
(binary ↔ keyvalues2), then compiles with `resourcecompiler` (`-game <dota>/game/dota`) into a
playable `.vpk` — a pipeline verified end to end.

- **`map_create`** — clone the official template map (ground + lighting + team spawns) into your
  addon and register it in `addoninfo.txt`. Pass `compile: true` to produce the `.vpk` immediately.
- **`map_add_entity`** — place any entity (`info_player_start_*`, `npc_dota_spawner`, `env_*`,
  `prop_dynamic`, `point_*`, …) with origin/angles/properties.
- **`map_to_text` / `map_from_text`** — read/write the full vmap DMX text for arbitrary edits.
- **`map_compile`** — compile a map's `.vmap` → `.vpk`.
- **`map_list`** — list maps with source/compiled status.

Then launch it: `addon_launch_custom_game map="<name>"`.

> Limitation: bespoke **geometry** (terrain/brushwork — the `CDmePolygonMesh` half-edge data) is
> authored in **Hammer**. The MCP builds maps by cloning a working base and placing entities; it
> doesn't sculpt arbitrary meshes from scratch.

## Notes & limitations

- `kv_read` returns the file's own wrapper block and lists `#base` includes, but does not yet inline
  `#base` files — read those directly via `path`.
- Editing an entry with `kv_upsert_entry` preserves comments on *other* entries; the edited entry is
  regenerated from your JSON.
- Heroes can only be created by overriding an existing hero (`scaffold_hero` writes an `override_hero`
  block) — this is a Dota engine constraint.

## Development

```bash
npm run dev    # run the server from source via tsx
npm test       # KV parser/serializer unit tests
npm run smoke  # boot the server over stdio and exercise the tools end-to-end
```

## License

MIT — see [LICENSE](LICENSE).
