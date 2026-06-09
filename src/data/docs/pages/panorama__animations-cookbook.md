# Panorama Animations & Effects Cookbook

A practical, copy-paste catalogue of CSS animations and visual effects used by shipping Dota 2 custom games (Guarding Athena, Dota IMBA, Pudge Wars, Dota 2 Horde Mode, and the Barebones-derived stack). Every recipe is real CSS from a decompiled VPK, paired with the JS/Lua that triggers it. Panorama CSS is *not* web CSS — it has its own property names (`pre-transform-scale2d`, `wash-color`, `saturation`, `box-shadow: fill ...`), its own `gradient()` syntax, and a different transform model. Use this as ground truth, not MDN.

## How Panorama animation works (the mental model)

There are exactly two ways to move a panel:

- **`transition-*`** — interpolates a property when its value changes (typically because a *class* was added/removed). Reversible, cheap, ideal for hover/state.
- **`@keyframes` + `animation-*`** — a fixed timeline played on the element. Use for loops (pulse/glow/spin) and one-shot entrances. Replaying a one-shot requires removing and re-adding the class.

The golden rule across all 18 games: **JS owns *state* (it toggles a boolean class), CSS owns *motion* (the transition/keyframe runs declaratively).** You will almost never set `panel.style.transform` from JS for an animation; you call `panel.SetHasClass("Foo", bool)`.

```js
// The pattern, everywhere. JS just flips a class.
myPanel.SetHasClass("ShowStorePage", true);   // CSS transition does the rest
toast.SetHasClass("ToastVisible", true);
root.SetHasClass("toggle_tutorial_button", isHidden);
```

Transform note: prefer **`pre-transform-scale2d`** for scaling and **`transform: translate3d/translateX/rotateZ/scale3d`** for movement. `pre-transform-scale2d` scales the element *around its own box without affecting layout or siblings* — it is the canonical "pop" property. Plain `transform: scale()` exists but `pre-transform-scale2d` is what shipping HUDs reach for.

---

## @keyframes loops

### Pulse / "breathe" scale loop (attractor for spendable points)

From **Guarding Athena** (`hud_main/styles.css`) — a subtle infinite scale pulse marking "you can level this up". Pairs a `box-shadow` glow with a scale loop.

```css
.Reborn .could_level_up #UpgradeStatLevelContainer .next_level.LevelPanel {
    box-shadow: fill #ffC24E 0px 0px 10px 0px;
    animation-name: pipGlow;
    animation-duration: 1.0s;
    animation-iteration-count: infinite;
    animation-timing-function: ease-in-out;
}

@keyframes 'pipGlow' {
    0%   { opacity: 1; pre-transform-scale2d: 1; }
    50%  { pre-transform-scale2d: 1.1; }
    100% { pre-transform-scale2d: 1; }
}
```

Trigger from Lua-driven state: the JS adds `.could_level_up` when the net table says points are spendable; remove it when they hit zero and the loop stops cleanly at its current frame.

```js
container.SetHasClass("could_level_up", data.unspent_points > 0);
```

### Glow "breathe" via inset box-shadow (rarity borders)

From **Dota IMBA** and **Pudge Wars** (`imba_imr.css`, `battlepass.css`). One keyframe per rarity tier; the JS only adds e.g. `.arcana_border`. Animating `box-shadow` (not size/position) keeps it GPU-cheap.

```css
@keyframes 'breathe_arcana' {
    0%   { box-shadow: inset #88ff4d 0 0 1px 0; }
    50%  { box-shadow: inset #88ff4d 0 0 4px 0; }
    100% { box-shadow: inset #88ff4d 0 0 1px 0; }
}
.arcana_border {
    animation-name: breathe_arcana;
    animation-duration: 2.0s;
    animation-timing-function: ease-in;
    animation-iteration-count: infinite;
}

@keyframes 'breathe_immortal' {
    0%   { box-shadow: inset #e6b800 0 0 1px 0; }
    50%  { box-shadow: inset #e6b800 0 0 4px 0; }
    100% { box-shadow: inset #e6b800 0 0 1px 0; }
}
.immortal_border {
    animation-name: breathe_immortal;
    animation-duration: 2.0s;
    animation-iteration-count: infinite;
}
```

