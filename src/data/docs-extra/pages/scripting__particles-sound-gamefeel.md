# Particles, Sound & Game Feel

A practical, Dota-2-specific reference on making custom games *feel* good, distilled
from shipping Workshop games (Guarding Athena, Dota IMBA, Horde Mode, Angel Arena
Reborn, Life In Arena, and the DotaCraft popups library many of them reuse). Everything
here is VScript (server Lua) and Panorama (JS/CSS) — none of it is web dev, even where
the syntax looks familiar.

The three pillars:

1. **Particles** — `ParticleManager` from server Lua, control points, attach points,
   per-team visibility, and a leak-free lifecycle.
2. **Sound** — `EmitSound*` / `StopSound*`, custom `.vsndevts` soundevents, scoping.
3. **Game feel** — screen shake, camera control, knockback/motion, floating numbers,
   hit-stop, vignette/flash.

The single biggest mistake across all of these is **leaking** — orphaned particles and
orphaned looping sounds. Read the lifecycle sections, then read "Pitfalls" at the end.

---

## 1. Particles

### The mental model

`ParticleManager:CreateParticle` returns an **integer index** into the engine's particle
table — *not* a handle. You configure the system by writing numbered **control points**
(CPs), which the `.vpcf` reads to position, color, scale, or otherwise drive itself.
You're responsible for that index until the system is either released or destroyed.

```lua
local fx = ParticleManager:CreateParticle(sEffectName, iAttachType, hParent)
ParticleManager:SetParticleControl(fx, 0, vPosition)          -- CP0 by world vector
ParticleManager:SetParticleControlEnt(fx, 1, hEnt, attach, name, origin, follow) -- CP follows a bone
-- ... then release OR store-and-destroy (see lifecycle)
```

There is no universal meaning for CP numbers — each `.vpcf` decides. By strong convention
CP0 is the system origin and CP1 is a secondary point (velocity, endpoint, or radius).
You must know what the specific particle expects; the games below pack radius, color, and
even digit-counts into CPs.

### Attach types (`PATTACH_*`)

Pass these as the second arg to `CreateParticle`, and again to `SetParticleControlEnt`:

| Attach | Use |
|---|---|
| `PATTACH_ABSORIGIN` | Snap once to the entity's origin (no follow). |
| `PATTACH_ABSORIGIN_FOLLOW` | Track the entity origin every frame. The workhorse. |
| `PATTACH_POINT_FOLLOW` | Track a **named bone/attachment** (e.g. `attach_hitloc`, `attach_weapon`). Required for things like shields to sit correctly. |
| `PATTACH_OVERHEAD_FOLLOW` | Float above the unit's head. Used for overhead text/icons. |
| `PATTACH_CUSTOMORIGIN` | No parent; you drive CPs manually (projectiles, world FX). |
| `PATTACH_WORLDORIGIN` | Pinned to a world point. |
| `PATTACH_EYES_FOLLOW` | **Screen-space** — locked to the player's view. Used for full-screen kill banners and vignettes. |

`SetParticleControlEnt(fx, cp, hEnt, attachType, attachName, vFallback, bWithEnt)` binds a
control point to a *bone on an entity*. `attachName` is the model attachment string
(`"attach_hitloc"`, `"attach_weapon"`, `"attach_wing_l"`). The `bWithEnt` flag (last arg)
makes the CP include the entity's offset.

### Lifecycle A — fire-and-forget (`ReleaseParticleIndex`)

The single most common pattern in shipping code. Create, set CPs, **release immediately**.
`ReleaseParticleIndex` does *not* stop the effect — it tells the engine "I'm done holding
this index; free it (and the system) once it finishes playing." Zero Lua bookkeeping, no
leak. Use for impacts, beams, lifesteal pings, damage numbers — anything that plays once.

```lua
-- Guarding Athena, modifier_common.lua (lifesteal ping)
local fx = ParticleManager:CreateParticle(
    "particles/generic_gameplay/generic_lifesteal.vpcf",
    PATTACH_ABSORIGIN_FOLLOW, hParent)
ParticleManager:ReleaseParticleIndex(fx)
```

```lua
-- Angel Arena Reborn, golem_big_throw_rock.lua (world impact)
local fx = ParticleManager:CreateParticle(
    "particles/neutral_fx/mud_golem_hurl_boulder_explode.vpcf",
    PATTACH_CUSTOMORIGIN, nil)
ParticleManager:SetParticleControl(fx, 3, vLocation)
ParticleManager:ReleaseParticleIndex(fx)
```

