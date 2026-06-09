# AI & Combat Patterns

Server-side AI and combat for Dota 2 custom games, distilled from shipping Workshop games (Guarding Athena `530286038`, Dota IMBA `440115357`, Horde Mode `472597026`, Angel Arena Reborn `500020226`, Life In Arena `407750024`). Everything here runs in VScript (Lua) on the **server**. The cardinal rule: gameplay, FindUnitsInRadius, projectiles, damage, and orders all execute inside `if IsServer() then ... end`. Panorama is HUD-only feedback.

> Engine reference: `FindUnitsInRadius(team, vPos, hCacheUnit, flRadius, iTargetTeam, iTargetType, iTargetFlags, iOrder, bCache)`. The first `team` arg is the *searcher's* team (used to resolve `DOTA_UNIT_TARGET_TEAM_ENEMY/FRIENDLY`); `iTargetTeam`/`iTargetType`/`iTargetFlags` are bitmasks.

---

## 1. Think loops: how AI gets a heartbeat

There are three idiomatic ways to give a unit/ability a recurring tick. Pick by ownership and reload-safety.

### `SetContextThink` / `SetThink` — entity-scoped, returns next interval

Horde Mode's map boss (`scripts/vscripts/friendai.lua`) drives a utility brain with `SetContextThink`. Return the next delay (seconds), or `nil` to stop.

```lua
-- Horde Mode: friendai.lua — boss "push the Ancient" controller
function SpawnBossAI(unit)
    unit.behaviorSystem = AICore:CreateBehaviorSystem({ BehaviorAttackAncient, BehaviorAttackEnemies })
    unit:SetContextThink("AIThink", function()
        if not IsValid(unit) or not unit:IsAlive() then
            return nil          -- self-deactivate: dead unit must stop thinking
        end
        return unit.behaviorSystem:Think()   -- Think() returns its own next interval
    end, 0.25)
end
```

### Modifier `StartIntervalThink` — auto-cleaned with the unit/modifier

The most robust pattern for combat: the think dies automatically when the modifier (or its parent) is removed, so you never leak a loop pointing at a dead handle. Used by Guarding Athena's `boss_epicenter`, Horde Mode's spark wraith, and Angel Arena's Damned Souls.

```lua
function modifier_boss_epicenter:OnCreated()
    if not IsServer() then return end
    self.radius = self:GetAbility():GetSpecialValueFor("radius")
    self:StartIntervalThink(0.5)            -- pulse cadence
end

function modifier_boss_epicenter:OnIntervalThink()
    local caster = self:GetCaster()
    local pos    = self:GetParent():GetAbsOrigin()
    local hits = FindUnitsInRadius(caster:GetTeamNumber(), pos, nil, self.radius,
        DOTA_UNIT_TARGET_TEAM_ENEMY, DOTA_UNIT_TARGET_HERO + DOTA_UNIT_TARGET_BASIC,
        DOTA_UNIT_TARGET_FLAG_NONE, FIND_ANY_ORDER, false)
    for _, h in pairs(hits) do
        self:GetAbility():DealDamage(caster, h, self.tick_damage)
    end
    -- redraw shockwave sized to the live radius (telegraph)
    local fx = ParticleManager:CreateParticle("particles/.../sandking_epicenter.vpcf", PATTACH_WORLDORIGIN, nil)
    ParticleManager:SetParticleControl(fx, 0, pos)
    ParticleManager:SetParticleControl(fx, 1, Vector(self.radius, self.radius, self.radius))
    ParticleManager:ReleaseParticleIndex(fx)
end
```

`StartIntervalThink(0)` = "every server frame" (~0.03s). `StartIntervalThink(-1)` = stop. Re-call with a new value to retune; the spark wraith below uses this to switch phases.

### `AddNewModifier` thinker — a free-floating ticker not bound to a real unit

When you need a think loop at a *world point* with no owning unit (mines, ground hazards, projectile managers), spawn a thinker entity. Horde Mode's Spark Wraith and Guarding Athena's projectile system both use this.

```lua
-- Horde Mode: arc_warden_spark_wraith_lua.lua
CreateModifierThinker(caster, ability, "arc_warden_spark_wraith_thinker", {}, point, team_id, false)
```

The thinker's modifier then runs a small **state machine** in `OnIntervalThink` — startup -> armed -> fire -> self-destroy:

```lua
function arc_warden_spark_wraith_thinker:OnIntervalThink()
    local thinker = self:GetParent()
    if self.startup_time ~= nil then                 -- phase 1: arming
        ParticleManager:DestroyParticle(self.startup_particle, false)
        self.startup_time = nil
        self.particle = ParticleManager:CreateParticle("particles/.../buff_sphere.vpcf", PATTACH_WORLDORIGIN, thinker)
        self.expire = GameRules:GetGameTime() + self.duration
        self:StartIntervalThink(0)                    -- poll every frame
    elseif self.duration ~= nil then                 -- phase 2: hunting
        if GameRules:GetGameTime() > self.expire then self:Destroy() return end
        local enemies = FindUnitsInRadius(thinker:GetTeamNumber(), thinker:GetAbsOrigin(), nil,
            self.search_radius, DOTA_UNIT_TARGET_TEAM_ENEMY,
            DOTA_UNIT_TARGET_CREEP + DOTA_UNIT_TARGET_HERO,
            DOTA_UNIT_TARGET_FLAG_NOT_MAGIC_IMMUNE_ALLIES, FIND_CLOSEST, false)
        if enemies[1] then
            self:StartIntervalThink(-1)               -- stop polling, fire once
            ProjectileManager:CreateTrackingProjectile({ Target = enemies[1], Source = thinker, --[[...]] })
            ParticleManager:DestroyParticle(self.particle, false)
        end
    end
end
```

---

## 2. Aggro & targeting

### The core decision: gated `FindUnitsInRadius`

Almost every combat AI reduces to: search a radius, filter by team/type/flags, sort or score, act. Dota IMBA's tower AI gates the cast on a *count threshold* (`tower_abilities.lua`):

```lua
-- Dota IMBA: only fire tower nuke if enough creeps OR a hero is present
local creeps = FindUnitsInRadius(team, loc, nil, radius, DOTA_UNIT_TARGET_TEAM_ENEMY,
    DOTA_UNIT_TARGET_BASIC, DOTA_UNIT_TARGET_FLAG_NONE, FIND_ANY_ORDER, false)
local heroes = FindUnitsInRadius(team, loc, nil, radius, DOTA_UNIT_TARGET_TEAM_ENEMY,
    DOTA_UNIT_TARGET_HERO, DOTA_UNIT_TARGET_FLAG_NONE, FIND_ANY_ORDER, false)
if #creeps >= min_creeps or #heroes >= 1 then
    self:GetCaster():EmitSound("Tower.Cast")
    for _, e in pairs(creeps) do ApplyEffect(e) end
    self:StartCooldown(self:GetCooldown(-1))
end
```

### Fair targeting: a `_CanBeSeen` validator

Angel Arena Reborn's Abyss Warrior (`abyss_warrior_ai.lua`) refuses to cast through fog, on invis, on invulnerable units, or on couriers — so bosses behave fairly and never waste cooldowns. Bake the flags into the search *and* re-validate per candidate.

```lua
-- Angel Arena Reborn: abyss_warrior_ai.lua
local ENEMY_SEARCHING = 820
function _GetEnemiesNear(pos, teamNumber)
    return FindUnitsInRadius(teamNumber, pos, nil, ENEMY_SEARCHING,
        DOTA_UNIT_TARGET_TEAM_ENEMY, DOTA_UNIT_TARGET_ALL,
        DOTA_UNIT_TARGET_FLAG_MAGIC_IMMUNE_ENEMIES + DOTA_UNIT_TARGET_FLAG_NO_INVIS,
        FIND_ANY_ORDER, false)
end

function _CanBeSeen(unit, target)
    return unit:CanEntityBeSeenByMyTeam(target)
       and not target:IsInvisible()
       and not target:IsInvulnerable()
       and not target:IsCourier()
end
```

### Threat / priority scoring

The Abyss Warrior's tick is a textbook priority controller: one pass over candidates computes *nearest target*, *lowest-HP target in cast range*, and *clustered target* (2+ enemies within link radius) simultaneously, then casts in a fixed priority order.

