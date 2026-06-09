# Particles & Effects in Panorama

This document covers how to display Dota 2 particle systems (`.vpcf`) and visual effects in **Panorama custom UI** for custom games. It is Dota-2-specific and is NOT web development: there is no `<canvas>`, no WebGL, no CSS particles. Effects come from the game's compiled particle content rendered through specialized Dota panel types or the clientside `Particles` scripting global.

> Grounding note: the JS/TS method signatures, the `Particles` global, the `ParticleAttachment_t` enum, and the Lua `ParticleManager` methods below were verified against this bundle's machine-readable API dumps (`src/data/panorama-api.json`, `src/data/dota-api.json`). The scene-panel **XML attribute names** are Valve panel-source identifiers and are **not** present in the machine-readable dumps. Valve writes these attributes in **lowercase** in engine sources (e.g. `particlename`, `cameraorigin`, `lookat`, `startactive`); attribute parsing is effectively case-insensitive in practice, but treat the casing shown here as illustrative and confirm against your build — see "Common pitfalls" for how to dump exact, build-current names in-engine.

---

## 1. Two completely separate systems

There are **two unrelated APIs** for putting particles on screen. Conflating them is the single biggest source of bugs.

| | Server Lua `ParticleManager` | Client Panorama `Particles` global |
|---|---|---|
| Class | `CScriptParticleManager` (via global `ParticleManager`) | `CScriptBindingPR_Particles` (via global `Particles`) |
| Runs on | Game server (vscripts `*.lua`) | Each client (Panorama JS/TS) |
| Networked? | Yes — authoritative, everyone sees it | **No** — only the local client sees it |
| Entity argument | A Lua entity handle (`CBaseEntity`) | An `EntityIndex` (a number), or `-1` |
| Destroy method | `ParticleManager:DestroyParticle(id, immediate)` | `Particles.DestroyParticleEffect(id, immediate)` |
| Use for | Gameplay VFX all players must see | Per-client UI flourishes / screen-space FX |

Two consequences that bite people:

- A particle created with the **client** `Particles` global is **not networked** — other players never see it.
- A particle created on the **server** with `ParticleManager` **cannot be parented to a Panorama panel**. It lives in the 3D world.

### Rendering routes for UI

1. **`<DOTAParticleScenePanel>`** — declarative, plays one `.vpcf` in an offscreen 3D scene composited into a panel. The clean way for icon FX, reward bursts, ability previews.
2. **`<DOTAScenePanel>`** — renders hero models / units / background maps in a panel; can also host particles via fired entity inputs.
3. **`Particles` global + `PATTACH_CUSTOMORIGIN`** — create a world particle and drive its control points from converted screen coordinates so it overlays the HUD. The true "screen-space" route; heavier and fiddlier.

Prefer route 1 for almost all UI. Use route 3 only when you need an effect anchored to a moving HUD element or the cursor and want to avoid spinning up a per-panel offscreen render.

---

## 2. `<DOTAParticleScenePanel>` — declarative particle-in-a-panel

This panel type is `ParticleScenePanel`, which extends `ScenePanel`. Verified JS surface (from `panorama-api.json`):

```ts
interface ParticleScenePanel extends ScenePanel {
    StartParticles(): void;
    StopParticlesImmediately(b: boolean): void;
    StopParticlesWithEndcaps(): void;
    SetControlPoint(cp: number, x: number, y: number, z: number): void;
}
```

Note `SetControlPoint(cp, x, y, z)` takes **four separate numbers**, not a tuple — unlike the `Particles` global's `SetParticleControl`, which takes a `[x, y, z]` array.

### XML attributes

The panel renders a `.vpcf` into a small offscreen camera-rendered scene, then composites that texture into the panel rectangle.

- `particlename` — path to the **compiled** vpcf: `particles/.../name.vpcf`. Engine path, forward slashes, with the `.vpcf` extension. Use the **Parent** particle (marked **P** in the Asset Browser); children "are harder to display and might not show or display properly."
- `particleonly` — set `"true"` for `DOTAParticleScenePanel` (renders only the particle, no map/unit).
- `cameraorigin` — `"x y z"` world position of the panel camera (space-separated triple).
- `lookat` — `"x y z"` point the camera aims at.
- `cameradist` — convenience: how far back the camera sits from the effect (alternative to fully specifying origin/lookAt). (Note the spelling — it is `cameradist`, not `cameradistance`.)
- `fov` — camera field of view in degrees (smaller = more zoomed).
- `squarepixels` — `"true"` forces 1:1 pixel aspect so the particle isn't stretched in a non-square panel.
- `startactive` — `"true"` plays immediately; `"false"` waits for a `StartParticles()` JS call.
- `antialias` — `"true"` enables smoothing on the rendered scene (costs perf).
- `renderdeferred` — `"true"` uses the deferred renderer; needed for lit model content, but typically leave `"false"` for pure additive particles (deferred can darken them).