```lua
-- Horde Mode, brain_sap_lua.lua — a beam connecting two hit locations
local fx = ParticleManager:CreateParticle(
    "particles/units/heroes/hero_bane/bane_sap.vpcf",
    PATTACH_CUSTOMORIGIN_FOLLOW, unit)
ParticleManager:SetParticleControlEnt(fx, 0, caster, PATTACH_ABSORIGIN_FOLLOW, "attach_hitloc", caster:GetAbsOrigin(), true)
ParticleManager:SetParticleControlEnt(fx, 1, unit,   PATTACH_ABSORIGIN_FOLLOW, "attach_hitloc", unit:GetAbsOrigin(),   true)
ParticleManager:ReleaseParticleIndex(fx)
```

> Rule of thumb: if the effect has a finite duration baked into the `.vpcf`, release it
> the same frame you create it. Only *hold* the index for effects you must stop early.

### Lifecycle B — persistent FX you must end early (`DestroyParticle`)

For looping/held visuals (shields, channel auras, projectile trails you drive yourself),
**store the index** and call `DestroyParticle(idx, bImmediate)` when the effect should
end. `bImmediate=false` lets the system finish gracefully; `true` cuts it instantly.

```lua
-- Horde Mode, aphotic_shield.lua
-- Note: a 0.01s timer lets the PREVIOUS shield particle die before recreating,
-- otherwise you double up and leak the old one.
Timers:CreateTimer(0.01, function()
    target.ShieldParticle = ParticleManager:CreateParticle(
        "particles/units/heroes/hero_abaddon/abaddon_aphotic_shield.vpcf",
        PATTACH_ABSORIGIN_FOLLOW, target)
    -- Only PATTACH_POINT_FOLLOW + attach_hitloc gives the correct shield position
    ParticleManager:SetParticleControlEnt(target.ShieldParticle, 0, target,
        PATTACH_POINT_FOLLOW, "attach_hitloc", target:GetAbsOrigin(), true)
end)

-- ...later, on the modifier's destroy hook:
function EndShieldParticle(event)
    local target = event.target
    target:EmitSound("Hero_Abaddon.AphoticShield.Destroy")   -- audio tied to visual end-state
    ParticleManager:DestroyParticle(target.ShieldParticle, false)
end
```

### Lifecycle C — let the modifier own it (`self:AddParticle`)

The cleanest option when the FX should live exactly as long as a modifier. Register the
index with `self:AddParticle(idx, bFollowOwner, bFollowEntity, iControlPoints, bDestroyImmediately, bStatusEffect)`
and the engine destroys it automatically when the modifier ends. No `DestroyParticle`
call, no field to track.

```lua
-- Guarding Athena, modifier_courier_fx_ambient_9.lua
-- Creating the FX inside IsClient() skips a server->client replication for purely visual loops.
if IsClient() then
    local fx = ParticleManager:CreateParticle(
        "particles/econ/courier/.../courier_golden_doomling_ambient.vpcf",
        PATTACH_ABSORIGIN, self:GetParent())
    ParticleManager:SetParticleControlEnt(fx, 0, self:GetParent(),
        PATTACH_POINT_FOLLOW, "attach_weapon", self:GetParent():GetAbsOrigin(), true)
    self:AddParticle(fx, true, false, -1, false, false)
end
```

Or skip the manual create entirely — declare the effect on the modifier and the engine
attaches/tears down for you (Angel Arena Reborn, `modifier_keymaster_damned_souls.lua`):

```lua
function mod:GetEffectName()       return "particles/econ/courier/courier_trail_orbit/courier_trail_orbit.vpcf" end
function mod:GetEffectAttachType() return PATTACH_ABSORIGIN_FOLLOW end
```

### Server-driven vs client-side particles

You can create particles from **server Lua** (`ParticleManager`) or from **Panorama/client
Lua** (`Particles` global). The trade-off:

- **Server `ParticleManager`**: authoritative, replicated to all relevant clients,
  respects fog/visibility. Use for gameplay FX. This is 95% of cases.
- **Client `Particles` (Panorama JS)**: not replicated — exists only on the local
  machine. Use for *purely cosmetic, local-only* HUD effects: cast-range rings, UI
  decorations, hover previews. Saves a replication and can't desync gameplay.

