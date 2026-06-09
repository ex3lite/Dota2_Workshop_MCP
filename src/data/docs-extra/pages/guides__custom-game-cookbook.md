# Custom Game Cookbook (index)

A task-oriented index over everything this MCP bundles for building Dota 2 custom games:
the **scaffolders** that generate working code, the **design docs** distilled from analyzing
shipping games, and the **`dota_patterns`** knowledge base. Find your task below → use the
listed tool, read the doc, or look up the pattern.

> Tip: `ref_recipe <topic>` returns the matching patterns + real reference code in one call.
> `docs_search <topic>` finds the right doc; `dota_patterns category=<cat>` lists patterns.

## "I want to build X"

| I want to… | Use the tool | Read / reference |
| --- | --- | --- |
| A new ability / modifier / item / unit / hero | `scaffold_ability`, `scaffold_modifier`, `scaffold_item`, `scaffold_unit`, `scaffold_hero` | ModDota guides (`docs_search`) |
| A Panorama panel | `scaffold_panorama_panel` (basic) or `scaffold_hud_panel` (animated) | `panorama/animations-cookbook`, `panorama/dota-css-reference` |
| Toast / kill-feed notifications | `scaffold_notifications` | `panorama/hud-ux-patterns`, `panorama/animations-cookbook` |
| A shop / store | `scaffold_shop` | `panorama/hud-ux-patterns` |
| A talent / upgrade tree | `scaffold_talent_tree` | `panorama/hud-ux-patterns` |
| Waves / rounds (survival/horde) | `scaffold_wave_system` | `scripting/custom-game-architecture` |
| Tower-defense (waypoints or maze) | `scaffold_td` | `dota_patterns category=tower-defense` |
| A whole map from a description | `map_build` (+ `map_terrain`, `map_preview`) | `entity_catalog` |
| Client↔server RPC | `scaffold_rpc` | pattern "RPC over custom game events" |
| Net-table sync (no jank) | `scaffold_nettable_binding` | `scripting/custom-game-architecture` |
| Save/load codes or a backend | `scaffold_save_codes` | pattern "Save/load codes", "server key as HTTP auth token" |

## "I want it to look / feel great"

- **Animations & effects** (pulse/glow/spin/fly-in, gradients, shine-sweep, hover pop, rarity glow):
  `panorama/animations-cookbook`.
- **CSS dialect** (flow-children, `fill-parent-flow`, `wash-color`, `pre-transform-scale2d`, gradients):
  `panorama/dota-css-reference`.
- **HUD/UX structures** (scoreboard, shop, talent tree, picker, end-screen, tooltips, toasts):
  `panorama/hud-ux-patterns`.
- **Particles in UI + gameplay FX, sound, game feel** (ScreenShake, camera, floating damage numbers,
  particle lifecycle): `panorama/particles-and-effects`, `scripting/particles-sound-gamefeel`.

## "I want hard/advanced things"

- **Reuse Valve's HUD** (repurpose native buttons, inject into native tooltips, native error popup,
  drag-drop inventory, read real ping/keybinds, Twitch emotes): `panorama/native-hud-hijacking`.
- **Engine-limit workarounds & advanced systems** (bypass the 32-bit HP cap, custom physics/collision,
  navmesh→grid pipelines, world→minimap overlays, procedural generation, rubber-banding, bot-AI
  frameworks, signed/reliable backends, Lua mem profiling): `scripting/advanced-techniques`.
- **AI & combat** (think loops, targeting, boss phases, projectiles, kiting): `scripting/ai-combat-patterns`.

## Learn from shipping games

- **`ref_harvest` / `ref_harvest_top`** — collect games into a persistent, quality-scored, topic-classified
  local code library (decompiled Panorama included).
- **`ref_search` / `ref_get` / `ref_inspect`** — full-text search the corpus and read real files.
- **`ref_recipe <topic>`** — patterns + the exact reference files that implement them.
- **`workshop_read` / `panorama_decompile`** — read any published game's files (compiled Panorama is
  auto-decompiled to CSS/JS/XML).

## Iterate & debug a running game

- **`dota_dev_cycle`** — build + hot-reload (or restart) in one call. **`dota_reload_scripts`**, `dota_restart_game`.
- **`dota_screenshot`** (`game` render / `window` real-pixels), **`dota_window` / `dota_focus_window`**,
  **`dota_click` / `dota_type` / `dota_input`** (OS input), **`dota_status`**, **`dota_wait_for`**.
- **DebugSDK** (`addon_attach_debug_sdk`) → **`dota_lua_eval`**, **`dota_debug_dump`**, **`dota_selftest`**.
- **`dota_perf`** (VProf + fps/net overlays), **`dota_watch_errors`**.
- **`addon_audit`** — static checks for the bugs that bite custom games (dead events, missing precache,
  net-table churn, panorama not in the manifest, missing tooltips).

## API lookups (offline)

- **`lua_api_search` / `lua_api_get`** — VScript (server Lua) API.
- **`panorama_api_search` / `panorama_api_get`** — Panorama JS API.
- **`docs_search` / `docs_get` / `docs_list`** — all bundled guides. **`dota_patterns`** — the pattern KB.