```lua
-- Angel Arena Reborn: condensed from abyss_warrior_ai.lua:OnTick
local nearest, nearestDist = nil, ENEMY_SEARCHING + 100
local lowHpTarget, lowHp = nil, nil
local clusterTarget = nil

for _, e in pairs(_GetEnemiesNear(spawnPos, unit:GetTeamNumber())) do
    if _CanBeSeen(unit, e) then
        local d = (e:GetAbsOrigin() - pos):Length()
        if d < nearestDist then nearest, nearestDist = e, d end

        if wantDomination and d < domnationRange then
            local hp = e:GetHealthPercent() / 100
            if not lowHpTarget or hp < lowHp then lowHpTarget, lowHp = e, hp end
        end

        if wantDeathLink then                       -- find a clustered pair
            for _, o in pairs(enemies) do
                if e ~= o and (o:GetAbsOrigin() - e:GetAbsOrigin()):Length() < deathLinkAoe then
                    clusterTarget = e; break
                end
            end
        end
    end
end

-- Priority cast order; bail after each so we don't double-issue this tick
if clusterTarget then unit:Stop(); unit:CastAbilityOnTarget(clusterTarget, abilityDeathLink, -1); return true end
if lowHpTarget  then unit:Stop(); unit:CastAbilityOnTarget(lowHpTarget,  abilityDomnation, -1); return true end
if unit:GetHealthPercent()/100 < 0.7 then unit:Stop(); unit:CastAbilityNoTarget(abilityEthernal, -1); return true end
if nearest and nearest ~= unit:GetAttackTarget() then unit:Stop(); unit:MoveToTargetToAttack(nearest) end
```

Always guard against re-issuing while a cast is mid-flight: `if ability:IsInAbilityPhase() then return true end`.

### Generic auto-cast framework (data-driven)

Guarding Athena's `ability_base_ai.lua` is a base class every enemy/boss ability inherits. On `Spawn` it reads the ability's KV behavior (`NO_TARGET` / `POINT` / `UNIT_TARGET`) and starts a timer that, when the ability is ready, searches cast range using the ability's own target team/type/flags, optionally sorts with `funcSortFunction` or filters with `funcCondition`, then issues the order via `ExecuteOrder`.

```lua
-- Guarding Athena: ability_base_ai.lua — unit-target branch (condensed)
self:GameTimer(0, function()
    if self:IsAbilityReady() and (not self.funcCondition or self.funcCondition(self)) then
        local range = self:GetCastRange(vec3_invalid, nil)
        local targets = FindUnitsInRadius(hCaster:GetTeamNumber(), hCaster:GetAbsOrigin(), nil,
            range, self.iTargetTeam, self.iTargetType, self.iTargetFlags, self.iOrderType, false)
        if self.funcSortFunction then table.sort(targets, self.funcSortFunction) end  -- e.g. lowest mana/HP
        if IsValid(targets[1]) then self:CastAbilityOnTarget(targets[1]) end
    end
    return AI_TIMER_TICK_TIME
end)
```

Smart point placement: instead of targeting a unit, ask the engine where the most enemies overlap — `GetAOEMostTargetsPosition(...)` for circular AOE, `GetLinearMostTargetsPosition(...)` for skillshots. Casting helpers wrap `ExecuteOrder`:

```lua
function ability_base_ai:CastAbilityOnTarget(t)   ExecuteOrder(self:GetCaster(), DOTA_UNIT_ORDER_CAST_TARGET, self, t)   end
function ability_base_ai:CastAbilityOnPosition(p) ExecuteOrder(self:GetCaster(), DOTA_UNIT_ORDER_CAST_POSITION, self, p) end
function ability_base_ai:CastAbilityNoTarget()    ExecuteOrder(self:GetCaster(), DOTA_UNIT_ORDER_CAST_NO_TARGET, self)    end
```

### Utility/desire system (highest-score-wins)

Horde Mode's `AICore:CreateBehaviorSystem` (`ai_core.lua`) is the reusable brain: each tick `Evaluate()` every behavior, pick the max desire, and run `Begin/Continue/End/Think`. Orders are **re-issued every think** (`repeatedlyIssueOrders`) so dropped orders self-heal.