Guarding Athena draws its hover cast-range ring entirely client-side
(`panorama/scripts/custom_game/ability.js`):

```js
m_iCastRangeParticleID = Particles.CreateParticle(
    "particles/ui_mouseactions/range_display.vpcf",
    ParticleAttachment_t.PATTACH_CUSTOMORIGIN, -1);
Particles.SetParticleControlEnt(m_iCastRangeParticleID, 0, m_iEntityIndex,
    ParticleAttachment_t.PATTACH_ABSORIGIN_FOLLOW, undefined,
    Entities.GetAbsOrigin(m_iEntityIndex), true);
Particles.SetParticleControl(m_iCastRangeParticleID, 1, [fCastRange, 0, 0]);
// Client particles also leak — destroy on mouse-out:
Particles.DestroyParticleEffect(m_iCastRangeParticleID, true);
Particles.ReleaseParticleIndex(m_iCastRangeParticleID);
```

For static tooltip art that's really a particle scene, Panorama exposes
`<DOTAParticleScenePanel>` (used by Guarding Athena's Aghanim status tooltips):

```xml
<DOTAParticleScenePanel particleName="particles/.../status_fx.vpcf"
    particleonly="true" cameraOrigin="0 0 0" lookAt="0 0 0" fov="60" hittest="false" />
```

### Per-team visibility (`CreateParticleForTeam`)

Some FX must only be seen by one team — gold/lumber pickups, allied-only telegraphs,
hidden-info effects. `CreateParticleForTeam(sName, iAttach, hParent, iTeam)` does exactly
this. The DotaCraft popups library (reused by Horde Mode and others) routes team-scoped
numbers through it while everything else uses plain `CreateParticle`:

```lua
-- popups.lua
if pfx == "gold" or pfx == "lumber" then
    pidx = ParticleManager:CreateParticleForTeam(pfxPath, PATTACH_ABSORIGIN_FOLLOW, target, target:GetTeamNumber())
else
    pidx = ParticleManager:CreateParticle(pfxPath, PATTACH_ABSORIGIN_FOLLOW, target)
end
```

### Precaching (or your FX silently won't play)

A particle that isn't precached may fail to appear (or hitch the first time it plays).
Precache in `addon_game_mode.lua`'s `Precache(context)`. Precaching a parent system
*usually* pulls in its children, but that's "likely, not guaranteed" per Valve's own
barebones comment — precache the whole folder when in doubt.

```lua
-- addon_game_mode.lua (Horde Mode)
function Precache(context)
    PrecacheResource("particle",        "particles/foo/bar.vpcf", context)  -- one system
    PrecacheResource("particle_folder", "particles/frostivus_gameplay", context)  -- whole folder
    PrecacheResource("soundfile",       "soundevents/game_sounds_heroes/game_sounds_gyrocopter.vsndevts", context)
    PrecacheItemByNameSync("item_resonant_shard", context)  -- pulls an item's whole asset set
    -- PrecacheUnitByNameSync("npc_dota_hero_enigma", context)  -- a hero's full FX/sound/model set
end
```

Heroes selected at pick time precache their own assets automatically. The `Precache`
block is for assets you spawn dynamically (boss FX, summoned units, custom projectiles)
that no hero pulls in for you.

### Driving custom projectiles by hand

Guarding Athena's projectile system creates its own `.vpcf` with `PATTACH_CUSTOMORIGIN`
(no parent), then drives CP0 (position) and CP1 (velocity) every `FrameTime`, plus
`SetParticleControlForward` so the FX faces travel direction. The index lives in the
projectile's info table so it can be destroyed on hit/expire.

```lua
local iParticleID = ParticleManager:CreateParticle(tInfo.sEffectName, PATTACH_CUSTOMORIGIN, nil)
ParticleManager:SetParticleControlForward(iParticleID, 0, tInfo.vVelocity:Normalized())
ParticleManager:SetParticleControl(iParticleID, 0, tInfo.vSpawnOrigin)
ParticleManager:SetParticleControl(iParticleID, 1, tInfo.vVelocity)
tInfo.iParticleID = iParticleID
-- on hit/expire:  ParticleManager:DestroyParticle(tInfo.iParticleID, false)
```

Tracking projectiles instead bind CP1 to the target's bone so the trail homes visually:

```lua
ParticleManager:SetParticleControlEnt(iParticleID, 1, hTarget,
    PATTACH_POINT_FOLLOW, "attach_hitloc", hTarget:GetAbsOrigin(), true)
```

> Shipped-game note from that file's header: when a projectile *bounces* it recreates the
> FX, causing a one-frame disappear and a reset trail. Reusing the same index across
> bounces avoids the pop — a real polish gotcha.

### Encoding data into control points (radius, color, numbers)

Particles read gameplay values straight out of CPs. Two recurring idioms:

**Radius in a CP** so the `.vpcf` scales to the real AOE (Angel Arena Reborn firestorm;
Guarding Athena epicenter pulses this every tick so the shockwave *grows* to hit-radius):

```lua
ParticleManager:SetParticleControl(part, 1, Vector(radius, 1, 1))
-- or, pulsed each tick to telegraph a growing danger zone:
ParticleManager:SetParticleControl(iParticleID, 1, Vector(self.radius, self.radius, self.radius))
```

**Whole numbers via `msg_fx`** — see Floating Damage Numbers below.

---

## 2. Sound

### The verbs

| Call | Scope |
|---|---|
| `unit:EmitSound("Event")` / `EmitSoundOn("Event", hEnt)` | Plays *on a unit*, follows it, spatialized. |
| `unit:StopSound("Event")` / `StopSoundOn("Event", hEnt)` | Stops a looping/long sound on that unit. |
| `EmitSoundOnLocationWithCaster(vLoc, "Event", hCaster)` | Plays at a **world point**, attributed to caster (correct stereo/ownership). |
| `EmitSoundOnLocationForAllies(vLoc, "Event", hCaster)` | Positional, **allied team only**. |
| `EmitGlobalSound("Event")` | Non-positional, **everyone hears it** (announcer beats, wave cues). |
| `StopSoundEvent("Event", hEnt)` | Stop a named soundevent globally / on an entity. |
| `Game.EmitSound("ui_event")` | **Panorama (client)** UI feedback. |

### Caster-anchored vs positional

Anchor on the **caster** for casts that should sound like they came from the hero; use
**location** for delayed/landing AOE so the sound plays at impact, not where it was cast.
Many spells emit **both** ends — one on the caster, one on the target:

```lua
-- Horde Mode, brain_sap_lua.lua
EmitSoundOn("Hero_Bane.BrainSap", caster)
EmitSoundOn("Hero_Bane.BrainSap.Target", target)
```

```lua
-- Dota IMBA / Angel Arena Reborn — landing AOE at the impact point, attributed to caster
EmitSoundOnLocationWithCaster(location, "Ability.Torrent", caster)
EmitSoundOnLocationWithCaster(caster:GetAbsOrigin(), "Hero_Winter_Wyvern.SplinterBlast.Cast", nil)
```

Guarding Athena's generic `LightningStrike` helper replays
`EmitSoundOnLocationWithCaster` at *each* chain hop so positional audio follows the bolt
across targets.

### Global beats (`EmitGlobalSound`)

For non-positional gameplay cues — "wave incoming", phase change, objective complete —
use `EmitGlobalSound`. Life In Arena / Guarding Athena's wave spawner fires one at the
start of each batch:

```lua
EmitGlobalSound("Tutorial.Quest.complete_01")  -- "a wave is coming" cue to all players
```

### Looping sounds: emit on create, STOP on destroy (the #1 audio leak)

A looping or channel soundevent that you start and never stop will play *forever*. The
universal fix is to mirror the sound's lifecycle to a modifier or entity: emit in
`OnCreated`, stop in `OnDestroy`. This is so consistent across IMBA, Horde Mode, and
Angel Arena Reborn that you should treat it as law.

```lua
-- Dota IMBA — every loop has a matching StopSound
caster:EmitSound("Hero_Alchemist.AcidSpray")
-- ...thinker dies:
caster:StopSound("Hero_Alchemist.AcidSpray")
```

```lua
-- Angel Arena Reborn, modifier_charon_collapse_in_caster.lua — the start/loop/stop triad
function mod:OnCreated()
    self:GetCaster():EmitSound(self.START_SOUND)
    self:GetCaster():EmitSound(self.LOOP_SOUND)
end
function mod:OnDestroy()
    StopSoundOn(self.LOOP_SOUND, self:GetCaster())
    self:GetCaster():EmitSound(self.END_SOUND)   -- one-shot tail
end
```

```lua
-- Horde Mode, death_ward.lua — stop the ambient the instant the unit is gone
UTIL_Remove(ward)
StopSoundEvent(keys.sound, caster)
```

Charge/release shaping (Guarding Athena Powershot): play a channel loop on
`OnAbilityPhaseStart`, `StopSound` it on `OnChannelFinish`, then fire the release sound
when the arrows actually launch.

### Custom soundevents (`.vsndevts`)

Two strategies, both shipped:

**(a) Reuse Valve's hero soundevents verbatim.** The cheapest path — map existing event
names onto your custom abilities. Guarding Athena reuses `ElderTitan.EarthSplitter`,
`SandKing_Epicenter`, `Tidehunter.AnchorSmash`, etc. Angel Arena Reborn just points each
unit's `GameSoundsFile` at a stock bank in `npc_units_custom.txt`:

```
"npc_dota_custom_unit"
{
    "GameSoundsFile"  "soundevents/game_sounds_heroes/game_sounds_dragon_knight.vsndevts"
    "VoiceFile"       "soundevents/voscripts/game_sounds_vo_dragon_knight.vsndevts"
}
```

**(b) Ship your own bank.** Author a `.vsndevts` (KV3), precache it in `Precache`, then
emit your custom event names. Dota IMBA ships `imba_soundevents.vsndevts` and references
events like `Imba.AbaddonHeyYou`, stopped via `StopSoundEvent("Imba.AbaddonHeyYou", parent)`.

```
// soundevents/custom_soundevents.vsndevts  (KV3)
"MyGame.BossRoar"
{
    "type"          "dota_update_default"
    "volume"        "1.0"
    "pitch"         "1.0"
    "vsnd_files"    [ "sounds/custom/boss_roar.vsnd" ]
}
```

```lua
-- precache the bank, then emit your event:
PrecacheResource("soundfile", "soundevents/custom_soundevents.vsndevts", context)
boss:EmitSound("MyGame.BossRoar")
```

### Crit/state sound branching

Two ways to make state audible. Branch by outcome at the call site (Angel Arena Reborn
Keymaster Bite: a `Cast` sound every hit, a distinct `Kill` sound only on execute). Or
hook the engine's attack-sound translation so crits get their own impact through the
normal attack pipeline (Guarding Athena):

```lua
-- modifier_common.lua
function modifier_common:DeclareFunctions()
    return { MODIFIER_PROPERTY_TRANSLATE_ATTACK_SOUND }
end
function modifier_common:GetAttackSound()
    if self.bPhysicalCrit then return "MyGame.CritImpact" end
end
```

### Panorama UI sounds

Two routes from the client. **JS** for event-driven feedback:

```js
// Dota IMBA combat_events.js — personalized to the local player
if (isKiller)      Game.EmitSound('notification.self.kill');
else if (isVictim) Game.EmitSound('notification.self.death');
// Angel Arena Reborn — on a state change
Game.EmitSound('ui_select_md');
// Dota IMBA — dynamic event name for an announcer countdown
Game.EmitSound('announcer_ann_custom_countdown_' + data['time']);
```

**CSS** for pure interaction states — no JS wiring needed (Horde Mode team_select.css):

```css
.TeamSelectButton:hover  { sound: "ui_rollover_micro"; }
.TeamSelectButton:active { sound: "ui_team_select_lock_and_start"; }
```

---

## 3. Game Feel

Game feel is the layer that makes a hit *land*. None of it changes the math; all of it
changes the experience. Layer several of these on your biggest moments.

### Screen shake (`ScreenShake`)

```lua
-- ScreenShake(vCenter, flAmplitude, flFrequency, flDuration, flRadius, iCommand, bAirShake)
-- Dota IMBA — reserved for the single biggest burst-damage moment (empowered Mana Void)
ScreenShake(target:GetOrigin(), 10, 0.1, 1, 500, 0, true)
```

`vCenter` + `flRadius` mean shake falls off with distance — players near the impact feel
it most. **Use it sparingly.** IMBA fires exactly one `ScreenShake` in its entire ability
set; over-shaking turns a punch into nausea and devalues every other hit.

> Several shipped games (Angel Arena Reborn, Charon's vanish) deliberately *avoid*
> `ScreenShake` and instead sell impact with particles, motion, and hidden-caster beats —
> screen shake is one tool, not the only one.

### Camera control (`SetCameraTarget`)

Snap the player camera to a unit, release with `nil`. The building block for any
cinematic focus, intro, or death-cam. (Guarding Athena uses it for debug focus and unit
control; the API is identical for cutscenes.)

```lua
PlayerResource:SetCameraTarget(playerID, hUnit)  -- lock
-- ...later:
PlayerResource:SetCameraTarget(playerID, nil)    -- release back to player control
```

Mode-wide zoom for arena/horde games (Horde Mode `gamemode.lua`):

```lua
GameRules:GetGameModeEntity():SetCameraDistanceOverride(CAMERA_DISTANCE_OVERRIDE)
```

### Hit-stop / time-scale

True hit-stop (freeze the world for a few frames on a heavy hit) is done by scaling time
and restoring it on a timer:

```lua
-- crunchy hit-stop on a finisher
GameRules:SetTimeScale(0.15)            -- near-freeze
Timers:CreateTimer(0.06, function()     -- ~60ms of real time
    GameRules:SetTimeScale(1.0)
end)
```

> Caveat: `SetTimeScale` is **global** — it affects every unit, projectile, and timer,
> not just the attacker. None of the surveyed games use literal hit-stop. Instead they
> simulate "weight" with a *damage-gated phase shield*: Guarding Athena's boss becomes
> briefly near-immune when it crosses an HP threshold, decaying back to normal — a
> readable beat that doesn't touch the global clock:

```lua
function modifier_boss_buff:GetModifierIncomingDamage_Percentage(params)
    return RemapVal(self:GetElapsedTime(), 0, self:GetDuration(), -self.damage_reduce, 0)
end
```

### Knockback & motion

Motion is the cheapest, highest-impact juice. Three approaches, easy to hard:

**(a) Engine knockback** — built-in, instant (Guarding Athena):

```lua
-- KnockBack(vDirection, flDistance, flHeight, flDuration)
hTarget:KnockBack((hTarget:GetAbsOrigin() - vStart):Normalized(), flDistance, 0, 0.3)
-- on death, scatter summoned children outward so a popped unit bursts apart:
hUnit:KnockBack(RandomVector(1), 300, 200, 1)
```

**(b) Reusable knockback modifier** (Dota IMBA). Spawn a dummy as the push anchor so the
direction aims outward; `RemoveModifierByName` first to avoid stacking glitches:

```lua
local p = { should_stun = 1, duration = force_duration, knockback_duration = force_duration,
            knockback_distance = force_distance, knockback_height = 0,
            center_x = loc.x, center_y = loc.y, center_z = loc.z }
enemy:RemoveModifierByName("modifier_knockback")
enemy:AddNewModifier(caster, self, "modifier_knockback", p)
```

**(c) Hand-rolled motion controller** for full control (Angel Arena Reborn, Horde Mode
Life Break leap). Apply a horizontal/vertical controller and nudge `SetAbsOrigin` each
tick; always release with `InterruptMotionControllers`:

```lua
self.dir  = (self.target:GetAbsOrigin() - self.point):Normalized()
self.step = self.radius / self.duration
self:ApplyHorizontalMotionController()
-- per tick (UpdateHorizontalMotion):
local origin = self:GetParent():GetAbsOrigin()
self:GetParent():SetAbsOrigin(origin + self.dir * (self.step * dt))
-- on interrupt/destroy:
self:GetParent():InterruptMotionControllers(true)
```

Polish: clear trees and de-overlap after a displacement so units never end up stuck:

```lua
GridNav:DestroyTreesAroundPoint(point, radius, true)
FindClearSpaceForUnit(caster, targetPos, true)   -- also makes blink/swaps read as solid
```

### Floating damage numbers

Two completely different mechanisms — know both.

**(a) Engine overhead alerts** — zero assets, the quick path (Dota IMBA, Angel Arena
Reborn). `nil` as the player makes it visible to everyone:

```lua
SendOverheadEventMessage(nil, OVERHEAD_ALERT_BONUS_SPELL_DAMAGE, enemy, damage, nil)
SendOverheadEventMessage(nil, OVERHEAD_ALERT_MANA_LOSS, target, mana_burn, nil)
SendOverheadEventMessage(unit, OVERHEAD_ALERT_HEAL, unit, amount, nil)
```

**(b) `msg_fx` particles** — fully custom color/symbol/style, the "Valor message FX"
trick. The number, digit count, lifetime, and color are *packed into control points*.
This is what powers the DotaCraft popups library and Guarding Athena's crit numbers.

```lua
-- popups.lua — the generic builder
local pidx = ParticleManager:CreateParticle("particles/msg_fx/msg_crit.vpcf",
    PATTACH_ABSORIGIN_FOLLOW, target)
ParticleManager:SetParticleControl(pidx, 1, Vector(presymbol, number, postsymbol))
ParticleManager:SetParticleControl(pidx, 2, Vector(lifetime, digits, 0))
ParticleManager:SetParticleControl(pidx, 3, color)   -- RGB as a Vector
ParticleManager:ReleaseParticleIndex(pidx)
```

```lua
-- Guarding Athena crit numbers — cyan for magical crit, red for physical
local vColor = bMagicalCrit and Vector(0, 191, 255) or Vector(255, 32, 32)
local fx = ParticleManager:CreateParticle("particles/msg_fx/msg_crit.vpcf", PATTACH_CUSTOMORIGIN, nil)
ParticleManager:SetParticleControlEnt(fx, 0, hTarget, PATTACH_OVERHEAD_FOLLOW, nil, hTarget:GetAbsOrigin(), true)
ParticleManager:SetParticleControl(fx, 1, Vector(0, iNumber, bMagicalCrit and 6 or 4))  -- digit style
ParticleManager:SetParticleControl(fx, 2, Vector(fDuration, #sNumber + 1, 0))
ParticleManager:SetParticleControl(fx, 3, vColor)
ParticleManager:ReleaseParticleIndex(fx)
```

Typed helpers give every event a recognizable identity (Horde Mode / DotaCraft):

```lua
function PopupCriticalDamage(target, amount)
    PopupNumbers(target, "crit", Vector(255, 0, 0), 3.0, amount, nil, POPUP_SYMBOL_POST_LIGHTNING)
end
function PopupHealing(target, amount)
    PopupNumbers(target, "heal", Vector(0, 255, 0), 3.0, amount, POPUP_SYMBOL_PRE_PLUS, nil)
end
function PopupGoldGain(target, amount)  -- team-only via CreateParticleForTeam internally
    PopupNumbers(target, "gold", Vector(255, 200, 33), 2.0, amount, POPUP_SYMBOL_PRE_PLUS, nil)
end
```

### Full-screen banners, flash & vignette

Screen-space FX use `PATTACH_EYES_FOLLOW` so they lock to the player's view. Horde Mode
fires econ kill banners for streaks:

```lua
-- names: firstblood, doublekill, triplekill, rampage, multikill_generic
local particleName = "particles/econ/events/killbanners/screen_killbanner_compendium14_"..name..".vpcf"
ParticleManager:CreateParticle(particleName, PATTACH_EYES_FOLLOW, target)
```

The same attach point drives a low-HP vignette or hit-flash — a screen-space `.vpcf` on
`PATTACH_EYES_FOLLOW`, created when HP drops below a threshold and `DestroyParticle`'d
when it recovers (treat it as Lifecycle B — it's persistent, so store and destroy).

For HUD flashes you'd rather do in Panorama, drive a CSS animation from a custom net
event:

```css
/* screen flash overlay */
.HitFlash { opacity: 0.0; background-color: #ff3030; transition: opacity 0.08s ease-out; }
.HitFlash.Active { opacity: 0.35; }
```

```js
GameEvents.Subscribe("player_took_big_hit", function () {
    var p = $("#HitFlash");
    p.AddClass("Active");
    $.Schedule(0.08, function () { p.RemoveClass("Active"); });
});
```

Couple the *visual* emphasis to whether the moment matters to **you** (Dota IMBA kill
feed): toggle CSS role classes and fire the matching sound so the local player's own
kills/deaths pop harder than distant ones.

```js
row.SetHasClass('LocalPlayerKiller', isKiller);
row.SetHasClass('LocalPlayerVictim', isVictim);
```

### Telegraphing & charge/release shaping

Feel isn't only the impact — it's the *anticipation*. Two shipped techniques:

**Cast gestures + growing AOE pulse** so the danger zone is readable (Guarding Athena
boss epicenter):

```lua
hCaster:StartGesture(ACT_DOTA_CAST_ABILITY_4)
-- each tick, scale the shockwave to the real radius:
ParticleManager:SetParticleControl(iParticleID, 1, Vector(self.radius, self.radius, self.radius))
```

**Charge-and-release `RemapVal` shaping** — the longer you hold, the tighter and harder
the shot, with a release gesture + sound. Weighty and skill-expressive (Guarding Athena
Powershot):

```lua
local flDistance = RemapVal(flChannelTime, 0, self:GetChannelTime(), 0, bonus_range) + base_range
local flAngle    = RemapVal(flChannelTime, 0, self:GetChannelTime(), 15, 5)  -- fan tightens
hCaster:StartGesture(ACT_DOTA_OVERRIDE_ABILITY_2)
```

### Organic, layered effects

One sterile particle reads as "an effect"; many staggered ones read as a *force of
nature*. Dota IMBA's Torrent floods a radius with polar mini-splashes at randomized
delays instead of a single ring:

```lua
local count_mini = math.floor(radius / 35)
for i = 0, count_mini, 1 do
    Timers:CreateTimer(math.random(80) * 0.01, function()
        local angle = (360 / count_mini) * i
        local mini_target = target + Vector(math.cos(angle) * border, math.sin(angle) * border, 0)
        -- CreateParticle at mini_target ... ReleaseParticleIndex
    end)
end
```

---

## Pitfalls

- **Particle index leaks.** A held index whose system never gets `ReleaseParticleIndex`
  or `DestroyParticle` leaks for the whole match. Default to fire-and-forget
  (`ReleaseParticleIndex` the same frame); only store indexes for FX you must stop early,
  and always destroy those in the matching `OnDestroy`/end hook. Prefer `self:AddParticle`
  so the engine cleans up for you.
- **Recreating a persistent particle without destroying the old one.** Each call returns
  a new index; overwriting `target.ShieldParticle` orphans the previous system. Destroy
  first, or wait a frame (the `Timers:CreateTimer(0.01, ...)` trick) so the old one dies
  before you recreate.
- **Forgetting to precache.** Dynamically spawned particles/sounds/units that no picked
  hero pulls in must be precached in `Precache(context)`, or they silently fail or hitch.
  Precaching a parent system *usually* but not *certainly* precaches children — precache
  the folder when unsure.
- **Orphaned looping sounds.** Every `EmitSound` of a looping/channel event needs a
  matching `StopSound`/`StopSoundOn`/`StopSoundEvent`. Mirror the sound to a modifier
  lifecycle: emit in `OnCreated`, stop in `OnDestroy`. An un-stopped loop plays forever.
- **Over-emitting sounds.** Per-tick or per-pellet `EmitSound` (DOTs, multishot, AOE
  ticks) stacks into an audio mush and can clip the mixer. Emit once on cast, gate ticks,
  or use a single positional `EmitSoundOnLocationWithCaster` at the impact point.
- **Team visibility mistakes.** Plain `CreateParticle` is visible to whoever can see the
  unit; it does *not* hide info-sensitive FX. Use `CreateParticleForTeam` for gold/lumber
  and allied-only telegraphs, and `EmitSoundOnLocationForAllies` for one-team audio.
  Conversely, passing a real player to `SendOverheadEventMessage` hides the number from
  everyone else — pass `nil` if you want it global.
- **Wrong attach point.** `PATTACH_ABSORIGIN_FOLLOW` sits at the feet; shields, weapon
  trails, and hit beams need `PATTACH_POINT_FOLLOW` + a named attachment
  (`attach_hitloc`, `attach_weapon`). Screen-space FX (banners, vignette, flash) need
  `PATTACH_EYES_FOLLOW`, not a world attach.
- **Over-shaking / global time-scale.** `ScreenShake` on every hit causes nausea and
  devalues your big moments — reserve it for the heaviest beat (IMBA uses it exactly
  once). `SetTimeScale` for hit-stop is global: it slows every unit, projectile, and
  timer, not just the attacker. Restore it on a real-time timer and test it doesn't
  desync gameplay; consider a phase-shield damage ramp instead.
- **Server vs client particle confusion.** Client `Particles` (Panorama) FX are
  local-only and not replicated — never use them for gameplay-relevant visuals other
  players must see. They still leak: `DestroyParticleEffect` + `ReleaseParticleIndex` on
  mouse-out. Conversely, creating a purely cosmetic loop on the server wastes a
  replication — guard it with `IsClient()` like Guarding Athena's courier FX.
- **Motion controllers left running.** A horizontal/vertical motion controller that isn't
  ended with `InterruptMotionControllers` leaves the unit drifting or stuck. Release it in
  `OnHorizontalMotionInterrupted`/`OnDestroy`, and `FindClearSpaceForUnit` after a
  displacement so units don't end up inside terrain.