```js
// When building a reward card, tag it by rarity → the right glow auto-plays.
var card = $.CreatePanel("Panel", parent, "");
card.AddClass(reward.rarity + "_border");   // "arcana_border", "immortal_border"...
```

### Spin / loader (rotateZ)

A continuous spinner is just an infinite `rotateZ` from 0 to 360. From **Dota IMBA**'s refresh icon (`imba_imr.css`) — note theirs plays *once in reverse* for button feedback; convert to a loader by going `infinite` linear:

```css
/* IMBA's one-shot button feedback */
@keyframes 'refresh' {
    0%   { transform: rotateZ(0deg); }
    100% { transform: rotateZ(180deg); }
}
#RefreshBattlepass.Active {
    animation-name: refresh;
    animation-duration: 0.55s;
    animation-iteration-count: 1;
    animation-direction: reverse;
}

/* Generic infinite spinner (same idea, full turn, looped) */
@keyframes 'spinner' {
    0%   { transform: rotateZ(0deg); }
    100% { transform: rotateZ(360deg); }
}
.LoadingSpinner {
    animation-name: spinner;
    animation-duration: 1.0s;
    animation-timing-function: linear;
    animation-iteration-count: infinite;
}
```

```js
// One-shot feedback: add the class, then strip it after the run so it can replay.
refreshBtn.AddClass("Active");
$.Schedule(0.55, function () { refreshBtn.RemoveClass("Active"); });
```

### Float / bob loop (tutorial pointer arrows)

From **Pudge Wars** (`pudgewars_tutorial.css`). Bouncing arrows that point at HUD regions, looping forever. Note the `@define` constants so all tutorial elements share one tunable clock.

```css
@define TotalLength: 3s;
@define TimingFunc: ease;
@define IterationCount: infinite;

#ArrowImage {
    animation-name: ArrowImage_anim;
    animation-duration: TotalLength;
    animation-timing-function: TimingFunc;
    animation-iteration-count: IterationCount;
}
@keyframes 'ArrowImage_anim' {
    0%   { transform: translateY(0px); }
    50%  { transform: translateY(20px); }
    100% { transform: translateY(0px); }
}

/* A horizontal pointer just swaps the axis */
@keyframes 'ArrowImagePoints_anim' {
    0%   { transform: translateX(0px); }
    50%  { transform: translateX(-20px); }
    100% { transform: translateX(0px); }
}
```

The matching callout box pulses its border glow in lockstep (same `TotalLength`):

```css
@keyframes 'PudgeWarsTutorial_anim' {
    0%   { box-shadow: -2px -2px 0px 3px #edbd28; }
    50%  { box-shadow: -2px -2px 5px 5px #edbd28; }
    100% { box-shadow: -2px -2px 0px 3px #edbd28; }
}
```

---

## Pop-in entrances (one-shot)

### Scale overshoot toast (0.2 → 1.5 → 1.0)

From **Guarding Athena** (`notification/styles.css`). New combat toasts overshoot past 1.0 then settle — a punchy kill-feed/loot entrance. Also note the container `scaleY(-1)` trick so the stack grows *upward* from the bottom.

```css
#CombatNotificationToastManager {
    flow-children: down;
    overflow: noclip noclip;
    transform: scaleY(-1);   /* flips the whole stack so it grows up */
    width: 100%;
}
#CombatNotificationToastManager > .ToastPanel {
    opacity: 0;
    transform: translateX(-40px);
    transition-property: opacity, transform;
    transition-duration: 0.2s;
    animation-name: CombatEvent;
    animation-duration: 0.41s;
    horizontal-align: left;
}
@keyframes 'CombatEvent' {
    0%   { pre-transform-scale2d: 0.2; opacity: 0; }
    50%  { pre-transform-scale2d: 1.5; opacity: 1; }
    100% { pre-transform-scale2d: 1;   opacity: 1; }
}
/* the slide settles via the transition once .ToastVisible is added */
#CombatNotificationToastManager > .ToastPanel.ToastVisible {
    opacity: 1;
    transform: none;
}
```