```lua
-- Horde Mode: ai_core.lua (condensed Think)
function BehaviorSystem:ChooseNextBehavior()
    local best, bestDesire = nil, nil
    for _, b in pairs(self.possibleBehaviors) do
        local d = b:Evaluate()
        if not bestDesire or d > bestDesire then best, bestDesire = b, d end
    end
    return best
end

-- A behavior raises its desire when the situation calls for it:
function BehaviorAttackAncient:Evaluate()
    local allies = FindUnitsInRadius(self.unit:GetTeamNumber(), self.unit:GetOrigin(), nil,
        -1, DOTA_UNIT_TARGET_TEAM_FRIENDLY, DOTA_UNIT_TARGET_CREEP, 0, FIND_ANY_ORDER, false)
    return (#allies < 3) and 3 or 0     -- radius -1 = whole map
end
```

---

## 3. Creep movement & kiting

Wave creeps are given a goal and pushed toward the base; the engine handles pathing. Guarding Athena's spawner (`scripts/vscripts/class/spawner.lua`) tags each spawn:

```lua
-- Guarding Athena: per-spawn lane assignment
unit:SetGoalEntity(spawner)            -- or unit:SetInitialGoalEntity / MoveToPosition(lane_waypoint)
unit.iDefendingTeamNumber = iTeam      -- custom field that drives lane pathing
```

**Kiting / focus-fire reward** (Dota IMBA `concentrated_momentum.lua`): a tower that keeps attacking the *same* target ramps attack speed; switching resets it. This encodes "lock on" behavior with stateful per-target tracking.

```lua
function modifier_concentrated_momentum:OnAttackStart(p)
    if not IsServer() or p.attacker ~= self:GetParent() then return end
    if p.target == self.last_target then
        self:IncrementStackCount()                  -- engine clamps via GetModifierStackCountMax-style logic
        if self:GetStackCount() > self.max_stacks then self:SetStackCount(self.max_stacks) end
    else
        self.last_target = p.target
        self:SetStackCount(1)
    end
end
function modifier_concentrated_momentum:GetModifierAttackSpeedBonus_Constant()
    return self.bonus_as * self:GetStackCount()
end
```

**Leash-on-stray** keeps creeps/bosses from being pulled off the map (Abyss Warrior): if it strays past `BACK_TO_SPAWN_RANGE`, `Stop()` and `MoveToPosition(spawnPos)`.

```lua
if (pos - self.spawnPos):Length() > BACK_TO_SPAWN_RANGE then
    unit:Stop(); unit:MoveToPosition(self.spawnPos); return true
end
```

**Knockback / displacement** for hit-react is either the engine helper or a hand-rolled motion controller. Guarding Athena uses `KnockBack` directly; Angel Arena Reborn rolls its own horizontal controller for custom curves.

```lua
-- Guarding Athena: Powershot push + on-death scatter
hTarget:KnockBack((hTarget:GetAbsOrigin() - vStart):Normalized(), distance, 0, 0.3)
hUnit:KnockBack(RandomVector(1), 300, 200, 1)   -- split-on-death children burst apart

-- Angel Arena Reborn: custom HorizontalMotionController (Soul Guardian)
function mod:OnCreated()
    self.step = self.radius / self.duration
    self.dir  = (self.target:GetAbsOrigin() - self.point):Normalized()
    self:ApplyHorizontalMotionController()
end
function mod:UpdateHorizontalMotion(me, dt)
    me:SetAbsOrigin(me:GetAbsOrigin() + self.dir * (self.step * dt))
end
function mod:OnHorizontalMotionInterrupted() self:Destroy() end
function mod:OnDestroy() if IsServer() then self:GetParent():InterruptMotionControllers(true) end end
```

After any forced displacement call `GridNav:DestroyTreesAroundPoint(point, radius, true)` (Angel Arena Harpy) so pushed units don't wedge in trees, and `FindClearSpaceForUnit` after teleport/swap so they don't stack.

---

## 4. Tower & boss AI with multi-phase logic

### Multishot / cleave tower (Dota IMBA `multishot.lua`)

React to `MODIFIER_EVENT_ON_ATTACK`, find nearest extra targets, and `PerformAttack` on them. Guard against recursion (passives disabled, no extra attacks triggering more events).

