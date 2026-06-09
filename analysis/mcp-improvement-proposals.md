# MCP improvement proposals — from analyzing 1120 top custom games

Derived from the metadata catalog (`top-games-catalog.json`, 1120 games) + a deep code/UI
analysis of 18 top games (`findings-deep.md`). Items marked **[done]** were implemented in
this pass; the rest are prioritized proposals.

## Shipped in this pass

- **[done] Panorama decompiler** (`src/dota/panorama-decompile.ts`). Published games ship
  Panorama as compiled `.vcss_c/.vjs_c/.vxml_c`; we now recover the embedded source.
  Wired into `workshop_read` and `vpk_read` (auto-decompile; also falls back from a
  requested `.css/.js/.xml` to the compiled file), and into the reference library so
  harvests capture real UI source (2.8 MB CSS / 6.7 MB JS / 0.27 MB XML across 23 games).
- **[done] Reference library** now classifies `ui-heavy` and stores Panorama source, so
  `ref_search`/`ref_get` can pull real shipping CSS/JS/Lua. (Library tooling shipped in the
  prior pass: `ref_harvest/list/search/inspect/get/curate/stats`.)
- **[done] 3 bundled design docs** (offline, searchable via `docs_search`):
  `panorama/animations-cookbook`, `panorama/hud-ux-patterns`,
  `scripting/custom-game-architecture`.
- **[done] dota_patterns KB** expanded 9 → 29 patterns (Panorama animation/UI, progression,
  economy, backend, architecture) — all attributable to specific shipping games.

## Proposed scaffolders (highest leverage)

These turn the most-repeated patterns into one-call generators (like the existing
`scaffold_*` tools), so a new addon gets battle-tested infrastructure instantly.

> **Status:** items 1–6 are now **shipped** (`scaffold_notifications`, `scaffold_save_codes`,
> `scaffold_nettable_binding`, `scaffold_rpc`, `scaffold_hud_panel`, `scaffold_wave_system`),
> along with the `panorama_decompile` tool (#8). Remaining: #7 and tools #9–#12.

1. **`scaffold_notifications`** [done] — emit the toast/kill-feed bus seen in nearly every top game:
   a Panorama panel + CSS (scale-overshoot pop-in, `scaleY(-1)` upward stack, fly-out) + a
   Lua `Notifications` module sending `CustomGameEventManager` events with token
   substitution (`{s:name}`, `{d:int}`). Prevalence: ~very high.
2. **`scaffold_save_codes`** — the persistence stack: JSON (dkjson) → compress (libdeflate) →
   sign/encode → shareable code, plus the HTTP-backend variant with the
   **net-table-delivered server key** auth pattern (Dota IMBA). ~most progression games.
3. **`scaffold_nettable_binding`** — generate the prime-and-subscribe helper + a typed
   accessor for a net table, and (optionally) the **frame-count debounce** writer on the Lua
   side. Eliminates the #1 UI sync bug.
4. **`scaffold_rpc`** — the correlation-id request/response helper over custom events (client)
   + the coroutine+xpcall service-event router (server). Turns one-way events into RPC.
5. **`scaffold_hud_panel`** — a Panorama panel preloaded with cookbook micro-interactions
   (state-class show/hide, hover pop, rarity glow) and the `<styles>/<scripts>` wiring.
6. **`scaffold_wave_system`** — extend `scaffold_td` with the KV-data-driven weighted
   spawner + round-state net table seen in Guarding Athena / Horde Mode.
7. **`scaffold_shop`** [done] / **`scaffold_talent_tree`** [done] — economy + progression UI+Lua skeletons.

## Proposed tooling / debug

> **Status:** #8 `panorama_decompile`, #9 `ref_recipe`, and #10 `addon_audit` are now **shipped**.
> Remaining: #7 (`scaffold_shop`/`scaffold_talent_tree`), #11 (`ref_harvest_top`), #12 (`dota_perf`).

8. **`panorama_decompile` tool** [done] — decompile a `.v*_c` file or a whole game's panorama
   tree to a folder for offline study (also wired into `workshop_read`/`vpk_read`).
9. **`ref_recipe`** [done] — given a topic, return the relevant `dota_patterns` entries + the
   exact reference files (`ref_get`) that implement them. Bridges the KB and the corpus.
10. **`addon_audit`** [done] — static checks: missing precache, dead custom events
    (client fires → no server listener), net-table writes without debounce, panorama not in
    `custom_ui_manifest`, abilities/items without tooltip tokens.
11. **Auto-harvest crawler** [done] — `ref_harvest_top` walks the Workshop top-N per genre and
    keeps the library fresh; the catalog builder (`analysis/build-catalog.mjs`) is the seed.
12. **`dota_perf`** [done] — server VProf capture + `cl_showfps`/`net_graph` overlay toggles via
    VConsole for the self-test harness.

## Conclusions feeding the above

- Custom Panorama UI (toasts, scoreboards, shops, talent trees, pickers, end screens) is a
  baseline expectation in top games — the MCP should make it cheap to produce, and the
  animation/HUD cookbooks + scaffolders target exactly that.
- Persistence (save codes / HTTP backends / leaderboards / MMR) and roguelike/progression
  loops recur across the most-subscribed games — worth first-class scaffolding.
- Net-table discipline (prime-and-subscribe, debounced writes, column-zip compression) is the
  difference between a smooth and a janky/over-budget UI — encode it as helpers.