Minimal layout:

```xml
<root>
  <Panel class="MyPanelRoot">
    <DOTAParticleScenePanel
        id="RewardFX"
        class="RewardFX"
        particlename="particles/ui_mouseactions/ping_circle.vpcf"
        particleonly="true"
        startactive="true"
        squarepixels="true"
        fov="50"
        cameraorigin="0 0 200"
        lookat="0 0 0"
        renderdeferred="false"
        antialias="true"
        style="width: 128px; height: 128px;" />
  </Panel>
</root>
```

### CSS / z-order

Because the particle is rendered into the panel's texture, it is **clipped to and ordered with the panel** — unlike the `Particles`-global route, which draws in the world and ignores panel z-order. Size and position it with normal Panorama CSS. Keep the panel background transparent (the default) so your UI shows behind additive effects.

```css
.RewardFX {
    width: 128px;
    height: 128px;
    background-color: transparent; /* additive particles need this to blend right */
    opacity: 1.0;
    transition: opacity 0.15s ease-in-out;
}
```

To put it on top of siblings, order it last in the XML or give it a higher `z-index`. (Panorama CSS supports `z-index`, but unlike the web it is integer-only and only orders siblings within the same parent.)

### JS / TS control

```ts
const fx = $("#RewardFX") as ParticleScenePanel;
fx.StartParticles();                 // begin (use with startactive="false")
fx.SetControlPoint(1, 64, 0, 0);     // set CP1 = (64,0,0); drives radius/color/etc per the vpcf
fx.StopParticlesWithEndcaps();       // graceful stop (plays endcaps)
fx.StopParticlesImmediately(true);   // hard stop (the boolean's exact meaning is undocumented;
                                     // community usage treats true as "skip endcaps")
```

There is **no `SetParticleName(...)` / `SetParticleFile(...)` method** on the panel (none exists in the API dump). The vpcf is fixed at creation by the XML `particlename` attribute. To change the effect at runtime, rebuild the panel (see the `BCreateChildren` recipe in §7). Use `SetControlPoint` to parameterize radius/tint/intensity without rebuilding.

---

## 3. `<DOTAScenePanel>` — hero models / units / maps in UI

`ScenePanel` is the parent type of `ParticleScenePanel`, with the richest JS surface. Verified methods (from `panorama-api.json`):

```ts
interface ScenePanel extends Panel {
    FireEntityInput(entityName: string, inputName: string, value: string): void;
    PlayEntitySoundEvent(arg1: any, arg2: any): number;
    SetUnit(unitName: string, environment: string, drawBackground: boolean): void;
    GetPanoramaSurfacePanel(): Panel | null;
    SetRotateParams(yawMin: number, yawMax: number, pitchMin: number, pitchMax: number): void;
    SpawnHeroInScenePanelByPlayerSlot(match_id: string, slot: number, entityName: string): boolean;
    SpawnHeroInScenePanelByHeroId(heroID: number, entityName: string, econId: number): boolean;
    SetScenePanelToPlayerHero(heroName: string, player: PlayerID): boolean;
    SetScenePanelToLocalHero(heroId: HeroID): boolean;
    SetPostProcessFade(value: number): void;
    SetCustomPostProcessMaterial(material: string): void;
    SpawnHeroInScenePanelByPlayerSlotWithFullBodyView(heroName: string, player: PlayerID): boolean;
    LerpToCameraEntity(entityName: string, duration: number): void;
    ReloadScene(): void;
    ClearScene(unknown1: boolean): void;
    SetAnimgraphParameterOnEntityInt(entityName: string, name: string, value: number): void;
    SetAnimgraphParameterOnEntityFloat(entityName: string, name: string, value: number): void;
    SetAnimgraphParameterOnEntityEnum(entityName: string, name: string, value: string): void;
}
```

