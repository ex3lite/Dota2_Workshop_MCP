# Custom Game HUD & UX Patterns

A field guide to building custom HUD/UX in Panorama (Dota 2), distilled from 18 shipping
custom games. Every screen below is shown three ways: the **XML** panel layout, the **CSS**
layout/animation, and the **JS data wiring** (`CustomNetTables` + `GameEvents` + `$.CreatePanel`
templating). Lua is shown where the server side is load-bearing.

Source games referenced: **Guarding Athena** (`530286038`), **Dota IMBA** (`440115357`),
**Pudge Wars** (`296831818`), **Dota 2 Horde Mode** (`472597026`).

---

## The three data channels (memorize these)

Panorama custom UI gets server state through exactly three pipes. Pick the right one:

| Channel | Use for | Cost |
|---|---|---|
| **CustomNetTables** | Persistent shared state (round data, currencies, hero picks, quests). Survives reconnect; readable synchronously. | Hard size budget per table; latched. |
| **GameEvents** (custom game events) | Transient pushes (toast me, vote echo, "boss incoming"). Fire-and-forget. | Cheap; not persistent. |
| **DialogVariables / native HUD** | Live label text (`{countdown}`), or reusing Valve's built-in panels. | Free; no rebuild needed. |

The single most reusable JS helper across every codebase is **prime-then-subscribe** — read the
current value immediately, then listen for changes to one key (Dota IMBA, `hero_selection.js`):

```js
// SubscribeToNetTableKey: invoke cb now with current value, then on every change to `key`.
function SubscribeToNetTableKey(table, key, cb) {
  var v = CustomNetTables.GetTableValue(table, key);
  if (v != null) cb(v);
  CustomNetTables.SubscribeNetTableListener(table, function(_t, k, val) {
    if (k === key && val != null) cb(val);
  });
}
```

Net-table keys are **stringly typed**: `"1"`, player-id strings, entindex strings. Never assume
numeric keys.

---

## Custom top bar / resource display

Two strategies ship in the wild:

1. **Augment Valve's top bar** (Pudge Wars `topbar_hack`): walk `GetParent()` up to the `Hud` root,
   then `FindChildTraverse` the real score/portrait panels and overwrite them.
2. **Overlay a custom resource strip** (Guarding Athena): a docked panel reading a multi-currency
   net-table row.

Walking into Valve's HUD (Pudge Wars):

```js
// Find the real Dota Hud root from inside a custom panel.
function GetHud() {
  var p = $.GetContextPanel();
  while (p !== null && p.id !== "Hud") p = p.GetParent();
  return p;
}
var hud = GetHud();
var radiantScore = hud.FindChildTraverse("TopBarRadiantScore");
// radiantScore.text = "..."  // repaint Valve's own label
```

Custom currency strip — XML:

```xml
<Panel class="ResourceBar" hittest="false">
  <Panel class="Currency">
    <Image class="Icon" src="s2r://panorama/images/hud/icon_gold_psd.vtex" />
    <Label id="GoldValue"   text="0" />
  </Panel>
  <Panel class="Currency">
    <Image class="Icon" src="file://{images}/custom_game/crystal.png" />
    <Label id="CrystalValue" text="0" />
  </Panel>
  <Panel class="Currency">
    <Image class="Icon" src="file://{images}/custom_game/score.png" />
    <Label id="ScoreValue"  text="0" />
  </Panel>
</Panel>
```

CSS — horizontal flow, fixed-height pills, top-center docking:

```css
.ResourceBar  { flow-children: right; horizontal-align: center; vertical-align: top;
                margin-top: 6px; height: 28px; }
.Currency     { flow-children: right; margin-left: 12px; vertical-align: center; }
.Currency .Icon  { width: 22px; height: 22px; margin-right: 4px; vertical-align: center; }
.Currency Label  { font-size: 18px; font-weight: bold; color: #fff; vertical-align: center;
                   text-shadow: 1px 1px 2px 2.0 #000; }
```