```js
// Build toast → next frame add .ToastVisible so the transition fires
var toast = $.CreatePanel("Panel", manager, "");
toast.AddClass("ToastPanel");
$.Schedule(0, function () { toast.AddClass("ToastVisible"); });
```

### Scale-in "slam" (2x → 1x) for notifications

The Barebones notification entrance, shipped verbatim in **Horde Mode** and **Pudge Wars** (`barebones_notifications.css`). Starts oversized and fades in for a punchy slam.

```css
@keyframes 'scalein' {
    from { opacity: 0; transform: scaleX(2) scaleY(2); }
    to   { opacity: 1; transform: scaleX(1) scaleY(1); }
}
.NotificationLine {
    animation-name: scalein;
    animation-duration: .5s;
    animation-timing-function: linear;
}
```

```js
// barebones bus: just create the line, the class on it auto-plays scalein
GameEvents.Subscribe("top_notification", function (msg) {
    var line = $.CreatePanel("Panel", $("#TopNotifications"), "");
    line.AddClass("NotificationLine");
    var lbl = $.CreatePanel("Label", line, "");
    lbl.text = msg.text;
    line.SetDeleted = false;
    $.Schedule(msg.duration || 3.0, function () { line.DeleteAsync(0); });
});
```

### Attention pop-out pulse for a big banner (0.8 → 1.2 → 1.0)

From **Guarding Athena** — round-start / boss-incoming banner. Toggling one `.PopOut` class replays a bounce.

```css
#UpperNotificationContianer.PopOut {
    animation-name: PopOut;
    animation-duration: 0.3s;
    animation-timing-function: ease-in-out;
    animation-iteration-count: 1;
}
@keyframes 'PopOut' {
    0%   { pre-transform-scale2d: 0.8; }
    50%  { pre-transform-scale2d: 1.2; }
    100% { pre-transform-scale2d: 1; }
}
#UpperNotificationContianer .NotificationListLabel { ui-scale: 200%; }
```

```js
// Replay: remove, force a layout read, re-add. (See Pitfalls re: re-trigger.)
function popBanner(panel) {
    panel.RemoveClass("PopOut");
    panel.actuallayoutwidth;          // force reflow so the removal "takes"
    panel.AddClass("PopOut");
}
```

### Slide-in panel via keyframe (translateX 100% → 0)

From **Horde Mode** (`team_select.css`). A one-shot entrance for a column.

```css
#TeamsList {
    animation-name: TeamsListAppear;
    animation-duration: 0.75s;
}
@keyframes 'TeamsListAppear' {
    0%   { transform: translatex(100%); }
    100% { transform: translatex(0px); }
}
```

### Sequencing multiple entrances WITHOUT JS (held keyframe)

From **Horde Mode** (`gamesetup_options.css`). Hold the panel off-screen for the first half of its own timeline so it enters *after* a sibling — a pure-CSS stagger.

```css
@keyframes 'CustomSettingsAppear' {
    0%   { transform: translatex(100%); }
    50%  { transform: translatex(100%); }  /* identical → holds offscreen */
    100% { transform: translatex(0px); }
}
```

---

## Transitions on :hover / state classes

### Hover pop + desaturation (the canonical card hover)

From **Dota IMBA** (`custom_loading_screen.css`). `pre-transform-scale2d` grows it without disturbing layout; `saturation` brightens the art on hover.

```css
.mod-image {
    pre-transform-scale2d: 1.0;
    saturation: 0.7;
    transition-property: saturation, pre-transform-scale2d;
    transition-duration: 0.20s;
    transition-timing-function: ease-in-out;
}
.mod-image:hover {
    pre-transform-scale2d: 1.05;
    saturation: 1.0;
}
```

### GPU-cheap button press (scale + brightness together)

From **Pudge Wars** (`battlepass.css`). Transition `pre-transform-scale2d` and `brightness` instead of any layout property.

```css
.BattlepassButton {
    transition-property: pre-transform-scale2d, brightness;
    transition-duration: 0.1s;
    transition-timing-function: ease-in;
    box-shadow: 0px 2px 6px 0px #000000a5;
}
.BattlepassButton:hover  { brightness: 1.6; }
.BattlepassButton:active { pre-transform-scale2d: 0.95; }
```