```lua
function modifier_imba_tower_multishot:OnAttack(p)
    if not IsServer() or p.attacker ~= self:GetParent() then return end
    if p.attacker:PassivesDisabled() then return end
    local extras = FindUnitsInRadius(p.attacker:GetTeamNumber(), p.attacker:GetAbsOrigin(), nil,
        p.attacker:Script_GetAttackRange(), DOTA_UNIT_TARGET_TEAM_ENEMY,
        DOTA_UNIT_TARGET_CREEP, DOTA_UNIT_TARGET_FLAG_NONE, FIND_CLOSEST, false)
    local fired = 0
    for _, e in pairs(extras) do
        if e ~= p.target and e:HasAttackCapability() and fired < self.arrow_count then
            -- PerformAttack(target, useCastAttackOrb, processProcs, skipCooldown, ignoreInvis, useProjectile, fakeAttack, neverMiss)
            p.attacker:PerformAttack(e, true, true, true, false, true, false, false)
            fired = fired + 1
        end
    end
end
```

### Damage-gated multi-phase boss (Guarding Athena `boss.lua`)

The cleanest "phase shield" in the corpus. The boss is clamped at HP thresholds via `MODIFIER_PROPERTY_MIN_HEALTH` so it cannot be burst past a phase; crossing a threshold grants a temporary, decaying incoming-damage reduction, then the threshold steps down.

```lua
-- Guarding Athena: boss.lua
function modifier_boss:OnCreated()
    self.damage_limit = self:GetAbilitySpecialValueFor("damage_limit")   -- % of max HP per phase
    if IsServer() then
        self.flHealth  = math.ceil(self:GetParent():GetCustomMaxHealth() * self.damage_limit * 0.01)
        self.threshold = self:GetParent():GetCustomMaxHealth() - self.flHealth
    end
    AddModifierEvents(MODIFIER_EVENT_ON_TAKEDAMAGE, self, nil, self:GetParent())
end

function modifier_boss:DeclareFunctions() return { MODIFIER_PROPERTY_MIN_HEALTH } end
function modifier_boss:GetMinHealth()
    if IsServer() and self.threshold > 0 then return self.threshold end  -- clamp: can't drop below the gate
end

function modifier_boss:OnTakeDamage(p)
    if p.unit == self:GetParent() and p.unit:GetHealth() == self.threshold then
        p.unit:AddNewModifier(p.unit, self:GetAbility(), "modifier_boss_buff",
            { duration = self:GetAbility():GetDuration() })       -- phase shield
        self:StartIntervalThink(0)                                -- step the gate down next frame
    end
end
function modifier_boss:OnIntervalThink()
    self.threshold = math.max(self.threshold - self.flHealth, 0)
end

-- The phase shield ramps from full reduction back to 0 over its duration:
function modifier_boss_buff:GetModifierIncomingDamage_Percentage()
    return RemapVal(self:GetElapsedTime(), 0, self:GetDuration(), -self.damage_reduce, 0)
end
```

The Captain variant adds elite presence (movespeed/attackspeed/crit + big `SetModelScale`). For a *behavior*-phased boss (different abilities per HP bracket), branch your think loop on `GetHealthPercent()` and swap which abilities you allow `IsAbilityReady` to fire.

### Telegraphed boss ground-AOE

`StartGesture(ACT_DOTA_CAST_ABILITY_4)` for the wind-up, then a `StartIntervalThink` pulse that re-finds units and grows the warning FX to the real hit radius (see §1 `boss_epicenter`). The telegraph is the FX `Vector(radius,radius,radius)` control point matching the actual `FindUnitsInRadius` radius.

### Split-on-death adds (Guarding Athena `alien_split.lua`)

An intrinsic modifier listening to `MODIFIER_EVENT_ON_DEATH` summons N smaller copies and scatters them — self-propagating area pressure.

```lua
function modifier_alien_split:OnDeath(p)
    if not IsServer() or p.unit ~= self:GetParent() then return end
    local pos = self:GetParent():GetAbsOrigin()
    for i = 1, self.split_count do
        local child = CreateUnitByName(self.child_name, pos, true, nil, nil, self:GetParent():GetTeamNumber())
        child:KnockBack(RandomVector(1), 300, 200, 1)
    end
end
```

---

## 5. Projectiles

### Engine: `CreateLinearProjectile` (skillshot)

Pack full context into the table; `ExtraData` survives to the hit callback (note: engine stringifies numeric ExtraData). Mirana Arrow (Dota IMBA `hero_mirana.lua`) and Fireblade (Angel Arena `fireblade_fiery_stream.lua`) are the templates.