### XML attributes

- `unit` — a unit name to display, e.g. `unit="npc_dota_hero_sven"`.
- `particleonly` — **must be `"false"` for `DOTAScenePanel` to display anything other than particles.** This is the most common mistake.
- `map` — a background `.vmap` compiled as a background map (found in the Asset Browser `background` folder).
- `light` — name of a light entity in the scene/map (e.g. an `env_global_light` named `light`). Without a light, lit geometry renders **black**.
- `camera` — name of a `point_camera` entity to view through, e.g. `camera="camera1"`.
- `environment` — environment/lighting environment name (matches the 2nd arg of `SetUnit`).
- `drawbackground` — whether the map/skybox background is drawn vs. transparent.
- `allowrotation` — `"true"` lets the user drag-rotate the model (armory behavior). **Not compatible with custom background maps.**
- `renderdeferred` — deferred rendering path; use for correct PBR hero lighting.
- `acceptsfocus` — set `"true"` if you want drag/rotate input.
- `id` — required to target the panel with fired entity inputs.

```xml
<!-- Hero portrait, simplest form -->
<DOTAScenePanel style="width:400px;height:400px;"
    unit="npc_dota_hero_sven" particleonly="false"/>

<!-- Background map + named light + named camera -->
<DOTAScenePanel style="width:400px;height:400px;"
    map="background" light="light" camera="camera1" particleonly="false"/>

<!-- Needs an id to receive entity inputs -->
<DOTAScenePanel id="scene" style="width:400px;height:400px;" map="background"/>
```

### Behavioral facts

- **No dynamic unit swap via attribute.** You cannot change `unit`/`map` after creation by editing the attribute (the panel "has no custom dynamic properties"). Use the JS methods (`SetUnit`, `SpawnHeroInScenePanelByHeroId`, `SetScenePanelToLocalHero`), or rebuild the panel from a layout string:

```ts
const camera = "camera1";
const style  = "width:400px;height:400px;";
$("#SomeContainer").BCreateChildren(
  `<DOTAScenePanel style='${style}' map='background' particleonly='false' light='light' camera='${camera}'/>`);
```

- **Map edits require recompiling the map** (which updates the panel without restarting the game), but the map still cannot change at runtime.

### Firing entity inputs (including starting particles in a scene)

This is essentially a `DoEntFire` for `DOTAScenePanel`. Two forms:

XML attribute form (looks like a call but is an event dispatch):

```xml
<Button onactivate="DOTAGlobalSceneFireEntityInput(scene, donkey, SetAnimation, death)"/>
```

JS form:

```ts
$.DispatchEvent('DOTAGlobalSceneFireEntityInput', 'scene', 'donkey', 'SetAnimation', 'spawn');
// or on the panel instance:
($("#scene") as ScenePanel).FireEntityInput('donkey', 'SetAnimation', 'spawn');
```

Useful inputs: `SetAnimation`, `RunScriptFile` (no extension), `RunScriptCode`. Note `RunScript*` runs **clientside Lua only and is heavily sandboxed** — you can't even move things there; about the only useful thing is spawning particles (clientside Lua does have `ParticleManager` support).

---

## 4. The `Particles` global — screen-space & world particles from JS

`declare const Particles: CScriptBindingPR_Particles;`. Full verified interface (from `panorama-api.json`):

```ts
interface CScriptBindingPR_Particles {
    /** Create a particle from a file with an attachment and an owning entity. */
    CreateParticle(particleName: string, particleAttach: ParticleAttachment_t, owningEntity: EntityIndex): ParticleID;

    /** Frees the particle index so another particle can reuse it. */
    ReleaseParticleIndex(particle: ParticleID): void;

    /** Destroy a particle. immediate=true prevents the endcap from playing. */
    DestroyParticleEffect(particle: ParticleID, immediate: boolean): void;

    /** Set a control point to a vector value. */
    SetParticleControl(particle: ParticleID, controlPoint: number, value: [number, number, number]): void;

    /** [OBSOLETE - Use SetParticleControlTransformForward] */
    SetParticleControlForward(particle: ParticleID, controlPoint: number, value: [number, number, number]): void;

    SetParticleControlTransform(
        particle: ParticleID, controlPoint: number,
        origin: [number, number, number], angles: [number, number, number]): void;

    SetParticleControlTransformForward(
        particle: ParticleID, controlPoint: number,
        origin: [number, number, number], forward: [number, number, number]): void;

    SetParticleAlwaysSimulate(particle: ParticleID): void;

    SetParticleControlEnt(
        particle: ParticleID, controlPoint: number, entity: EntityIndex,
        particleAttach: ParticleAttachment_t, attachmentName: string,
        offset: [number, number, number], unknown: boolean): void;
}
```