### wash-color icon recolor on hover

From **Horde Mode** (`team_select.css`). Recolor a white icon without swapping the image: grey → white on hover, red on a destructive button.

```css
#PlayerLeaveTeamButton            { wash-color: #aa0000ee; }
#PlayerLeaveTeamButton:hover      { wash-color: red; }
#ShuffleTeamAssignmentButton Image       { wash-color: #888888; }
#ShuffleTeamAssignmentButton:hover Image { wash-color: white; }
```

### Slide-in/out drawer driven purely by a class

From **Dota IMBA** / **Pudge Wars** (`imba_imr.css`, `battlepass.css`). Off-screen via `translate3d(100%)`, `visibility: collapse` removes it from hit-testing. JS just toggles `.setvisible`.

```css
#BattlepassWindow {
    transform: translate3d(100%, 0, 0px);
    visibility: collapse;
    transition-property: transform;
    transition-duration: 0.1s;
    transition-timing-function: ease-in;
}
#BattlepassWindow.setvisible {
    visibility: visible;
    transform: translate3d(0, 0, 0px);
}
#BattlepassWindow.sethidden {
    visibility: collapse;
    transform: translate3d(100%, 0, 0px);
}
```

```js
// Toggle the drawer. visibility:collapse means it also stops eating clicks.
function toggleDrawer(open) {
    var w = $("#BattlepassWindow");
    w.SetHasClass("setvisible", open);
    w.SetHasClass("sethidden", !open);
}
```

### 3D fly-in modal (perspective + translate + scale)

From **Guarding Athena** (`store/styles.css`). The store zooms in off-axis when `.ShowStorePage` is added.

```css
#StorePage {
    transition-property: opacity, transform, pre-transform-scale2d;
    transition-duration: 0.2s;
    perspective-origin: 62% 5% invert;
    perspective: 1000;
    transform: translateX(-120px) translateY(-60px);
    pre-transform-scale2d: 0.95;
    opacity: 0;
}
#StorePage.ShowStorePage {
    transform: translateX(0px) translateY(0px);
    pre-transform-scale2d: 1;
    opacity: 1;
}
```

---

## Transform tricks

### scaleY(-1) to grow a stack upward

From **Guarding Athena** combat feed (verified in `notification/styles.css`). Flip the container *and* the inner manager so children flow `down` in source order but render bottom-up. New toasts appear at the bottom and push older ones up.

```css
#CombatNotificationContianer    { transform: scaleY(-1); margin-top: 395px; height: 385px; }
#CombatNotificationToastManager { transform: scaleY(-1); flow-children: down; }
```

### Diagonal shine sweep over an icon (gradient stripe)

From **Guarding Athena** (`hud_main/styles.css`). A gradient stripe panel translated diagonally across an icon to glint it ("new item" / "ready").

```css
#Shine {
    background-color: gradient(linear, 100% 0%, 0% 100%,
        from(#00000000),
        color-stop(0.45, #ffffffff),
        color-stop(0.55, #ffffffff),
        to(#00000000));
    opacity: 0.00001;             /* invisible until swept */
    animation-duration: 0.4s;
}
#Shine.do_shine { animation-name: shine-sweep; }
@keyframes 'shine-sweep' {
    0%   { transform: translateX(-32px) translateY(32px); opacity: 1; }
    100% { transform: translateX(32px)  translateY(-32px); opacity: 1; }
}
```

```js
function glint(iconRoot) {
    var shine = iconRoot.FindChildTraverse("Shine");
    shine.RemoveClass("do_shine");
    shine.actuallayoutwidth;        // reflow so re-add replays
    shine.AddClass("do_shine");
}
```

### fly-out via combined translate + scale3d

From **Dota IMBA** (`combat_events.css`). Toast collapses by shrinking and sliding as it fades.

```css
.ToastPanel {
    opacity: 1;
    animation-name: CombatEvent;
    transition-property: position, opacity, transform;
}
.ToastPanel.ToastVisible { opacity: 1; transform: none; }
.ToastPanel.Collapsed    { opacity: 0; transform: translateX(-40px) scale3d(0.5, 0.5, 1); }
```

