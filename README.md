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

> Status: early but working — **36 tools** across 7 areas, end-to-end tested. The live debug loop runs
> over the **VConsole2** protocol (verified against a running client: connect, send commands, read live
> output, hot-reload, restart, screenshot, error-watch) and a bundled, searchable copy of the VScript
> API, the Panorama JS API, and the ModDota guides ships for offline use.

## Features

| Area | Tools |
| --- | --- |
| **Diagnostics** | `dota_doctor`, `addon_list`, `addon_info` |
| **KeyValues** | `kv_read`, `kv_get_entry`, `kv_upsert_entry`, `kv_remove_entry`, `kv_validate`, `kv_format` |
| **Scaffolding** | `scaffold_ability`, `scaffold_modifier`, `scaffold_item`, `scaffold_unit`, `scaffold_hero`, `scaffold_panorama_panel` |
| **VScript API** | `lua_api_search`, `lua_api_get`, `lua_api_class_methods` |
| **Build & launch** | `addon_build`, `addon_compile_content`, `addon_launch_tools`, `addon_launch_custom_game`, `addon_link` |
| **Live debug loop** | `dota_send_console_command`, `dota_read_console_log`, `dota_reload_scripts`, `dota_restart_game`, `dota_dev_cycle`, `dota_screenshot`, `dota_watch_errors` |
| **Docs & references** | `docs_search`, `docs_get`, `docs_list`, `panorama_api_search`, `panorama_api_get`, `tools_catalog` |

Everything is bundled so search works **offline**:
- VScript (Lua) API — 97 classes / 242 globals / 72 enums, from [@moddota/dota-data](https://github.com/ModDota/dota-data).
- Panorama JS API — 62 interfaces / ~880 members / 18 globals, from [@moddota/panorama-types](https://github.com/ModDota/TypeScriptDeclarations).
- 83 ModDota guide articles (scripting, abilities, modifiers, units, panorama, assets, tools), from [moddota.com](https://moddota.com).
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
- **`dota_screenshot`** — capture the running game (in-game `jpeg`, or OS window capture as a fallback).
- **`dota_watch_errors`** — scan the live console for Lua/engine errors (script error, stack traceback, *.lua:NN, …).

What hot-reloads vs needs a restart:

| Change | Action |
| --- | --- |
| Lua function bodies | `dota_reload_scripts` (`script_reload`) |
| Panorama (xml/css/js) | auto-reloads after compile — no relaunch |
| KV files (`npc_*_custom.txt`) | `dota_restart_game` (full relaunch) |
| New/removed scripts, changed class structure, registrations | `dota_restart_game` |

> Tip: the ModDota template uses `Dynamic_Wrap`/`GameRules.Addon.Reload()` so reloaded code is
> picked up — keep event listeners wrapped for `script_reload` to take effect.

## Built-in references (offline)

No need to leave the editor to look things up:

- **`lua_api_search` / `lua_api_get`** — the VScript (Lua) server API.
- **`panorama_api_search` / `panorama_api_get`** — the Panorama JS API. Globals resolve to their
  interface: `panorama_api_get $`, `panorama_api_get GameEvents`, `panorama_api_get Players.GetLocalPlayer`.
- **`docs_search` / `docs_get` / `docs_list`** — the ModDota guides. Browse with `docs_list`, search
  with `docs_search modifier`, read with `docs_get abilities/ability-keyvalues`.
- **`tools_catalog`** — the curated list of tools/libraries/references (filter by category or query).

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