```lua
local info = {
    Ability = self, Source = caster,
    EffectName = "particles/.../mirana_arrow.vpcf",
    vSpawnOrigin = caster:GetAbsOrigin(),
    vVelocity = direction * speed * Vector(1, 1, 0),     -- flatten Z!
    fDistance = self.range,
    fStartRadius = self.width, fEndRadius = self.width,
    bDeleteOnHit = true,                                 -- false = pierce
    iUnitTargetTeam = DOTA_UNIT_TARGET_TEAM_ENEMY,
    iUnitTargetType = DOTA_UNIT_TARGET_HERO + DOTA_UNIT_TARGET_BASIC,
    fExpireTime = GameRules:GetGameTime() + 10,          -- safety net so it never lives forever
    bProvidesVision = true, iVisionRadius = 200, iVisionTeamNumber = caster:GetTeamNumber(),
    ExtraData = { cast_x = tostring(origin.x), cast_y = tostring(origin.y) },
}
ProjectileManager:CreateLinearProjectile(info)

function ability:OnProjectileHit_ExtraData(target, loc, data)
    if not target then return end                        -- target is nil when projectile simply expires
    self:DealDamage(self:GetCaster(), target, self.damage)
    return false                                          -- return false to pierce/continue; true/nil to stop
end
```

**Stationary wall** (Horde Mode `macropyre.lua`): a row of `CreateLinearProjectile` with `vVelocity = Vector(0,0,0)` and overlapping radii forms a persistent damaging strip until `fExpireTime` — area denial without per-unit thinkers.

### Engine: `CreateTrackingProjectile` (homing)

`bIsAttack = true` preserves attack semantics (procs/on-hit) — Dota IMBA's Mars (`hero_mars.lua`) re-fires intercepted attacks as homing copies this way.

```lua
local id = ProjectileManager:CreateTrackingProjectile({
    Target = target, Source = caster, Ability = self,
    EffectName = caster:GetRangedProjectileName(),
    iMoveSpeed = 1200, vSourceLoc = caster:GetAbsOrigin(),
    iSourceAttachment = DOTA_PROJECTILE_ATTACHMENT_ATTACK_1,
    bDodgeable = true, bIsAttack = true,
})
-- Manage in flight: ProjectileManager:GetTrackingProjectileLocation(id) / :UpdateProjectilePosition(id, pos)
-- Cancel: ProjectileManager:DestroyTrackingProjectile(id)
```

**Bounce AI** (Horde Mode Death Ward `death_ward.lua`): on hit, `FindUnitsInRadius(FIND_CLOSEST)` within bounce range, skip the current target and any already-hit (a `bounceTable`), require `CanEntityBeSeenByMyTeam`, fire the next, decay damage, and self-remove at `maxBounces` or no target.