```js
// Dismiss: add .Collapsed, let the transition run, then delete.
toast.AddClass("Collapsed");
$.Schedule(0.3, function () { toast.DeleteAsync(0); });
```

---

## Gradients (backgrounds, bars, and text)

Panorama's `gradient()` takes a type, two stop coordinates, then `from()/color-stop()/to()`. It works as **any color value — including `color` on a Label** (gradient text).

### Gradient title text

From **Dota IMBA / Pudge Wars** end screen (`imba_end_screen.css`):

```css
#loading-title-text {
    color: gradient(linear, 0% 0%, 0% 100%,
        from(white),
        color-stop(0.5, #ffef8a),
        to(#CFC26E));
}
```

### Beveled "glass slab" panel (vertical gradient + box-shadow)

From **Horde Mode** (`team_select.css`). Layered depth on every card; the selected card gets a white glow.

```css
.TeamSelectTeam {
    background-color: gradient(linear, 100% 0%, 100% 100%,
        from(#272b30),
        color-stop(0.6, #181a1e),
        to(#181a1e));
}
.TeamSelectTeam.local_player_on_this_team {
    box-shadow: fill #ffffff40 -3px -3px 3px 6px;
}
```

### Team-colored combat-feed bars (verified, Guarding Athena)

```css
.AllyEvent  #TeamColorBar { background-color: gradient(linear, 100% 0%, 100% 100%, from(#629f52), to(#436e38)); }
.EnemyEvent #TeamColorBar { background-color: gradient(linear, 100% 0%, 100% 100%, from(#d1471f), to(#a43819)); }
#TeamColorBar { transform: rotateZ(25deg); }   /* slanted bar */
```

---

## box-shadow & text-shadow glows

`box-shadow` supports a leading `fill` (a flat colored aura behind the panel) and `inset`. `text-shadow` is `x y blur strength color` — note Panorama's odd 4-arg form `Npx Npx Npx S color`.

```css
/* Outer fill glow (Guarding Athena, level-up pip) */
.glow-attractor { box-shadow: fill #ffC24E 0px 0px 10px 0px; }

/* Inset breathing border (IMBA rarity) */
.inset-glow     { box-shadow: inset #e6b800 0 0 4px 0; }

/* Animated yellow border glow (Pudge Wars tutorial callout) */
@keyframes 'callout_glow' {
    0%   { box-shadow: -2px -2px 0px 3px #edbd28; }
    50%  { box-shadow: -2px -2px 5px 5px #edbd28; }
    100% { box-shadow: -2px -2px 0px 3px #edbd28; }
}

/* Crisp text legibility over busy backgrounds (verified across games) */
.NotificationListLabel { text-shadow: 2px 1px 0px 2 black; }
#PudgeWarsLabel        { text-shadow: 4px 4px 4px #121212; }
```

---

## wash-color / saturation / blur / contrast (state feedback on art)

These four image filters drive almost all "ability is unavailable" feedback in Dota HUDs — no second image needed. From **Guarding Athena** (`hud_main/styles.css`):

```css
/* Desaturate + blue-wash an ability the player can't afford */
.insufficient_mana #AbilityImage {
    saturation: 0;
    wash-color: #1569be;
    contrast: 0.7;
}

/* Silenced overlay scales in via a transition */
#SilencedOverlay {
    opacity: 0;
    pre-transform-scale2d: 1.2;
    transition-property: opacity, pre-transform-scale2d;
    transition-duration: 0.22s;
}
.silenced #SilencedOverlay { opacity: 1; pre-transform-scale2d: 1; }

/* Active ability bevel flares bright */
.Reborn .is_active #AbilityBevel {
    brightness: 6;
    transition-timing-function: ease-out;
}
```

```js
// JS just reflects net-table / engine state onto classes; CSS reacts.
slot.SetHasClass("insufficient_mana", ability.GetManaCost() > Players.GetMana());
slot.SetHasClass("silenced", caster.IsSilenced());
slot.SetHasClass("is_active", ability.GetToggleState());
```