Key facts:

- `owningEntity` is an **`EntityIndex`** (a number). For screen-space FX with no relevant entity, pass `-1`.
- Vectors are **TS tuples `[x, y, z]`** in Panorama (in Lua they are `Vector(x, y, z)`).
- **Always pair create with destroy + release.** After `DestroyParticleEffect`, call `ReleaseParticleIndex` to free the handle. Leaking handles is a real bug source.

```ts
Particles.DestroyParticleEffect(fx, false); // false = play end caps; true = instant
Particles.ReleaseParticleIndex(fx);
```

- `SetParticleControlForward` is obsolete — use `SetParticleControlTransformForward`.

### `ParticleAttachment_t` (verified, exact values)

```ts
declare enum ParticleAttachment_t {
    PATTACH_INVALID = -1,
    PATTACH_ABSORIGIN = 0,
    PATTACH_ABSORIGIN_FOLLOW = 1,
    PATTACH_CUSTOMORIGIN = 2,
    PATTACH_CUSTOMORIGIN_FOLLOW = 3,
    PATTACH_POINT = 4,
    PATTACH_POINT_FOLLOW = 5,
    PATTACH_EYES_FOLLOW = 6,
    PATTACH_OVERHEAD_FOLLOW = 7,
    PATTACH_WORLDORIGIN = 8,
    PATTACH_ROOTBONE_FOLLOW = 9,
    PATTACH_RENDERORIGIN_FOLLOW = 10,
    PATTACH_MAIN_VIEW = 11,
    PATTACH_WATERWAKE = 12,
    PATTACH_CENTER_FOLLOW = 13,
    PATTACH_CUSTOM_GAME_STATE_1 = 14,
    PATTACH_HEALTHBAR = 15,
    MAX_PATTACH_TYPES = 16,
}
```

String equivalents (used in datadriven KV and model attach names):

| Constant | String | Note |
|---|---|---|
| `PATTACH_ABSORIGIN_FOLLOW` | `follow_origin` | Follows target origin |
| `PATTACH_OVERHEAD_FOLLOW` | `follow_overhead` | Over the head |
| `PATTACH_ABSORIGIN` | `attach_origin` | Stays at origin |
| `PATTACH_POINT` | `attach_hitloc` | Body / hit location |
| `PATTACH_POINT_FOLLOW` | `follow_hitloc` | Follows body |
| `PATTACH_CUSTOMORIGIN` | `start_at_customorigin` | Custom origin (CP-driven) |
| `PATTACH_CUSTOMORIGIN_FOLLOW` | `follow_customorigin` | Follows custom origin |
| `PATTACH_WORLDORIGIN` | `world_origin` | Targets a point entity (use with the `TargetPoint` key) |
| `PATTACH_EYES_FOLLOW` | `follow_eyes` | **Fills the screen** (stun/arcana-drop overlays) |

`PATTACH_EYES_FOLLOW` is notable for UI: it is the engine's own full-screen attach used for the damage-stun and arcana-drop overlays. It is the fastest way to make a vpcf fill the player's screen with no coordinate math — but it follows the player's eyes, so it tracks camera movement.

---

## 5. Screen-space particles via `PATTACH_CUSTOMORIGIN`

Because the `Particles` global draws in the **3D world**, "panel-attached" really means: create with `PATTACH_CUSTOMORIGIN`, then each frame convert a panel's screen rectangle to a world position and feed it into the particle's control point.

**Important correction vs. common docs:** the screen↔world helpers live on the **`Game`** global (`CScriptBindingPR_Game`), not `GameUI`. The cursor / clamped helpers live on `GameUI` (`CDOTA_PanoramaScript_GameUI`). Both placements below are verified against the API dump:

```ts
// On the Game global (CScriptBindingPR_Game):
Game.GetScreenWidth(): number;
Game.GetScreenHeight(): number;
Game.ScreenXYToWorld(nX: number, nY: number): [number, number, number];
Game.WorldToScreenX(x: number, y: number, z: number): number;
Game.WorldToScreenY(x: number, y: number, z: number): number;

// On the GameUI global (CDOTA_PanoramaScript_GameUI):
GameUI.GetCursorPosition(): [number, number];
GameUI.GetScreenWorldPosition(screenPos: [number, number]): [number, number, number] | null;
GameUI.WorldToScreenXYClamped(vec3: [number, number, number]): [number, number, 0];
```

Pattern:

```ts
function panelToWorld(panel: Panel): [number, number, number] {
    // Panorama lays out against a virtual 1080-tall coordinate space; layout-unit
    // offsets must be scaled up to real device pixels before feeding ScreenXYToWorld.
    const scale = Game.GetScreenHeight() / 1080;
    const cx = (panel.actualxoffset + panel.actuallayoutwidth  / 2) * scale;
    const cy = (panel.actualyoffset + panel.actuallayoutheight / 2) * scale;
    return Game.ScreenXYToWorld(cx, cy);
}

const fx = Particles.CreateParticle(
    "particles/ui/my_screen_fx.vpcf",
    ParticleAttachment_t.PATTACH_CUSTOMORIGIN, -1);

const setPos = () => {
    const w = panelToWorld($("#Target"));
    Particles.SetParticleControl(fx, 0, w); // CP0 = custom origin (check the vpcf)
    Particles.SetParticleControl(fx, 3, w); // many UI vpcf use CP3 as the screen anchor
};
setPos();

// To follow a moving panel, re-run each frame:
const tick = () => { setPos(); $.Schedule(0, tick); };
tick();
```

Realities:

- The panel-px → control-point mapping is **per-vpcf**. Open the file in the Particle Editor to learn which CP is the origin (often CP0; Valve's screen-space UI particles frequently use CP3). Wrong CP ⇒ the effect appears at world `(0,0,0)`.
- This route **ignores panel clipping and z-order**. It composites by world depth and can render behind or in front of HUD unexpectedly. For most UI, prefer `<DOTAParticleScenePanel>`.
- `SetParticleControlEnt` anchors a CP to an entity attachment instead of a static point; `entity` is an `EntityIndex`.

---

## 6. Server-side Lua and precache

The server `ParticleManager` global is class `CScriptParticleManager`. Verified methods (from `dota-api.json`):

```lua
ParticleManager:CreateParticle(particleName, particleAttach, owner)            -- owner: CBaseEntity|nil
ParticleManager:CreateParticleForPlayer(particleName, particleAttach, owner, player)  -- player: CDOTAPlayerController
ParticleManager:CreateParticleForTeam(particleName, particleAttach, owner, team)
ParticleManager:SetParticleControl(particle, controlPoint, value)             -- value is a Vector
ParticleManager:SetParticleControlEnt(particle, cp, unit, particleAttach, attachment, offset, lockOrientation)
ParticleManager:SetParticleControlTransform(fxIndex, point, origin, qAngles)
ParticleManager:DestroyParticle(particle, immediate)                          -- NOTE: DestroyParticle, not DestroyParticleEffect
ParticleManager:ReleaseParticleIndex(particle)
```

Example:

```lua
local pfx = ParticleManager:CreateParticle(
    "particles/units/heroes/hero_omniknight/omniknight_purification.vpcf",
    PATTACH_ABSORIGIN_FOLLOW, target)
ParticleManager:SetParticleControl(pfx, 1, Vector(radius, 0, 0)) -- CP1.x = radius
-- ...later:
ParticleManager:DestroyParticle(pfx, false)
ParticleManager:ReleaseParticleIndex(pfx)
```

### Precache

Gameplay particles must be precached, or they won't show unless they originally belonged to the casting hero.

Datadriven precache block on an ability:

```
"precache"
{
    "particle"  "particles/units/heroes/hero_magnataur/magnataur_shockwave.vpcf"
}
```

Lua precache in `addon_game_mode`'s `Precache(context)` (verified signature `PrecacheResource(arg1, arg2, context)`):

```lua
function Precache(context)
    PrecacheResource("particle", "particles/units/.../x.vpcf", context)
    PrecacheResource("particle_folder", "particles/my_addon", context) -- whole folder
end
```

The divide: precaching on the server does **not** make a custom vpcf appear for the client `Particles` global if the file isn't compiled into the client's content; and a Panorama-created particle is never seen by other players regardless of server precache. If a custom vpcf path is wrong or uncompiled, the panel shows **nothing** (no error in the panel).

---

## 7. Practical recipes

### Recipe 1 — Glowing border on hover (declarative, cheapest)

```xml
<Panel class="Card">
    <DOTAParticleScenePanel
        id="CardGlow"
        particlename="particles/ui_mouseactions/range_display_ring.vpcf"
        particleonly="true" startactive="false" squarepixels="true"
        fov="40" cameraorigin="0 0 220" lookat="0 0 0"
        style="width: 100%; height: 100%; opacity: 0.0;"/>
</Panel>
```

```css
.Card:hover #CardGlow { opacity: 1.0; transition: opacity 0.15s ease-in-out; }
```

```ts
const glow = $("#CardGlow") as ParticleScenePanel;
$("#Card").SetPanelEvent("onmouseover", () => { glow.StartParticles(); glow.SetControlPoint(1, 90, 0, 0); });
$("#Card").SetPanelEvent("onmouseout",  () => glow.StopParticlesWithEndcaps());
```

### Recipe 2 — Ability-cast preview in a tooltip (rebuild to swap vpcf)

```ts
function showAbilityPreview(host: Panel, vpcf: string) {
    // particlename can't be changed on an existing panel, so rebuild:
    host.RemoveAndDeleteChildren();
    host.BCreateChildren(
      `<DOTAParticleScenePanel particlename='${vpcf}' particleonly='true' startactive='true' ` +
      `squarepixels='true' fov='60' cameraorigin='0 -350 120' lookat='0 0 60' ` +
      `style='width:256px;height:144px;'/>`);
}
showAbilityPreview($("#PreviewHost"), "particles/units/heroes/hero_lina/lina_spell_dragon_slave.vpcf");
```

### Recipe 3 — Reward burst on click

Option A — panel (recommended):

```ts
function rewardBurst(host: Panel) {
    host.RemoveAndDeleteChildren();
    host.BCreateChildren(
      "<DOTAParticleScenePanel particlename='particles/items_fx/aegis_pickup.vpcf' " +
      "particleonly='true' startactive='true' squarepixels='true' fov='55' " +
      "cameraorigin='0 0 250' lookat='0 0 0' style='width:200px;height:200px;'/>");
    $.Schedule(2.0, () => host.RemoveAndDeleteChildren());
}
$("#RewardButton").SetPanelEvent("onactivate", () => rewardBurst($("#BurstHost")));
```

Option B — true screen-space at the cursor:

```ts
$("#RewardButton").SetPanelEvent("onactivate", () => {
    const cursor = GameUI.GetCursorPosition();              // [x, y] in screen px
    const world  = Game.ScreenXYToWorld(cursor[0], cursor[1]);
    const fx = Particles.CreateParticle(
        "particles/items_fx/aegis_pickup.vpcf",
        ParticleAttachment_t.PATTACH_CUSTOMORIGIN, -1);
    Particles.SetParticleControl(fx, 0, world);
    Particles.SetParticleControl(fx, 3, world);
    $.Schedule(2.0, () => {
        Particles.DestroyParticleEffect(fx, false);
        Particles.ReleaseParticleIndex(fx);
    });
});
```

### Recipe 4 — Full-screen overlay effect with no coordinate math

```ts
// Drives the player's screen directly via the engine eyes attachment.
const heroIndex = Players.GetPlayerHeroEntityIndex(Players.GetLocalPlayer());
const overlay = Particles.CreateParticle(
    "particles/generic_gameplay/screen_arcana_drop.vpcf",
    ParticleAttachment_t.PATTACH_EYES_FOLLOW, heroIndex);
$.Schedule(3.0, () => {
    Particles.DestroyParticleEffect(overlay, false);
    Particles.ReleaseParticleIndex(overlay);
});
```

---

## 8. Common pitfalls

- **`particleonly` set wrong.** On `DOTAScenePanel`, forgetting `particleonly="false"` means the model/map won't render. On `DOTAParticleScenePanel`, you want `particleonly="true"`.
- **Black scene / black model.** No `light` entity, or a `renderdeferred` mismatch. Lit geometry with no light renders black. Add a named light; set `renderdeferred="true"` for PBR heroes. Pure additive particles need no light and can look *worse* under deferred — keep `renderdeferred="false"` for additive-only effects.
- **Camera frames empty space.** Bad `cameraorigin`/`lookat`/`fov`. Start with the effect at world origin `(0,0,0)`, the camera ~200 units back looking at it, `fov≈50`, then tune.
- **Effect clustered at `(0,0,0)`.** A required control point wasn't set. Open the vpcf in the Particle Editor to learn its CPs; set them via `SetControlPoint` (panel) or `SetParticleControl` (global).
- **Using a Child vpcf instead of the Parent.** Children "might not show or display properly." Use the **P**-marked Parent path.
- **Stretched effect.** Non-square panel without `squarepixels="true"`.
- **Wrong path/extension.** Must be `particles/.../x.vpcf` — forward slashes, with `.vpcf`. Backslashes or a missing extension produce silent nothing.
- **Mixing up destroy method names.** Server Lua is `ParticleManager:DestroyParticle`; client JS is `Particles.DestroyParticleEffect`. They are not interchangeable.
- **Calling screen helpers on the wrong global.** `ScreenXYToWorld`, `WorldToScreenX/Y`, `GetScreenWidth/Height` are on **`Game`**, not `GameUI`. `GetCursorPosition`, `GetScreenWorldPosition`, `WorldToScreenXYClamped` are on `GameUI`.
- **Leaks.** Every `Particles.CreateParticle` needs `DestroyParticleEffect` **and** `ReleaseParticleIndex`. Unreleased handles accumulate.
- **Performance.** Each scene panel spins up an offscreen camera render. Many simultaneous `DOTAParticleScenePanel`s (e.g. one per inventory slot) tank FPS; `antialias` and `renderdeferred` add more cost. Reuse panels, call `StopParticlesImmediately(true)` when offscreen, and prefer one screen-space effect over N panels.
- **Runtime swap limits.** You cannot change `unit` / `particlename` / `map` via attribute after creation (these panels have no dynamic properties). Rebuild via `BCreateChildren`, or use the JS methods (`SetUnit`, `SetScenePanelToLocalHero`, etc.).
- **z-order surprises with the global route.** `<DOTAParticleScenePanel>` obeys panel order / `z-index` (it's a texture). The `Particles`-global / `PATTACH_CUSTOMORIGIN` route does **not** — it composites by world depth.
- **Confirm XML attribute names in-engine.** The scene-panel XML attributes (`cameraorigin`, `lookat`, `startactive`, `squarepixels`, `cameradist`, etc.) are **not** in the machine-readable API dumps — only the JS methods are. Valve writes them lowercase; verify exact, build-current names with `dump_panorama_panel_factories` / `cl_panorama_script_help_2` in the Workshop Tools console, or the Valve wiki "Panels" page. (In particular, the convenience camera-pullback attribute is `cameradist`, not `cameradistance`.)

---

## 9. Quick reference

| Task | API |
|---|---|
| Declarative particle in a panel | `<DOTAParticleScenePanel particlename=... particleonly="true"/>` |
| Start/stop a panel particle | `panel.StartParticles()` / `panel.StopParticlesWithEndcaps()` / `panel.StopParticlesImmediately(true)` |
| Parameterize a panel particle | `panel.SetControlPoint(cp, x, y, z)` |
| Create a world particle from JS | `Particles.CreateParticle(name, PATTACH_*, entIndex)` |
| Set a CP from JS | `Particles.SetParticleControl(id, cp, [x,y,z])` |
| Destroy + free from JS | `Particles.DestroyParticleEffect(id, false)` then `Particles.ReleaseParticleIndex(id)` |
| Screen → world | `Game.ScreenXYToWorld(x, y)` |
| Cursor position | `GameUI.GetCursorPosition()` |
| Full-screen overlay | `Particles.CreateParticle(name, PATTACH_EYES_FOLLOW, heroIndex)` |
| Hero/unit/map in a panel | `<DOTAScenePanel unit=... particleonly="false"/>` |
| Fire a scene entity input | `$.DispatchEvent('DOTAGlobalSceneFireEntityInput', sceneId, entName, input, value)` |
| Server gameplay particle | `ParticleManager:CreateParticle(name, PATTACH_*, owner)` |
| Precache | `PrecacheResource("particle", path, context)` |