**Projectile interception wall** (Dota IMBA Mars Arena `hero_mars.lua`): a `ProjectileFilter` lets allied/self/non-attack projectiles through (`return true`); for enemy attack projectiles touching the arena it spawns a tracked copy (with a `self.lock` guard so it doesn't filter its own re-fire), then an interval poll compares `GetTrackingProjectileLocation` distance to the wall radius and `DestroyTrackingProjectile` on crossing.

### Custom physics lib: `ProjectileSystem` (Guarding Athena)

`scripts/vscripts/mechanics/projectile_system.lua` is a self-contained engine for patterns the stock manager can't do: **LINEAR**, **TRACKING**, **GUIDANCE** (angular-velocity homing with auto-retarget via `flTrackRadius`), and **SURROUND** (N projectiles auto-spaced `360/N` orbiting a unit), plus `SplitAction` (fan a shot into N directions over a clamped angle) and `CounterProjectile` (reflect). It manages its own particle and a dummy thinker for ticking.

```lua
PROJECTILE_TYPE_LINEAR, PROJECTILE_TYPE_TRACKING = 0, 1
PROJECTILE_TYPE_GUIDANCE, PROJECTILE_TYPE_SURROUND = 2, 3

local info = {
    hAbility = hAbility, hCaster = hParent,
    sEffectName = "particles/.../breathe_fire.vpcf",
    vSpawnOrigin = hParent:GetAbsOrigin(),
    vDirection = vDirection, iMoveSpeed = self.speed,
    flDistance = self.range, flRadius = self.radius,
    OnProjectileHit = function(hTarget, vPos, tInfo)
        hParent:DealDamage(hTarget, hAbility, self.damage)
    end,
}
ProjectileSystem:CreateLinearProjectile(info)
```

It drives FX every `FrameTime()` via control points (`CP0 = position`, `CP1 = velocity`, `SetParticleControlForward(0, dir)` so the effect faces travel). The particle index lives on `tInfo.iParticleID` so the system can `DestroyParticle` on hit/expire. Powershot uses `SplitAction` to launch a 5-arrow `RotatePosition` fan.

> Header bug note (real shipped artifact): bouncing recreates the FX, so the trail resets for one frame. Custom physics libs trade that for capabilities the engine lacks — weigh it.

---

## 6. Ability AI for bots / scripted casters

For player-controlled-style bots, reuse the same building blocks but issue *orders* rather than direct effects so animations, cast points, and procs all fire naturally:

- `unit:CastAbilityOnTarget(target, ability, -1)` / `CastAbilityOnPosition` / `CastAbilityNoTarget` — the simplest API for a single unit.
- `ExecuteOrderFromTable{ UnitIndex=..., OrderType=DOTA_UNIT_ORDER_CAST_TARGET, AbilityIndex=..., TargetIndex=... }` — for multi-unit or queued orders (Horde Mode's behavior system uses this).
- Targeting helpers worth copying from `ai_core.lua`: `RandomEnemyHeroInRange` and `WeakestEnemyHeroInRange` wrap `FindUnitsInRadius(DOTA_TEAM_BADGUYS, ..., DOTA_UNIT_TARGET_HERO, ...)`.

```lua
-- Horde Mode: ai_core.lua — pick the lowest-HP enemy hero in range
function AICore:WeakestEnemyHeroInRange(entity, range)
    local enemies = FindUnitsInRadius(DOTA_TEAM_BADGUYS, entity:GetOrigin(), nil, range,
        DOTA_UNIT_TARGET_TEAM_ENEMY, DOTA_UNIT_TARGET_HERO, 0, 0, false)
    local target, minHP = nil, nil
    for _, e in pairs(enemies) do
        if e:IsAlive() and (not minHP or e:GetHealth() < minHP) then target, minHP = e, e:GetHealth() end
    end
    return target
end
```

A bot "should I cast?" gate combines readiness + mana + a valid target: `ability:IsFullyCastable()` (covers cooldown, mana, silence, and not-in-phase) before searching.

---

## 7. Difficulty scaling

Scaling is done at the **director/spawner** layer, not per-ability. Guarding Athena's `CSpawner` (`scripts/vscripts/class/spawner.lua`) is a Holdout-style director: a think loop spawns `UnitsPerSpawn` every `SpawnInterval` up to `TotalUnitsToSpawn`, with `WaitForUnit` / `GroupWithUnit` chaining between spawners and an `EmitGlobalSound` wave cue.

```lua
-- Guarding Athena: spawner.lua — promote spawns by difficulty
function CSpawner:SpawnUnit()
    local unit = CreateUnitByName(self.UnitName, self:GetSpawnPoint(), true, nil, nil, self.Team)
    unit:SetGoalEntity(self.GoalEntity)
    unit.iDefendingTeamNumber = self.iDefendingTeamNumber

    if RollPercentage(self.ChampionChance) then               -- elite/champion roll
        for _ = 1, self.ChampionBonusLevel do unit:CreatureLevelUp(1) end
        unit:AddNewModifier(unit, nil, "modifier_champion", {})
        unit:SetModelScale(unit:GetModelScale() * 1.35)
    end
    if GameRules.Difficulty >= HARD and RollPercentage(self.EliteChance) then
        unit:AddNewModifier(unit, nil, "modifier_elite", {})  -- extra stats on high difficulty
    end
end
```

Common scaling levers seen across the corpus:
- **Stats**: `CreatureLevelUp(n)` ramps base HP/damage; `SetBaseMaxHealth` / `SetMaxHealth` for direct tuning; `SetModelScale` for visual menace.
- **Density / cadence**: lower `SpawnInterval`, raise `UnitsPerSpawn` and champion/elite roll chances per wave/difficulty.
- **Boss gates**: scale the `damage_limit` phase size or `damage_reduce` phase-shield strength (§4) by difficulty.
- **Cast budget**: Life In Arena throttles enemy casting through a global `Survival.AICreepCasts` budget so higher difficulty = more frequent casts, shared across the wave.

```lua
-- Difficulty multiplier applied at spawn
local mult = ({[EASY]=0.75, [NORMAL]=1.0, [HARD]=1.5, [NIGHTMARE]=2.2})[GameRules.Difficulty]
unit:SetBaseMaxHealth(unit:GetBaseMaxHealth() * mult)
unit:SetMaxHealth(math.floor(unit:GetMaxHealth() * mult))
unit:SetHealth(unit:GetMaxHealth())
```

---

## Pitfalls

- **Server-only guards.** Wrap *all* gameplay in `if IsServer() then ... end`. `FindUnitsInRadius`, `ProjectileManager`, `DealDamage`, `ExecuteOrder`, and `AddNewModifier` are server-authoritative; calling them client-side does nothing or errors. Only persistent/looping particles benefit from an `IsClient()` create (to skip server->client replication). Every AI file above opens with `if not IsServer() then return end` or checks `IsServer()` inside handlers.

- **Think-loop cost.** A 0.03s (`StartIntervalThink(0)` / per-frame) loop running `FindUnitsInRadius` on dozens of units is your #1 perf sink. Use the slowest cadence that feels right — bosses tick at 0.25–0.5s (Abyss Warrior 0.5s, Horde boss 0.25s), AOE pulses at 0.5s. Cache ability handles, ranges, and special values in `Spawn`/`OnCreated`, never inside the tick. Pass `bCache = true` to `FindUnitsInRadius` only when you truly want a cached result.

- **Invalid handles.** Units die between ticks; stored targets and projectile targets go stale. Always `if not IsValid(h) then ... end` (or `h ~= nil and h:IsAlive()` / `IsNull()`) before touching a cached handle. In `OnProjectileHit`, `target` is `nil` when the projectile expires without hitting — check it. The Abyss Warrior re-validates its attack target with `_CanBeSeen` every tick precisely because the previous target may now be dead, fogged, or invis.

- **Stop the loop on death.** A `SetContextThink` that keeps returning a number after its unit dies is a leak pointing at a dead entity — return `nil` to deactivate (Horde boss). Prefer modifier `StartIntervalThink`, which the engine tears down automatically when the modifier/parent is removed.

- **Projectile cleanup.** Set `fExpireTime` on linear projectiles so they can never live forever. For custom physics libs, store the particle index (`tInfo.iParticleID`) and `DestroyParticle` it on hit *and* on expire *and* on caster death — orphaned particles outlive the projectile otherwise. **Destroying an in-flight tracking projectile can crash Dota** (documented in both Angel Arena's Damned Souls and the Mars arena code): only `DestroyTrackingProjectile` after confirming the id is still live, and self-destruct the owning modifier only after *all* projectiles have landed.

- **Order spam vs dropped orders.** Re-issuing `MoveTo`/`Cast` every tick (the `repeatedlyIssueOrders` approach) survives dropped orders but stutters animations and can cancel cast points. Either only issue when the desired order differs from the last (`previousOrderType`/`Target`/`Position` in `ai_core.lua`), or `Stop()` then issue once, and skip the tick entirely while `IsInAbilityPhase()`.

- **Recursion in attack-event combat.** `PerformAttack` inside an `OnAttack` modifier can re-enter your handler. Gate with `PassivesDisabled()`, a re-entry flag, and `skipCooldown/fakeAttack` args (Dota IMBA multishot). Same for projectile filters that re-fire projectiles — use a `self.lock` guard (Mars arena) so the filter ignores its own copies.

- **Flatten projectile Z.** `vVelocity` and direction vectors must be multiplied by `Vector(1,1,0)` (or normalized in the XY plane); a stray Z component sends projectiles into the floor or sky and breaks collision.

- **Displacement leaves units stuck.** After `KnockBack` / motion controllers / teleports, call `GridNav:DestroyTreesAroundPoint` and `FindClearSpaceForUnit` so units don't wedge in trees or stack on each other (Angel Arena Harpy, Horde Mode Spectre swap). Always release motion with `InterruptMotionControllers` in `OnDestroy`/`OnInterrupted`.