`blur` is also available (`blur: 3px;`) — commonly applied to a backdrop panel behind a modal. Use sparingly (see Pitfalls).

---

## Reveal / intro sequences

### Ken-Burns loading background (scale + @define clock)

From **Horde Mode** (verified, `custom_loading_screen.css`). A 30s slow zoom/pan, with the duration bound to a `@define` token so it's tunable in one place. The parent is pre-scaled 1.35 and clips so the pan never shows edges.

```css
@define TotalLength: 30s;
@define TimingFunc: linear;
@define IterationCount: 1;

#seq    { overflow: clip; pre-transform-scale2d: 1.35, 1.35; }
#seq_bg {
    animation-name: seq_bg_anim;
    animation-duration: TotalLength;
    animation-timing-function: TimingFunc;
    animation-iteration-count: IterationCount;
}
@keyframes 'seq_bg_anim' {
    0%   { transform: translateX(0px)   translateY(0px); }
    100% { transform: translateX(-60px) translateY(-30px); }
}
```

### Whole-overlay collapse with one class (descendant cascade)

From **Pudge Wars** (verified, `pudgewars_tutorial.css`). Add ONE class to the root and every callout/arrow collapses via descendant selectors — the cleanest "hide all" in Panorama.

```css
.toggle_tutorial_button #PudgeWarsLabel     { visibility: collapse; }
.toggle_tutorial_button #ArrowImage         { visibility: collapse; }
.toggle_tutorial_button .PudgeWarsTutorial  { visibility: collapse; }
/* ...one rule per element, all gated on the single root class... */
```

```js
$("#ToggleTutorialButton").SetPanelEvent("onactivate", function () {
    var root = $.GetContextPanel();
    root.SetHasClass("toggle_tutorial_button", !root.BHasClass("toggle_tutorial_button"));
});
```

---

## Number tickers & animated bars

Panorama has no "count-up" primitive; ticker effects are done one of two ways.

### Animated bar fill via width transition (the easy way)

From **Pudge Wars / IMBA** end screen (`frostrose_end_screen.css`). Start at `width: 0%`, transition `width`; JS sets the final percentage and the bar fills smoothly over 2s. A `.level-up` keyframe layers a gold glow when the player dinged.

```css
#es-player-xp-progress {
    background-color: gradient(linear, 0% 0%, 0% 100%, from(#006E2E), to(#00540E));
    width: 0%;
    height: 24px;
    transition-property: width;
    transition-duration: 2s;
}
.level-up {
    animation-name: level_up;
    animation-duration: 2.0s;
    animation-iteration-count: infinite;
}
@keyframes 'level_up' {
    0%   { box-shadow: fill #ffd70000 0 0 0px 0; }
    50%  { box-shadow: fill #ffd700ff 0 0 12px 2px; }
    100% { box-shadow: fill #ffd70000 0 0 0px 0; }
}
```

```js
// Defer one frame so the 0% baseline is committed before the target width,
// otherwise the transition is skipped (see Pitfalls).
bar.style.width = "0%";
$.Schedule(0, function () {
    bar.style.width = pct + "%";
    if (leveledUp) bar.AddClass("level-up");
});
```

### True number count-up via a scheduled lerp

When you need the *digits* to roll (gold gained, score), interpolate in JS on a `$.Schedule` loop and write the label each tick. Pattern distilled from the IMBA/Barebones polling loops.

```js
function tickerTo(label, from, to, seconds) {
    var start = Game.GetGameTime();
    function step() {
        var t = Math.min(1, (Game.GetGameTime() - start) / seconds);
        var eased = 1 - Math.pow(1 - t, 3);           // easeOutCubic
        label.text = Math.floor(from + (to - from) * eased).toString();
        if (t < 1) $.Schedule(0, step);
    }
    step();
}
// tickerTo($("#GoldLabel"), oldGold, newGold, 0.6);
```

For live HUD values where there's no event at all, IMBA/Horde just poll:

```js
function UpdateStats() {
    kda.text = Players.GetKills(p) + " / " + Players.GetDeaths(p) + " / " + Players.GetAssists(p);
    $.Schedule(1.0, UpdateStats);   // self-rescheduling; throttle to what you need
}
UpdateStats();
```