JS wiring (Guarding Athena's `player_data` row carries gold/crystal/score). Note the player-id
string key:

```js
var pid = Players.GetLocalPlayer();
SubscribeToNetTableKey("player_data", pid.toString(), function(row) {
  $("#GoldValue").text    = (row.gold    || 0).toString();
  $("#CrystalValue").text = (row.crystal || 0).toString();
  $("#ScoreValue").text   = (row.score   || 0).toString();
});
```

**Server side**: Guarding Athena debounces these writes. Every `Set*` re-pushes the row, but
`UpdateNetTables` collapses many same-frame writes into one (see Pitfalls / "frame-count debounce").

---

## Scoreboard (multi-team flyout)

Pudge Wars ships a generic engine (`multiteam_flyout_scoreboard`) that builds **team panels** and
**per-player panels** from templates, then live-sorts teams by score. The XML is just a legend +
an empty container that JS fills:

```xml
<Panel class="FlyoutScoreboardRoot" hittest="false">
  <Panel class="Legend">
    <Label class="LegendPanel ScoreCol_HeroLevel" text="LVL"/>
    <Label class="LegendPanel ScoreCol_Gold"   text="#legend_gold"/>
    <Label class="LegendPanel ScoreCol_Kills"  text="#legend_kills" />
    <Label class="LegendPanel ScoreCol_Deaths" text="#legend_deaths" />
    <Label class="LegendPanel ScoreCol_Assists" text="#legend_assists" />
    <Label class="LegendPanel ScoreCol_Ultimate" text="ULT" />
  </Panel>
  <Panel id="TeamsContainer" />   <!-- filled at runtime -->
</Panel>
```

Row templating with `$.CreatePanel` + `DOTAAvatarImage` (Pudge Wars convention — avatars use
`.steamid`):

```js
function BuildPlayerRow(parent, playerId) {
  var row = $.CreatePanel("Panel", parent, "player_" + playerId);
  row.AddClass("PlayerRow");

  var avatar = $.CreatePanel("DOTAAvatarImage", row, "avatar_" + playerId);
  avatar.steamid = PlayerResource.GetSteamAccountID(playerId).toString();

  var hero = $.CreatePanel("DOTAHeroImage", row, "");
  hero.heroname = PlayerResource.GetSelectedHeroName(playerId);
  hero.heroimagestyle = "icon";

  var kda = $.CreatePanel("Label", row, "");
  kda.AddClass("ScoreCol_KDA");
  return { row: row, kda: kda };
}
```

Poll live values on a self-rescheduling timer (no event fires for gold/KDA):

```js
function UpdateScoreboard() {
  for (var pid of Game.GetAllPlayerIDs()) {
    var r = rows[pid];
    r.kda.text = Players.GetKills(pid) + " / " + Players.GetDeaths(pid)
               + " / " + Players.GetAssists(pid);
    // boolean state -> CSS class, never inline style
    r.row.SetHasClass("dead",          !Entities.IsAlive(Players.GetPlayerHeroEntityIndex(pid)));
    r.row.SetHasClass("local_player",  pid === Players.GetLocalPlayer());
    r.row.SetHasClass("ultimate_ready", IsUltReady(pid));
  }
  $.Schedule(1.0, UpdateScoreboard);
}
```

Live team reordering uses `MoveChildBefore` plus `team_getting_better` / `team_getting_worse`
transition classes so the move animates. Express **all per-row state as boolean classes**
(`dead`/`local_player`/`donator`/`ultimate_ready`/connection), and let CSS color them.

---

## In-game shop / upgrade store

Guarding Athena runs **two distinct economies**: a Dota-Plus-styled cosmetics store and an in-game
gameplay shop. Both route purchases through one custom UI event. The KV catalog is **pre-baked into
JS modules** (`itemskv.js`, `shopskv.js`) so the UI reads costs/icons/tooltips locally — no
round-trip to read a price.

Shop grid XML (an empty list that JS populates):

```xml
<Panel id="ShopRoot" class="ShopRoot">
  <TextEntry id="ShopSearch" placeholder="#shop_search" />
  <Panel id="ShopGrid" class="ShopGrid" />
</Panel>
```

CSS — wrapping grid via `flow-children: right` + `flow-children` on a fixed-width container:

```css
.ShopRoot { flow-children: down; width: 480px; height: 100%; padding: 8px; }
.ShopGrid { flow-children: right; width: 100%; height: fill-parent-flow(1);
            overflow: squish scroll; }     /* wrap by fixed child widths */
.ShopItem { width: 64px; height: 64px; margin: 4px; }
.ShopItem.cannot_afford #ItemImage { saturation: 0; wash-color: #1569be; }  /* blue 'no gold' wash */
```

Build cells from the baked catalog and capture loop vars in an **IIFE** (mandatory — see Pitfalls):

```js
var ITEMS = GameUI.CustomUIConfig().itemskv || {};   // or a global from the baked module

function BuildShop(grid) {
  for (var name in ITEMS) {
    var def = ITEMS[name];
    var cell = $.CreatePanel("DOTAItemImage", grid, name);
    cell.AddClass("ShopItem");
    cell.itemname = name;

    (function(cell, name, def) {                       // capture by VALUE
      cell.SetPanelEvent("onmouseover", function() {
        $.DispatchEvent("DOTAShowAbilityTooltip", cell, name);   // native item tooltip for free
      });
      cell.SetPanelEvent("onmouseout", function() {
        $.DispatchEvent("DOTAHideAbilityTooltip", cell);
      });
      cell.SetPanelEvent("onactivate", function() {
        GameEvents.SendCustomGameEventToServer("item_purchase",
          { item: name, currency: def.currency });            // gold | crystal | score
      });
    })(cell, name, def);
  }
}
```

Modal open — Guarding Athena's `.ShowStorePage` 3D fly-in (toggle one class, CSS does the motion):

```css
#StorePage {
  transition-property: opacity, transform, pre-transform-scale2d;
  transition-duration: 0.2s;
  perspective: 1000; perspective-origin: 62% 5% invert;
  transform: translateX(-120px) translateY(-60px);
  pre-transform-scale2d: 0.95; opacity: 0;
}
#StorePage.ShowStorePage {
  transform: translateX(0px) translateY(0px); pre-transform-scale2d: 1; opacity: 1;
}
```

```js
$("#StorePage").SetHasClass("ShowStorePage", true);   // JS owns state; CSS owns animation
```

**Reusable convention**: never reimplement Valve's shop if you can avoid it. Dota IMBA reaches the
built-in shop and injects custom item-build rows:

```js
var Shop      = GameUI.Utils.FindDotaHudElement("shop");
var ItemBuild = Shop.FindChildTraverse("ItemBuild");
// append DOTAShopItem children to ItemBuild -> inherits Valve styling, tooltips, item art
```

---

## Talent / skill / upgrade tree

Pudge Wars models the hook-upgrade tree as **abilities** whose `OnUpgrade` spends an ability point
(decrementing a `modifier_ability_points` stack). The UI is a grid of upgrade buttons that read a
"points remaining" net-table value and glow when spendable.

"Can level up" attractor pulse (Guarding Athena) — a looping glow on spendable pips:

```css
.could_level_up .next_level.LevelPanel {
  box-shadow: fill #ffC24E 0px 0px 10px 0px;
  animation-name: pipGlow; animation-duration: 1.2s;
  animation-iteration-count: infinite; animation-timing-function: ease-in-out;
}
@keyframes pipGlow {
  0%   { opacity: 1; pre-transform-scale2d: 1; }
  50%  { pre-transform-scale2d: 1.1; }
  100% { pre-transform-scale2d: 1; }
}
```

Wiring the tree:

```js
SubscribeToNetTableKey("hero_upgrades", Players.GetLocalPlayer().toString(), function(d) {
  var points = d.points || 0;
  $("#UpgradeTree").SetHasClass("has_points", points > 0);
  for (var ab in d.levels) {
    var node = $("#node_" + ab);
    node.SetHasClass("could_level_up", points > 0 && d.levels[ab] < d.max[ab]);
    node.SetDialogVariableInt("level", d.levels[ab]);
  }
});
function Upgrade(abilityName) {
  GameEvents.SendCustomGameEventToServer("spend_ability_point", { ability: abilityName });
}
```

Server (Pudge Wars `pudge_upgrades.lua` pattern): `OnUpgrade` calls `SpendAbilityPoint`, which
decrements the `modifier_ability_points` stack and auto-closes the menu when points hit 0.

### Roguelike "draw 3, pick 1" picker (Guarding Athena)

On milestones the server draws a rarity from a weighted pool, builds 3 candidate cards, and
publishes them to `ability_upgrades_selection` **keyed by entindex**. The UI shows the cards and
sends the pick back:

```js
var heroIdx = Players.GetPlayerHeroEntityIndex(Players.GetLocalPlayer());
SubscribeToNetTableKey("ability_upgrades_selection", heroIdx.toString(), function(draw) {
  var deck = $("#UpgradeDeck"); deck.RemoveAndDeleteChildren();
  for (var i in draw.cards) {
    var c = draw.cards[i];
    var card = $.CreatePanel("Panel", deck, "");
    card.AddClass("UpgradeCard"); card.AddClass("rarity_" + c.rarity);
    (function(choiceId) {
      card.SetPanelEvent("onactivate", function() {
        GameEvents.SendCustomGameEventToServer("ability_upgrades_reward_selection",
          { choice: choiceId });
      });
    })(c.id);
  }
});
```

---

## Hero / build / loadout picker

Both Guarding Athena and Dota IMBA drive their pick screen **entirely from a `hero_selection`
net table** (`herolist`, per-player choice, timer, preview). The overlay is shown only to players
still on the dummy hero. Guarding Athena adds **majority-vote difficulty** baked into the same table.

XML — grid + a countdown + a confirm:

```xml
<Panel id="HeroSelect" class="HeroSelect">
  <Label id="PickTimer" class="PickTimer" text="" />
  <Panel id="HeroGrid" class="HeroGrid" />
  <Panel id="DiffVote" class="DiffVote">
    <RadioButton group="diff" id="d_easy"   onactivate="Vote('difficulty',0)" />
    <RadioButton group="diff" id="d_hard"   onactivate="Vote('difficulty',1)" />
  </Panel>
</Panel>
```

```js
SubscribeToNetTableKey("common", "hero_selection", function(data) {
  $("#PickTimer").text = Math.max(0, Math.floor(data.timer)).toString();
  var grid = $("#HeroGrid"); grid.RemoveAndDeleteChildren();
  for (var i in data.herolist) {
    var hn = data.herolist[i];
    var img = $.CreatePanel("DOTAHeroImage", grid, "");
    img.heroname = hn; img.heroimagestyle = "portrait";
    (function(hn) {
      img.SetPanelEvent("onactivate", function() {
        GameEvents.SendCustomGameEventToServer("hero_chosen", { hero: hn });
      });
    })(hn);
  }
});
function Vote(cat, v) { GameEvents.SendCustomGameEventToServer("setting_vote", { category: cat, vote: v }); }
```

Live model preview — Pudge Wars inlines a `DOTAScenePanel` from a layout string (no separate XML):

```js
preview.BLoadLayoutFromString(
  '<root><Panel><DOTAScenePanel style="width:100%;height:100%;" unit="' + unitName + '"/></Panel></root>',
  false, false);
preview.style.opacityMask =
  'url("s2r://panorama/images/masks/hero_model_opacity_mask_png.vtex");';
```

Server (Guarding Athena `game.lua`): at `PRE_GAME` it tallies difficulty votes, picks the majority
(ties break to lower), and auto-randoms anyone who did not pick.

---

## Wave / round / timer info

Horde-survival games (Guarding Athena, Horde Mode) broadcast round state over a net-table row and
render a top banner + per-team progress. Horde Mode and Guarding Athena differ on the trigger:
Guarding Athena counts remaining enemies (`npc_spawned`/`entity_killed`); Horde Mode computes wave
start/end/boss times **off `GameRules` game time** so it is deterministic.

```js
SubscribeToNetTableKey("common", "round_data", function(r) {
  $("#WaveLabel").text = $.Localize("#wave_n").replace("%d", r.round);
  $("#EnemiesLeft").text = (r.remaining || 0).toString();
  $("#RoundBar").style.width = Math.floor(100 * r.cleared / r.total) + "%";
});
```

Prep-timer label via **DialogVariable** (Horde Mode) — no panel rebuild, localizes cleanly:

```js
GameEvents.Subscribe("custom_time_event", function(d) {
  $("#PrepTimer").SetDialogVariableInt("seconds", Math.max(0, d.prep_remaining));
});
```

Boss bar (Dota IMBA leveling Roshan): a top-of-screen HP/level bar that shows/hides on events and
pulls live values from `game_options/roshan`, auto-deleting on maps where it should not appear:

```js
SubscribeToNetTableKey("game_options", "roshan", function(r) {
  $("#RoshBar").style.width = Math.floor(100 * r.hp / r.max_hp) + "%";
  $("#RoshLevel").text = "Lv " + r.level;
});
```

"Round start / boss incoming" attention pulse (Guarding Athena `PopOut`):

```css
#UpperNotificationContianer.PopOut {
  animation-name: PopOut; animation-duration: 0.3s;
  animation-timing-function: ease-in-out; animation-iteration-count: 1;
}
@keyframes PopOut { 0%{pre-transform-scale2d:0.8;} 50%{pre-transform-scale2d:1.2;} 100%{pre-transform-scale2d:1;} }
```

```js
GameEvents.Subscribe("notification_upper", function(d) {
  var c = $("#UpperNotificationContianer");
  c.RemoveClass("PopOut"); c.AddClass("PopOut");   // remove+add re-triggers the keyframe
  $("#UpperNotificationLabel").text = $.Localize(d.message);
});
```

---

## Quest / objective tracker

Guarding Athena's task log is fed by `CustomNetTables("common","player_tasks")`. Each task has
staged objectives, progress bars, a removable entry, and a **world ping** (`ExecuteTeamPing` + a
question-mark particle) at the task's position. Tasks auto-accept at game start and support unlock
chains (locked until a prerequisite is received).

```xml
<Panel id="QuestLog" class="QuestLog">
  <Panel id="QuestList" class="QuestList" />   <!-- JS fills -->
</Panel>
```

```css
.QuestLog  { flow-children: down; vertical-align: top; horizontal-align: left;
             width: 320px; margin-top: 120px; margin-left: 8px; }
.QuestEntry { flow-children: down; padding: 6px; margin-bottom: 4px;
              background-color: #0008; border-left: 3px solid #ffc24e; }
.QuestEntry.locked { saturation: 0; opacity: 0.5; }
.ObjBar    { width: 100%; height: 6px; background-color: #222; }
.ObjBar #Fill { background-color: gradient(linear,0% 0%,100% 0%,from(#2E4826),to(#629f52));
                transition-property: width; transition-duration: 0.3s; }
```

```js
SubscribeToNetTableKey("common", "player_tasks", function(tasks) {
  var list = $("#QuestList"); list.RemoveAndDeleteChildren();
  for (var id in tasks) {
    var t = tasks[id];
    var e = $.CreatePanel("Panel", list, "task_" + id);
    e.AddClass("QuestEntry"); e.SetHasClass("locked", !!t.locked);

    var title = $.CreatePanel("Label", e, ""); title.text = $.Localize(t.title);
    for (var oi in t.objectives) {
      var o = t.objectives[oi];
      var bar  = $.CreatePanel("Panel", e, ""); bar.AddClass("ObjBar");
      var fill = $.CreatePanel("Panel", bar, "Fill");
      fill.style.width = Math.min(100, 100 * o.current / o.target) + "%";
    }
    (function(t) {                          // click pings the objective in the world
      e.SetPanelEvent("onactivate", function() {
        GameEvents.SendCustomGameEventToServer("ping_task", { pos: t.TaskPosition });
      });
    })(t);
  }
});
```

---

## End-game / post-match screen

The IMBA-family end screen (`frostrose_end_screen`) **hides the stock HUD** (topbar/minimap/
lower_hud/NetGraph), shows per-team columns of player rows, and animates an XP-gain bar per player.
Per level gained it pops a stacked reward card with a rarity-specific drop sound.

Hide Valve's HUD by climbing to the `Hud` root and collapsing children:

```js
function HideStockHud() {
  var hud = GetHud();
  ["topbar","minimap","lower_hud","NetGraph"].forEach(function(id) {
    var p = hud.FindChildTraverse(id);
    if (p) p.style.visibility = "collapse";
  });
}
```

Animated XP bar — width starts at 0, transitions over 2s; `.level-up` adds a gold glow loop:

```css
#es-player-xp-progress {
  background-color: gradient(linear, 0% 0%, 0% 100%, from(#006E2E), to(#00540E));
  width: 0%; height: 24px;
  transition-property: width; transition-duration: 2s;
}
.level-up { animation-name: level_up; animation-duration: 2.0s; animation-iteration-count: infinite; }
```

```js
GameEvents.Subscribe("end_game_data", function(d) {
  HideStockHud();
  for (var pid in d.players) {
    var pd = d.players[pid];
    var bar = $("#xp_" + pid);
    bar.style.width = pd.xp_pct + "%";            // animates via transition
    bar.SetHasClass("level-up", pd.leveled_up);
    var gained = $("#xpgain_" + pid);
    gained.text = (pd.xp_gain >= 0 ? "+" : "") + pd.xp_gain;
    gained.SetHasClass("positive", pd.xp_gain >= 0);
  }
});
```

Dota IMBA layers a **next-game mode vote** and a separate `gg.js` 5s surrender vote that tags each
consenting player with a GG badge on the top bar — both pure `SendCustomGameEventToServer` + a
net-table tally echo.

---

## Tooltips

Three tiers, cheapest first:

1. **Native ability/item tooltips** — reuse Valve's renderer (used by the shop above):

```js
panel.SetPanelEvent("onmouseover", function() { $.DispatchEvent("DOTAShowAbilityTooltip", panel, abilityName); });
panel.SetPanelEvent("onmouseout",  function() { $.DispatchEvent("DOTAHideAbilityTooltip", panel); });
// item variant: $.DispatchEvent("DOTAShowAbilityTooltipForEntityIndex", panel, name, entIndex);
```

2. **Simple text tooltip** — the generic Valve helper, good for custom labels:

```js
panel.SetPanelEvent("onmouseover", function() {
  $.DispatchEvent("DOTAShowTextTooltip", panel, $.Localize("#my_custom_tip"));
});
panel.SetPanelEvent("onmouseout", function() { $.DispatchEvent("DOTAHideTextTooltip", panel); });
```

3. **Fully custom tooltip layout** — when you need rich markup:

```js
panel.SetPanelEvent("onmouseover", function() {
  $.DispatchEvent("UIShowCustomLayoutTooltip", panel, "MyTip",
    "file://{resources}/layout/custom_game/my_tooltip.xml");
});
panel.SetPanelEvent("onmouseout", function() { $.DispatchEvent("UIHideCustomLayoutTooltip", panel, "MyTip"); });
```

---

## Modals

The universal pattern: an off-screen/transparent panel with `visibility: collapse`, flipped on by a
**single class toggle**. `visibility: collapse` simultaneously removes from layout *and* hit-testing.

Slide-in drawer (Dota IMBA / Pudge Wars battlepass — `translate3d` off-screen ↔ on-screen):

```css
#BattlepassWindow {
  transform: translate3d(100%, 0, 0px); visibility: collapse;
  transition-property: transform; transition-duration: 0.1s; transition-timing-function: ease-in;
}
#BattlepassWindow.setvisible { visibility: visible; transform: translate3d(0, 0, 0px); }
#BattlepassWindow.sethidden  { visibility: collapse; transform: translate3d(100%, 0, 0px); }
```

```js
function ToggleDrawer(open) { $("#BattlepassWindow").SetHasClass("setvisible", open); }
```

Manual popup positioning (Guarding Athena `eomdesign` dropdown) — make visible, **defer one frame**
so layout computes, then read sizes/position:

```js
menu.SetHasClass("EOM_DropDownMenuShow", true);
$.Schedule(0.06, function() {                          // wait one frame for layout
  var minW = Math.max(menu.actuallayoutwidth, btn.actuallayoutwidth) / menu.actualuiscale_x;
  menu.style.minWidth = minW + "px";
  var pos = btn.GetPositionWithinWindow();             // anchor under the trigger
  menu.style.x = pos.x + "px";
  menu.style.y = (pos.y + btn.actuallayoutheight) + "px";
});
menu.SetFocus();
```

---

## Toasts / notifications

The **reusable toast bus** (Barebones, shipped in Horde Mode + IMBA + Pudge Wars). XML is two empty
stacks; Lua sends rich payloads; JS builds the correct panel subtype per payload.

```xml
<root>
  <scripts><include src="s2r://panorama/scripts/custom_game/barebones_notifications.vjs_c" /></scripts>
  <Panel hittest="false" class="BarebonesBaseHud">
    <Panel hittest="false" class="BarebonesTopNotifications">    <Panel id="TopNotifications" /></Panel>
    <Panel hittest="false" class="BarebonesBottomNotifications"> <Panel id="BottomNotifications" /></Panel>
  </Panel>
</root>
```

The bus (verbatim shape from `barebones_notifications.js`) — picks panel subtype by payload key, and
each new line schedules its own self-cancelling deletion guarded by a `.deleted` flag:

```js
function AddNotification(msg, panel) {
  var newLine = true;
  var line = panel.GetChild(panel.GetChildCount() - 1);
  msg.continue = msg.continue || false;
  if (line != null && msg.continue) newLine = false;   // chain pieces onto one line

  if (newLine) { line = $.CreatePanel("Panel", panel, ""); line.AddClass("NotificationLine"); line.hittest = false; }

  var n;
  if      (msg.hero  != null) { n = $.CreatePanel("DOTAHeroImage",    line, ""); n.heroname = msg.hero; }
  else if (msg.ability != null){ n = $.CreatePanel("DOTAAbilityImage", line, ""); n.abilityname = msg.ability; }
  else if (msg.item  != null) { n = $.CreatePanel("DOTAItemImage",    line, ""); n.itemname = msg.item; }
  else if (msg.image != null) { n = $.CreatePanel("Image",           line, ""); n.SetImage(msg.image); }
  else                        { n = $.CreatePanel("Label",           line, ""); n.text = $.Localize(msg.text || ""); }
  n.hittest = false;
  if (msg.class) n.AddClass(msg.class);

  if (typeof msg.duration != "number") msg.duration = 3;
  if (newLine) $.Schedule(msg.duration, function() {
    if (line.deleted) return;
    line.DeleteAsync(0);
  });
}
(function() {
  GameEvents.Subscribe("top_notification",    function(m){ AddNotification(m, $("#TopNotifications")); });
  GameEvents.Subscribe("bottom_notification", function(m){ AddNotification(m, $("#BottomNotifications")); });
})();
```

Pop-in "slam" entrance (Horde Mode / Pudge Wars `scalein`):

```css
.NotificationLine { animation-name: scalein; animation-duration: .5s; animation-timing-function: linear; }
@keyframes scalein { from { opacity:0; transform: scaleX(2) scaleY(2); } to { opacity:1; transform: scaleX(1) scaleY(1); } }
```

Kill-feed that **grows upward** (Guarding Athena trick): flip the container with `scaleY(-1)`, flip
it back on each toast, and flow `down`. New toasts now push up from the bottom:

```css
#CombatNotificationToastManager        { flow-children: down; transform: scaleY(-1); width: 100%; }
#CombatNotificationToastManager > .ToastPanel {
  transform: scaleY(-1) translateX(-40px);    /* un-flip the child */
  opacity: 0; transition-property: opacity, transform; transition-duration: 0.2s;
  animation-name: CombatEvent; animation-duration: 0.41s;
}
@keyframes CombatEvent { 0%{pre-transform-scale2d:0.2;opacity:0;} 50%{pre-transform-scale2d:1.5;opacity:1;} 100%{pre-transform-scale2d:1;opacity:1;} }
```

Lua sender (Guarding Athena uses a token-substitution format `{s:player_name}`, `{d:int_x}`):

```lua
local function ToastCombat(playerId, msg)
  CustomGameEventManager:Send_ServerToPlayer(
    PlayerResource:GetPlayer(playerId), "bottom_notification",
    { text = msg, duration = 4, class = "AllyEvent" })
end
```

---

## Reusable conventions across all 18 games

- **State lives in CSS classes, motion lives in CSS.** JS only flips booleans with
  `SetHasClass`/`AddClass`. Drawers (`.setvisible`), toasts (`.ToastVisible`/`.Collapsed`), tutorial
  collapse (one class on the root cascading via descendant selectors), and per-row scoreboard state
  all follow this. Keeps JS tiny and animations declarative.
- **`pre-transform-scale2d` for "pop", `transform: translate3d` for slides.** `pre-transform-scale2d`
  scales without affecting layout (no reflow); slides use GPU-cheap transforms. Never animate
  `width`/`height`/`margin` except for deliberate bar fills (which use a `width` transition).
- **`wash-color` / `saturation` for state recolor** (grey→white hover, blue "no mana", red leave
  button) instead of swapping images.
- **`@define` constants** for shared animation clocks (`@define TotalLength: 3s;`) so every highlight
  shares one tunable timing.
- **Bake KV catalogs into JS modules** (`itemskv.js`, `shopskv.js`, `taskskv.js`) so the UI reads
  costs/icons/tooltips locally with zero round-trips.
- **RPC over fire-and-forget events via a correlation id** (Dota IMBA `createEventRequestCreator`):
  stamp `data.id = ++counter`, subscribe, unsubscribe on the matching reply.
- **Net-table-delivered server key as an HTTP auth token** (IMBA / Pudge Wars): server pushes a
  per-server secret via `CustomNetTables("game_options","server_key")`; the client sends it as
  `X-Dota-Server-Key` on `$.AsyncWebRequest` — the clean blueprint for a real persistence backend
  without hardcoding secrets in the VPK.

---

## Pitfalls

- **Loop-closure copy-by-reference bug (Panorama v8).** Wiring `onactivate`/`onmouseover` inside a
  `for` loop captures the *last* loop value unless you wrap the handler in an IIFE that captures by
  value. This silently breaks every dynamically generated list (shop cells, vote buttons, hero grid).
  Always: `(function(x){ panel.SetPanelEvent(...) })(loopVar);`
- **Reading layout size before it exists.** `actuallayoutwidth` / `GetPositionWithinWindow()` are 0
  on the frame you make a panel visible. Defer one frame with `$.Schedule(0.06, ...)` before
  measuring or positioning a popup (Guarding Athena `eomdesign`).
- **Net-table keys are strings.** `GetTableValue("player_data", pid)` with a number often misses;
  use `pid.toString()`. Server `SetTableValue` and client reads must agree on stringly keys.
- **Net tables have a hard size budget.** A growing roguelike upgrade list overflows it. Guarding
  Athena's fix: a column-oriented "zip" (one header row of keys + value-only rows) plus
  `null`→`'*'` substitution to trim the largest literal, reconstructed client-side.
- **Chatty setters spam the network.** Multiple same-frame writes (gold+crystal+score from one kill)
  each push the row. Debounce with a frame-count-keyed flag: stamp
  `"Update"..id.."_"..GetFrameCount()`, and if unset schedule a 0-delay timer that clears it and
  pushes once — many mutations collapse to one `SetTableValue` (Guarding Athena `UpdateNetTables`).
- **Keyframe won't replay.** Re-adding a class that already has an animation does nothing. Remove the
  class, then add it (`c.RemoveClass("PopOut"); c.AddClass("PopOut");`) to re-trigger.
- **Toast deletion races.** A toast scheduled for deletion can be force-removed first; guard the
  scheduled callback with a `.deleted` flag (Barebones) or `DeleteAsync` may fire on a dead panel.
- **`visibility: hidden` still hit-tests; `collapse` does not.** Use `visibility: collapse` for
  modals/drawers so collapsed panels do not eat mouse clicks behind them. Set `hittest="false"` on
  every non-interactive overlay (toast containers, banners) so they never steal clicks/focus.
- **Custom screens steal chat focus.** Call `panel.SetAcceptsFocus(true)` on your container
  (team-select does this) or the chat box grabs focus and keystrokes vanish.
- **Mutating Valve's HUD is version-fragile.** `FindDotaHudElement` / climbing `GetParent()` to the
  `Hud` root works today but element ids change across Dota patches — guard every `FindChildTraverse`
  result against `null` and degrade gracefully.
- **Reactive reconciler is a big dependency.** Guarding Athena ships a full React/SolidJS reconciler
  bundle. It is powerful (net-table listeners in `createEffect` + `onCleanup`) but it is a webpack
  build pipeline, not raw Panorama — only adopt it for genuinely complex, frequently-re-rendering
  HUDs; for most panels prime-then-subscribe + `$.CreatePanel` is simpler and ships faster.
- **`setInterval(fn, Game.GetGameFrameTime())` must be cleaned up.** If you drive an update loop with
  `setInterval`, store the handle and `clearInterval` it on unmount (Guarding Athena) — otherwise it
  leaks across panel reloads. The `$.Schedule` self-reschedule idiom avoids this but cannot be
  cancelled cleanly mid-flight, so guard it with a flag.
