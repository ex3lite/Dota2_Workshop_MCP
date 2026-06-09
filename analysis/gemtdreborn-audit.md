# GemTDReborn — addon_audit report

Scanned 118 vscripts + 28 panorama files.

Findings by rule: {"custom-event-no-listener":1,"custom-event-no-subscriber":7,"panorama-not-in-manifest":21,"missing-tooltip":129}

## Warnings (likely real bugs)

- **custom-event-no-listener** — Client fires custom event "get_mvp_text" but no server CustomGameEventManager:RegisterListener("get_mvp_text") was found — the event is dropped.
  - fix: Register it server-side, or use scaffold_rpc for request/response.

## Info (157)

Top items per rule:

- [custom-event-no-subscriber] Server sends custom event "top_remove_notification" but no client GameEvents.Subscribe("top_remove_notification") was found — no panel handles it.
- [custom-event-no-subscriber] Server sends custom event "bottom_remove_notification" but no client GameEvents.Subscribe("bottom_remove_notification") was found — no panel handles it.
- [custom-event-no-subscriber] Server sends custom event "top_notification" but no client GameEvents.Subscribe("top_notification") was found — no panel handles it.
- [custom-event-no-subscriber] Server sends custom event "bottom_notification" but no client GameEvents.Subscribe("bottom_notification") was found — no panel handles it.
- [custom-event-no-subscriber] Server sends custom event "ShowItemdefs" but no client GameEvents.Subscribe("ShowItemdefs") was found — no panel handles it.
- [custom-event-no-subscriber] Server sends custom event "RespawnWear" but no client GameEvents.Subscribe("RespawnWear") was found — no panel handles it.
- [custom-event-no-subscriber] Server sends custom event "UpdateWearable" but no client GameEvents.Subscribe("UpdateWearable") was found — no panel handles it.
- [panorama-not-in-manifest] Layout "custom_loading_screen.xml" is not referenced in custom_ui_manifest.xml — it won't load as a HUD element.
- [panorama-not-in-manifest] Layout "game_info.xml" is not referenced in custom_ui_manifest.xml — it won't load as a HUD element.
- [panorama-not-in-manifest] Layout "gem_board.xml" is not referenced in custom_ui_manifest.xml — it won't load as a HUD element.
- [panorama-not-in-manifest] Layout "gem_button.xml" is not referenced in custom_ui_manifest.xml — it won't load as a HUD element.
- [panorama-not-in-manifest] Layout "gem_gameinfo_board.xml" is not referenced in custom_ui_manifest.xml — it won't load as a HUD element.
- [panorama-not-in-manifest] Layout "gem_gold_ui.xml" is not referenced in custom_ui_manifest.xml — it won't load as a HUD element.
- [panorama-not-in-manifest] Layout "gem_merge_board.xml" is not referenced in custom_ui_manifest.xml — it won't load as a HUD element.
- [panorama-not-in-manifest] Layout "gem_ranking_board.xml" is not referenced in custom_ui_manifest.xml — it won't load as a HUD element.
- [panorama-not-in-manifest] Layout "overthrow_game_info.xml" is not referenced in custom_ui_manifest.xml — it won't load as a HUD element.
- [panorama-not-in-manifest] Layout "overthrow_gem_life.xml" is not referenced in custom_ui_manifest.xml — it won't load as a HUD element.
- [missing-tooltip] abilitie "gemtd_build_stone" has no DOTA_Tooltip_ability_gemtd_build_stone in addon_english.txt — it'll show the raw key in-game.
- [missing-tooltip] abilitie "gemtd_remove" has no DOTA_Tooltip_ability_gemtd_remove in addon_english.txt — it'll show the raw key in-game.
- [missing-tooltip] abilitie "gemtd_choose_stone" has no DOTA_Tooltip_ability_gemtd_choose_stone in addon_english.txt — it'll show the raw key in-game.
- [missing-tooltip] abilitie "gemtd_choose_update_stone" has no DOTA_Tooltip_ability_gemtd_choose_update_stone in addon_english.txt — it'll show the raw key in-game.
- [missing-tooltip] abilitie "gemtd_choose_update_update_stone" has no DOTA_Tooltip_ability_gemtd_choose_update_update_stone in addon_english.txt — it'll show the raw key in-game.
- [missing-tooltip] abilitie "tower_slow1" has no DOTA_Tooltip_ability_tower_slow1 in addon_english.txt — it'll show the raw key in-game.
- [missing-tooltip] abilitie "tower_slow2" has no DOTA_Tooltip_ability_tower_slow2 in addon_english.txt — it'll show the raw key in-game.
- [missing-tooltip] abilitie "tower_slow3" has no DOTA_Tooltip_ability_tower_slow3 in addon_english.txt — it'll show the raw key in-game.
- [missing-tooltip] abilitie "tower_slow4" has no DOTA_Tooltip_ability_tower_slow4 in addon_english.txt — it'll show the raw key in-game.
- [missing-tooltip] abilitie "tower_slow5" has no DOTA_Tooltip_ability_tower_slow5 in addon_english.txt — it'll show the raw key in-game.