---

## Particle-in-panel (live 3D / world particles)

### Live model preview inside a panel (DOTAScenePanel)

From **Pudge Wars** (`battlepass.js`) — inline a scene panel via `BLoadLayoutFromString`, masked with the stock hero-opacity mask so it fades at the edges. No separate XML file needed.

```js
companionPreview.BLoadLayoutFromString(
    '<root><Panel><DOTAScenePanel style="width:100%;height:100%;" ' +
    'unit="' + companion_unit[i] + '" ' +
    'particleonly="false" antialias="true" /></Panel></root>',
    false, false);
companionPreview.style.opacityMask =
    'url("s2r://panorama/images/masks/hero_model_opacity_mask_png.vtex")';
```

In XML you can also declare a particle directly:

```xml
<DOTAParticleScenePanel id="MyFx"
    particleName="particles/ui/my_panel_glow.vpcf"
    cameraOrigin="0 0 100" lookAt="0 0 0"
    style="width:200px; height:200px;" />
```

### World particle pinged from JS (quest marker)

Guarding Athena's quest tracker pings the world at a task position. The panel sends a custom event; the **server** spawns the particle (clients can't authoritatively create world particles for everyone).

```js
// client: ask the server to ping
GameEvents.SendCustomGameEventToServer("task_ping", { task_id: id });
```

```lua
-- server (task.lua style): question-mark particle + team ping at TaskPosition
local fx = ParticleManager:CreateParticle(
    "particles/ui_mouseactions/ping_questionmark.vpcf",
    PATTACH_ABSORIGIN, nil)
ParticleManager:SetParticleControl(fx, 0, task.TaskPosition)
ParticleManager:ReleaseParticleIndex(fx)
MinimapEvent(team, nil, task.TaskPosition.x, task.TaskPosition.y,
    DOTA_MINIMAP_EVENT_HINT_LOCATION, 2.0)
```

---

## Wiring it from Lua → JS → CSS (end to end)

The full loop most games use: server fires a custom event → JS handler flips a class → CSS animates.

```lua
-- server: fire the banner pop with a localized message
CustomGameEventManager:Send_ServerToAllClients("notification_upper", {
    message = "#round_incoming",
    duration = 2.0,
})
```

```js
// client: receive, set text, replay the PopOut keyframe
GameEvents.Subscribe("notification_upper", function (data) {
    var c = $("#UpperNotificationContianer");
    $("#UpperLabel").text = $.Localize(data.message);
    c.RemoveClass("PopOut");
    c.actuallayoutwidth;        // force reflow → keyframe re-runs
    c.AddClass("PopOut");
});
```

```css
/* CSS owns the motion (see "Attention pop-out pulse" above) */
#UpperNotificationContianer.PopOut { animation-name: PopOut; animation-duration: 0.3s; }
```

---

## Pitfalls

**Keyframe percentages must include 0% (or `from`) and 100% (or `to`).** Panorama does not interpolate from the element's current value the way you might expect for a missing `0%`. Always anchor both ends; the breathe/pulse loops above return to their start value at `100%` so the loop seam is invisible.

**Quote keyframe names.** Every shipping game writes `@keyframes 'CombatEvent'` with single quotes around the name, and references it unquoted in `animation-name: CombatEvent;`. Unquoted `@keyframes Foo` can fail to parse.

**Re-triggering a one-shot animation requires remove → reflow → re-add.** Simply re-adding a class that's already present does nothing. Remove the class, *read a layout property* (`panel.actuallayoutwidth`, or any geometry getter) to force a synchronous reflow, then add it back. This is why Guarding Athena's shine/banner replays read `actuallayoutwidth` between toggles. A frame-deferred `$.Schedule(0, ...)` between remove and add also works.

**width/position transitions need a committed baseline.** Setting `width: 0%` then `width: 80%` in the same JS turn often skips the transition because Panorama batches the style writes. Set the baseline, `$.Schedule(0, ...)`, then set the target — exactly what the XP-bar code does.

**Transition vs animation — pick deliberately.** Use a `transition` for reversible, state-driven motion (hover, drawer open/close, ability available/unavailable): it interpolates *to the new value* whenever a class changes and reverses for free. Use `@keyframes` for loops and for fixed entrances/exits whose path doesn't depend on prior state. Trying to make a keyframe "reverse on close" is painful; a transition does it automatically (see the `#BattlepassWindow` drawer).

**Animate cheap properties.** `pre-transform-scale2d`, `transform` (translate/rotate/scale3d), `opacity`, `brightness`, `saturation`, `wash-color`, and `box-shadow` are GPU-friendly and don't reflow. Avoid animating `width`/`height`/`margin`/`padding`/layout properties in loops — every frame triggers layout. The rarity "breathe" effects animate only `box-shadow` precisely for this reason. `blur` is the most expensive filter; never put it on an infinite loop or a large fullscreen panel, and prefer blurring a small static backdrop over a moving element.

**`visibility: collapse` removes from layout AND hit-testing; `opacity: 0` does not.** An `opacity: 0` panel still eats mouse clicks and still occupies space. Drawers/modals use `collapse` in their hidden state (e.g. `#BattlepassWindow`) so an off-screen panel can't intercept clicks. But you can't transition *to* collapse and see the motion — keep the panel visible during the transition, then set collapse at the end (or rely on the off-screen `translate3d` and only collapse for hit-testing once it's parked).

**Add/remove classes from JS, don't set inline animation styles.** Keep state in boolean classes (`SetHasClass`) so designers can retune timing in CSS without touching JS, and so multiple state classes compose. Setting `panel.style.animationName` from JS bypasses the cascade and is hard to reverse. The one exception is dynamic *values* (a bar's target `width`, a ticker's `text`).

**Sound on animation — fire it from JS/Lua, not CSS.** Panorama CSS cannot emit sounds. Trigger UI sounds alongside the class toggle: `$.DispatchEvent("PlaySoundEffect", "ui.notification_in")` (or set `soundevent` on a button) at the moment you add the entrance class, and play rarity drop sounds (as Pudge Wars' end screen does) when you reveal each reward card. Keep the sound and the visual on the same code path so they never desync. For *world/gameplay* sounds use `EmitSound` server-side in Lua.

**Replaying staggered/sequenced entrances.** The "held keyframe" stagger (Horde Mode's `50% { translatex(100%) }`) only sequences on the *initial* play. If you need to replay the whole sequence (e.g. reopening the lobby), you must remove and re-add the animation classes on every element, or rebuild the panels.

**`@define` constants are file-scoped and compile-time.** They're great for one tunable clock (`TotalLength`), but you can't change them at runtime from JS — they're substituted when the CSS compiles. For runtime-variable timing, set `animation-duration` via an inline style or a class.

**Dynamically generated handlers capture by reference (Panorama v8 quirk).** When wiring `onactivate`/`onmouseover` inside a `for` loop (reward cards, vote buttons, generated toasts), wrap the handler in an IIFE to capture the loop variable *by value*. Pudge Wars explicitly notes this; without it every panel ends up referencing the last loop value.

```js
for (var i = 0; i < items.length; i++) {
    var p = $.CreatePanel("DOTAShopItem", list, "");
    (function (panel, name) {                       // capture by value
        panel.SetPanelEvent("onmouseover", function () {
            $.DispatchEvent("DOTAShowAbilityTooltip", panel, name);
        });
    })(p, items[i]);
}
```

**Clean up timers and listeners.** Self-rescheduling `$.Schedule` loops and `setInterval(Update, Game.GetGameFrameTime())` ticks must be stopped when the panel is removed (Guarding Athena's reactive components `clearInterval` in `onCleanup`; toast deletes guard with a `.deleted` flag before `DeleteAsync`). A leaked 10Hz poll on a deleted panel throws every frame.

**`pre-transform-scale2d` vs `transform: scale()`.** `pre-transform-scale2d` scales the panel in place around its own box and is the property the HUDs animate for "pop". `transform: scale3d/scaleX/scaleY` participates in the transform stack (and `scaleY(-1)` is the flip trick). Mixing both on one element gets confusing — pick one scaling mechanism per element.
