# Advanced Techniques & Engine-Limit Workarounds

The "hard problems" tier of Dota 2 custom-game engineering, distilled from shipping addons:
bypassing the 32-bit health cap, running a real physics engine on top of Dota pathing,
baking navmesh/collision data offline, procedural generation, competitive catch-up, bot AI,
authenticated backends, and dev tooling. Every technique is reverse-engineered from a real
game and cited inline. Read the closing **Pitfalls / Stability** section before shipping.

Source tags: **EBF** = *Epic Boss Fight* (305278898), **Warlock** = *Warlock Brawl*
(296662770), **BoM** = *Battle of Mirkwood* (1092484716, TypeScriptToLua), **Petri** =
*Petri Reborn* (483720948), **AABS** = *Angel Arena Black Star* (699441891), **DotaRun** =
*Dota Run* (469890148), **BoC** = *Battle of Characters / dotadash* (511860561), **WTF+**
(1579522476), **OT3** = *OVERTHROW 3.0* (2760533777).

---

## 1. Engine-Limit Workarounds

### 1.1 EHP rescale: bypass the 32-bit health cap (EBF)

Dota stores health as a signed 32-bit int (`SetMaxHealth` saturates ~2.1B; the HP bar breaks
far below that). EBF never lets the engine track more than **200,000 real HP**, soaks the rest
with proportional incoming-damage reduction, and displays the "effective" numbers through a
custom Panorama bar. Combine a hard MaxHealth clamp with damage reduction — don't fight the
int cap directly.

```lua
-- bossmanager.lua: clamp real HP, compute the multiplier (unit.MaxEHP = desired huge HP)
function bossManager:onBossSpawn(unit)
  unit.EHP_MULT = 1                               -- default so early multiplications are safe
  Timers:CreateTimer(0.1, function()
    if unit.MaxEHP > 200000 then
      unit:SetMaxHealth(200000); unit:SetHealth(200000)
      unit.EHP_MULT = unit.MaxEHP / 200000        -- e.g. 5e9 / 2e5 = 25000
      unit:SetBaseHealthRegen(unit:GetBaseHealthRegen() / unit.EHP_MULT)   -- scale regen too
      unit:AddNewModifier(unit, unit, "bossHealthRescale", {})
    end
  end)
end
```

```lua
-- modifier/bosshealthrescale.lua: every real HP point now soaks EHP_MULT damage.
-- GetAttributes() = PERMANENT + IGNORE_INVULNERABLE (dispel-proof, applies while phased);
-- DeclareFunctions() = { MODIFIER_PROPERTY_INCOMING_DAMAGE_PERCENTAGE }.
function bossHealthRescale:GetModifierIncomingDamage_Percentage(event)
  if IsServer() then return -((1 - (1 / self:GetParent().EHP_MULT)) * 100) end  -- 99.996% at 25000x
end
```

```lua
-- panoramabridge.lua: 0.09s SetThink finds the highest-EHP living enemy, multiplies real
-- values back up by EHP_MULT, and ships effective HP to a custom Panorama bar:
function panoramaBridge:Update_Health_Bar()
  -- ...pick biggest = creature with max GetMaxHealth()*EHP_MULT...
  local arg = {
    total_life   = set_comma_thousand(biggest:GetMaxHealth() * biggest.EHP_MULT),  -- "5,000,000,000"
    current_life = set_comma_thousand(biggest:GetHealth()    * biggest.EHP_MULT),
    total_life_disp   = biggest:GetMaxHealth() * biggest.EHP_MULT,   -- raw, for bar fill %
    current_life_disp = biggest:GetHealth()    * biggest.EHP_MULT,
  }
  if self.Last_HP_Display ~= arg.current_life then    -- gate so we only send on display change
    self.Last_HP_Display = arg.current_life
    CustomGameEventManager:Send_ServerToAllClients("Update_Health_Bar", arg)
  end
  return 0.09
end

function comma_value(amount)   -- thousands separator: gsub until no more 3-digit groups
  local f, k = amount
  repeat f, k = string.gsub(f, "^(-?%d+)(%d%d%d)", "%1,%2") until k == 0
  return f
end
```

The boss behaves and *displays* as billions of HP; the engine never tracks above 200000.
Fill the custom bar with `current_life_disp / total_life_disp`.

---

## 2. Custom Physics & Collision (Warlock, BoC)

Warlock Brawl ships a deterministic fixed-tick 2D physics world, fully independent of
`FindUnitsInRadius`. Heroes, projectiles and obstacles are all "actors" in one velocity
field, giving elastic hero-vs-hero bouncing, damage-scaled knockback, and projectiles that
deflect other projectiles.

### 2.1 Sweep-and-prune broadphase + CCD (Warlock — base/physics.lua)

Each tick, push every collider's swept X interval (start, end) into a min-heap and sweep in
sorted X maintaining an "active set"; only X-overlapping pairs are tested. The `±0.1`
epsilon forces interval starts to sort before ends at equal X.

```lua
function Game:_physCollectCollisionExtents(dt)
  self.phys_cc_extent_heap:clear()
  for cc in pairs(self.phys_active_ccs) do
    local x_start, x_end = cc:extentX(dt)                 -- swept X, inflated by radius
    self.phys_cc_extent_heap:insert(x_start - 0.1, cc)    -- start sorts before end at equal x
    self.phys_cc_extent_heap:insert(x_end   + 0.1, cc)
  end
end
-- _physFindCollisions: pop the heap in X order, keep a "ccs_here" active set; on a start,
-- test the new cc against every cc already in the set; on an end, remove it. Only
-- X-overlapping pairs ever reach _physCheckCollision.
```

**CCD** solves `((dp + dv*t)^2 = (r1+r2)^2)` for the exact sub-frame impact time so fast
projectiles can't tunnel; collisions resolve from a **second** min-heap in time order.

```lua
local function _timeToCollision(cc1, cc2)
  local dp = cc2.actor.location - cc1.actor.location     -- relative position
  local dv = cc2.actor.velocity - cc1.actor.velocity     -- relative velocity
  local r_sq, dst_sq = (cc1.radius + cc2.radius) ^ 2, dp:Dot(dp)
  if dst_sq < r_sq then return 0 end                     -- already overlapping
  local A = dv:Dot(dv); if A <= 0 then return -1 end     -- no relative motion
  local B, C = 2 * dp:Dot(dv), dst_sq - r_sq
  local D = B * B - 4 * A * C
  if D < 0 then return -1 end
  return (math.sqrt(D) - B) / (2 * A)                    -- future-collision root
end
```

`_physResolveCollisions` pops the time-ordered heap, advances both actors to impact via
`moveInTime(tm)` (`location = location + velocity*dt*time_scale`), notifies handlers and runs
elastic response, then `moveInTime(-tm)` to rewind.

### 2.2 The hybrid bridge: Dota pathing → custom physics (Warlock — base/pawn.lua)

Heroes live in the physics sim, not the engine — yet players still click-to-move. Each tick,
treat Dota pathing's displacement `(now - last)/dt` as a `walk_velocity` component (clamped to
`WALK_SPEED`) and compose it with knockback by removing last frame's contribution first.

```lua
function Pawn:onPreTick(dt)
  self.velocity = self.velocity - self.walk_velocity        -- remove last frame's walk
  self.velocity = self.velocity * Config.FRICTION           -- friction on the non-walk part
  self.walk_velocity = (self.unit:GetAbsOrigin() - self.location) / dt   -- where pathing moved us
  self.walk_velocity.z = 0
  if self.walk_velocity:Dot(self.walk_velocity) > self.WALK_SPEED_SQ then -- clamp
    self.walk_velocity = self.walk_velocity:Normalized() * self.WALK_SPEED
  end
  self.velocity = self.velocity + self.walk_velocity        -- recompose with knockback/momentum
end
-- Pawn:_updateLocation() writes the sim result back: SetAbsOrigin(GetGroundPosition(location, unit)).
```

### 2.3 Arc-length-reparameterized analytic curve flight (Warlock — twinprojectile.lua)

Fly a true ellipse at **constant linear speed** (not constant parameter rate) while staying a
first-class physics body: convert the parametric step to a velocity, rotate it to world
space, and inject it into the shared physics velocity by subtracting last frame's piece.

```lua
-- getEllipseVelocity() = analytic tangent (-a*sin t, sign*b*cos t, 0)
function TwinProjectile:onPreTick(dt)
  local ellipse_dt = max(0.001, dt * self.speed / self:getEllipseVelocity():Length())  -- arc-length reparam
  self.ellipse_t = min(math.pi, self.ellipse_t + ellipse_dt)
  local ellipse_loc = self:getEllipseLocation()
  local unrotated = (ellipse_loc - self.virtual_location) / dt
  self.virtual_location = ellipse_loc
  local new_v = self:rotateEllipseVector(unrotated)                     -- into world space
  local old_v = self:rotateEllipseVector(self.prev_unrotated_velocity)
  self.prev_unrotated_velocity = unrotated
  self.velocity = self.velocity - old_v + new_v             -- inject; composes with collisions
  if self.ellipse_t >= math.pi then self:setLifetime(0) end
end
-- reflectVelocity also reflects ellipse_dir so bounces stay on-curve.
```

### 2.4 Offline-baked wall-normal "angle grid" for O(1) bounce (BoC — physics.lua)

Pre-bake the reflection normal of every blocked GridNav cell. At dev time, for each blocked
cell sum unit vectors toward its **open** 8-neighbors and store the angle; reject corners/
spikes (more than one open segment = `OVERSEG`, 6+ open = `PROTRUDE`) by storing `-1`.

```lua
-- bake (FCVAR_CHEAT "anggrid"): for a blocked cell, walk its 8 neighbors in ring order,
-- sum unit vectors toward OPEN ones, count open neighbors and contiguous open segments.
if seg > 1 then anggrid[i+offsetX][j+offsetY] = -1            -- OVERSEG: corner, no clean normal
elseif count > 5 then anggrid[i+offsetX][j+offsetY] = -1      -- PROTRUDE: spike
elseif count == 0 then anggrid[i+offsetX][j+offsetY] = -1
else
  local s = sum:Normalized()
  local angle = math.floor(math.acos(Vector(1,0,0):Dot(s)) / math.pi * 180)
  if s.y < 0 then angle = -angle end
  anggrid[i+offsetX][j+offsetY] = angle                       -- store outward-normal angle
end
```

```lua
-- runtime: recover the normal by rotating (1,0,0) by the stored angle, O(1) per bounce
local angle = anggrid[navX + offX][navY + offY]
if angle ~= -1 then    -- -1 means corner/spike: fall back to per-cell probing
  local normal = RotatePosition(Vector(0,0,0), QAngle(0, angle, 0), Vector(1,0,0))
  unit:SetAbsOrigin(position + normal * 64)    -- nudge off the wall, then reflect velocity
end
```

### 2.5 Round-robin frame-spreading (BoC — physics.lua)

A 100Hz think over many colliders becomes bursty. Let each collider opt into being checked
every Nth frame, with an auto-assigned `skipOffset` so they fire on different frames.

```lua
collider.skipOffset = self.colliderSkipOffset           -- assigned once at AddCollider
self.colliderSkipOffset = self.colliderSkipOffset + 1
-- per-frame gate, one modulo:
for _, c in pairs(Physics.Colliders) do
  if c.skipFrames == 0 or ((self.frameCount + c.skipOffset) % (c.skipFrames + 1) == 0) then
    -- ...check this collider this frame...
  end
end
```

---

## 3. Navmesh / Grid Pipelines

### 3.1 Build-time walkable-grid export via GridNav (BoM — grid_position_finder.lua)

Sweep the map on a 128-unit grid, test `GridNav:CanFindPath` from center, and `io.write`
every reachable cell to a checked-in Lua data file. Gate behind `IsInToolsMode()`.

```lua
if not IsInToolsMode() then return end
local center = Entities:FindByName(nil, "world_center"):GetOrigin()
local file = io.open("../../dota_addons/da/scripts/vscripts/data/grid_positions.lua", "w")
file:write("return {\n {x=0, y=0}\n")
for x = GetWorldMinX(), GetWorldMaxX(), 128 do
  for y = GetWorldMinY(), GetWorldMaxY(), 128 do
    if GridNav:CanFindPath(center, Vector(math.floor(x), math.floor(y), 256)) then
      file:write(",{x=" .. math.floor(x) .. ",y=" .. math.floor(y) .. "}\n")
    end
  end
end
file:write("}"); file:flush(); file:close()   -- runtime: require("data/grid_positions")
```

At runtime `require("data/grid_positions")` gives thousands of valid spawn points with zero
pathing cost. BoM keeps a runtime cache and prunes it in one pass when its battle-royale zone
shrinks (drop every point outside the new circle, keyed by `rescaleRadius` so it runs once).

### 3.2 Console export with `InitLogFile` + near-O(n) string builder (BoC — physics.lua)

Bake expensive analysis once, ship it as a data file. BoC's `spider` command emits a `1`/`0`
blocked-cell bitmap; `angsave` serializes the 2D angle grid as a literal `"{{a,b},...}"` and
writes it with `InitLogFile`.

```lua
-- near-O(n) string builder: push the fragment, then merge while the previous fragment's
-- length is <= the new combined one (avoids Lua's naive O(n^2) concatenation)
local addString = function(stack, s)
  table.insert(stack, s)
  for i = table.getn(stack) - 1, 1, -1 do
    if string.len(stack[i]) > string.len(stack[i + 1]) then break end
    stack[i] = stack[i] .. table.remove(stack)
  end
end
-- build "{{a,b},{c,d},...}" for the whole anggrid via addString, then InitLogFile(path, table.concat(s))
```

### 3.3 Navmesh → Panorama build grid with RLE packing (Petri — gridnav.lua + gnv.js)

Server walks every cell with `GridNav:IsTraversable`/`IsBlocked`, packs the map into a
bitstring, converts each 8 bits to hex, then RLEs it — but only emits the `(count)` form when
it is actually shorter than the literal repeat.

```lua
-- per cell: blocked flag; accumulate 8 bits -> 1 hex byte
local blocked = not GridNav:IsTraversable(position) or GridNav:IsBlocked(position)
GNV.Layers["Terrain"][y][x] = tostring(blocked and 1 or 0)
-- ...when binaryStr reaches 8 chars: gnv[n] = format("%02s", IntToHex(BinToInt(binaryStr)))...

function PackGNVTable(gnvTable, length)   -- RLE the hex, but only emit "(count)" when it shrinks
  local packed, prevChar, count = {}, gnvTable[1], 1
  for i = 2, length do
    if prevChar ~= gnvTable[i] then
      local strLen = "(" .. count .. ")"
      if string.rep(prevChar, count):len() > strLen:len() then
        table.insert(packed, prevChar); table.insert(packed, strLen)   -- shorter: "x(40)"
      else table.insert(packed, string.rep(prevChar, count)) end       -- literal "xx"
      count = 0
    end
    count = count + 1; prevChar = gnvTable[i]
  end
  return packed
end
```

Ship the packed string via a custom event plus an incremental `LayersQueue` net table for
per-region updates that self-clear after 15s. The **client** (gnv.js) decodes back into a 2D
grid and renders the overlay as screen-space particles — but it does **not** rebuild every
frame. It samples `GameUI.GetScreenWorldPosition` on a step grid, destroys quads whose
`Game.WorldToScreenX/Y` falls outside `[0, Res]` (scrolled off-screen), re-seeds only newly
exposed cells, and remaps only when the screen center moves more than 128 units.

### 3.4 World → minimap projection overlay (AABS — dynamic_minimap.lua + custom_hud.js)

Valve exposes no arbitrary minimap icons. The server converts world coords to minimap
**percentages**; the client overlays CSS-positioned panels on the real native minimap.

```lua
function WorldPosToMinimap(vec)
  local pct1 = (vec.x + MAP_LENGTH) / (MAP_LENGTH * 2)
  local pct2 = (MAP_LENGTH - vec.y) / (MAP_LENGTH * 2)
  return pct1 * 100 .. "% " .. pct2 * 100 .. "%"   -- CSS "x% y%"
end
```

```js
// one child Panel per point under DynamicMinimapRoot, positioned by the server's "x% y%" string
panel = $.CreatePanel('Panel', minimapPanel, 'minimap_point_id_' + index);
panel.hittest = false; panel.AddClass('icon');
panel.style.position = changesObject[index].position + ' 0';
panel.visible = changesObject[index].visible === 1;
// size the overlay root to the MEASURED native minimap so the % maps onto it correctly
var minimap = FindDotaHudElement('minimap_block');
$('#DynamicMinimapRoot').style.width =
  ((minimap.actuallayoutwidth + minimap.contentwidth - minimap.actuallayoutwidth) / sw * 100) + '%';
```

```css
/* DynamicMinimapRoot is sized/positioned to overlay minimap_block; .icon panels carry the art */
.DynamicMinimapRoot { position: absolute; width: 100%; height: 100%; }
.DynamicMinimapRoot .icon { width: 12px; height: 12px; background-size: contain;
    horizontal-align: left; vertical-align: top; }   /* position set per-point by JS */
```

### 3.5 Runtime map-bounds discovery via TraceHull (WTF+ — server/common.lua)

Fire six `TraceHull` queries — one per face of the world box, each a thin slab moving inward
toward center — and assemble the true collision AABB from the six hits. No per-map config.

```lua
function CalculateMapAABB(center)
  -- cast[i] = the i-th face's start point (left, down, bottom, right, up, top);
  -- boxes[i] = a thin 512-thick slab hull for that face, built from GetWorldMin/MaxX/Y
  -- + WORLD_MIN/MAX_Z. Trace each inward toward center and collect the six hit points:
  local r, wc = {}, center or Vector(0, 0, 0)
  for i = 1, 6 do
    local p = { startpos = cast[i], endpos = wc, min = boxes[i][1], max = boxes[i][2], mask = 0x1 }
    if TraceHull(p) and p.hit then r[i] = p.pos else error("AABB trace missed") end
  end
  return { Mins = Vector(r[1].x, r[2].y, r[3].z),    -- left, down, bottom
           Maxs = Vector(r[4].x, r[5].y, r[6].z) }   -- right, up, top
end
```

---

## 4. Procedural Generation

### 4.1 Guaranteed-solvable minefield via carved random walk (DotaRun — techies.lua)

Fill a grid with mines, then carve a guaranteed-traversable corridor with a biased random
walk (40% advance a column, else jiggle the row in bounds). Plant only the remaining cells,
staggered. The maze is **solvable by construction every round.**

```lua
local fHeight, fLength = 3, 4
function setUpMines()
  for i = 0, fLength - 1 do                                 -- everything starts as a mine
    stasisTrap[i] = {}
    for j = 0, fHeight - 1 do stasisTrap[i][j] = true end
  end
  -- carve a guaranteed-safe corridor with a biased random walk
  local x, y = 0, RandomInt(0, fHeight - 1)
  stasisTrap[x][y] = false
  while x < fLength + 1 do                                  -- over-run so the corridor exits
    if RandomFloat(0, 1) > 0.6 then x = x + 1               -- 40% advance a column
    elseif y == 0 or y == fHeight - 1 then y = 1            -- else jiggle the row in-bounds
    else y = (RandomInt(0, 1) == 0) and 0 or 2 end
    if x <= fLength - 1 and y <= fHeight - 1 then stasisTrap[x][y] = false end
  end
  -- then plant ONLY the still-true cells, staggered via an incrementing timeout
  -- so the (solvable-by-construction) maze appears one trap at a time.
end
```

---

## 5. Competitive Systems (DotaRun)

### 5.1 Rubber-banding / blue-shell catch-up

Rank players by remaining track distance each second and assign an **ascending**
`SetBaseMoveSpeed` (1st slowest, each next +20), so whoever is behind is fastest. Same pass
captures the leader for targeted hazards. Fully server-side.

```lua
function CDotaRun:BlueShell(playerPositions)   -- playerPositions sorted best -> worst
  local speed = 360
  for key, t in pairs(playerPositions) do
    local playerID = PlayerResource:GetNthPlayerIDOnTeam(t.teamID, 1)
    local p = playerID and playerID ~= -1 and PlayerResource:GetPlayer(playerID)
    local hero = p and p:GetAssignedHero()
    if hero then
      hero:SetBaseMoveSpeed(speed)
      speed = speed + 20                         -- everyone behind is faster
      if key == 1 then self.leadingPlayerID = playerID end   -- leader, for targeted hazards
    end
  end
end
```

### 5.2 Track-progress scalar by summing remaining checkpoint segments

Precompute pairwise checkpoint distances once. Each tick, walk checkpoints last→first: add
the full length of each uncrossed segment, then the live distance to the **next** uncrossed
checkpoint, and break. One comparable scalar you can `table.sort` into race positions —
reusable for laps, escorts, any waypoint course.

```lua
-- init: precompute segment lengths once
self.waypointDistances = {}
for i = 1, #self.checkpoints - 1 do
  self.waypointDistances[i] =
    (self.checkpoints[i]:GetAbsOrigin() - self.checkpoints[i + 1]:GetAbsOrigin()):Length2D()
end

-- per tick: one comparable "remaining distance" scalar per player
function CDotaRun:CalculateDistances()
  for i = 0, DOTA_MAX_TEAM_PLAYERS - 1 do
    local hero = PlayerResource:GetPlayer(i) and PlayerResource:GetPlayer(i):GetAssignedHero()
    if hero then
      local dist = 0
      for w = #self.checkpoints - 1, 0, -1 do
        if w > 0 and not self.waypoints[i][w] then
          dist = dist + self.waypointDistances[w]                -- full uncrossed segment
        else
          dist = dist + (self.checkpoints[w + 1]:GetAbsOrigin() - hero:GetOrigin()):Length2D()
          break                                                  -- live distance to next, then stop
        end
      end
      self.playerDistances[i + 1] = dist
    end
  end
end
```

### 5.3 Anti-leader homing hazard with stuck-detection self-cleanup (charge.lua)

The last-place player gets a charger that, after a grace timer, casts on the tracked
`leadingPlayerID`. Its think compares position to one think ago and self-`Destroy()`s if it
hasn't moved — a stuck/idle detector instead of a fixed lifetime.

```lua
function ChargerThink()
  if (lastPosition - charger:GetAbsOrigin() == Vector(0, 0, 0)) then  -- has not moved
    charger:Destroy(); return
  end
  lastPosition = charger:GetAbsOrigin()
  return 2
end
```

---

## 6. Bot AI Frameworks

### 6.1 Stack-based supervisor with shared blackboard (WTF+ — entities/ai/base.lua)

A 3-tier scaffold: `CBaseAI` (think loop, `xpcall`-guarded actions, `OnEntText` debug) →
`CStateMachineAI` (action returns next state) → `CStackStateMachineAI` (a true pushdown
automaton so behaviors nest and resume). A `CAISupervisor` runs several agents per unit
(combat, economy, item-build) sharing **one** blackboard.

```lua
-- CBaseAI:Think() runs NextAction() when GameRules:GetGameTime() >= time_point and schedules
-- the next call at + (returned delay). Pushdown automaton lets behaviors nest and resume:
function CStackStateMachineAI:PushAction(name, delay) table.insert(self.ActionStack, {name, delay}) end
function CStackStateMachineAI:PopAction() return table.remove(self.ActionStack) end
function CStackStateMachineAI:NextAction()
  xpcall(function() return self.Actions[self.current_action](self) end,
         function(msg) print(msg .. "\n" .. debug.traceback()) end)   -- one bad action can't kill the loop
  local top = self.ActionStack[#self.ActionStack]
  if top then self.current_action = top[1] or self.default_action; return top[2] end
  self.current_action = self.default_action; return self.DEFAULT_DELTA
end

function CAISupervisor:Begin()                    -- one shared blackboard across all agents
  self.storage = {}
  for _, ai in ipairs(self.ai_components) do ai:SetPublicStorage(self.storage); ai:Begin() end
end
```

Wire `GetOrCreatePrivateScriptScope().OnEntText = function() return self:GetDebugString() end`
(then `ValidatePrivateScriptScope()`) so `ent_text` shows the live action stack
(`"[AI] Action stack: a > b > c"`) in tools mode.

### 6.2 Potential-field gradient-descent dodging (Warlock — base/aicontroller.lua)

Dodge projectiles by steering down a continuous "danger" field. `getDanger(loc)` sums
`1/(1+d)` from every enemy projectile, where `d` is the perpendicular point-to-line distance
to its extrapolated path (gated so only projectiles heading toward the point count).
`getDodgeDirection` estimates the gradient by finite differences and walks down it.

```lua
function AIController:getDanger(loc)
  local danger = 0
  for _, proj in pairs(self:enemyProjectiles()) do
    local dst = (loc - proj.location):Length()
    -- gate: only projectiles heading toward loc and within range count
    if proj.velocity:Normalized():Dot((loc - proj.location):Normalized()) >= self.danger_min_cos_dst
       and dst <= self.danger_min_dst then
      local p2, d = proj.location + proj.velocity, proj.velocity
      -- perpendicular point-to-line distance to the projectile's extrapolated path
      local line_dst = math.abs(d.y*loc.x - d.x*loc.y + p2.x*proj.location.y - p2.y*proj.location.x) / d:Length()
      danger = danger + self.danger_scale / (1.0 + line_dst)
    end
  end
  return danger
end

-- getDodgeDirection: sample danger at the pawn and at +X / +Y offsets, steer down the
-- finite-difference gradient: dir = Vector(d0 - dx, d0 - dy):Normalized().
```

Analytic lead/intercept aiming (`getPredictedDir`) solves the interception quadratic
`(|v_t|² - s²)t² + 2(Δ·v_t)t + |Δ|² = 0` for the lead time `t`, then aims at
`(v_t * t - Δ) / (s * t)`; if the discriminant is negative it falls back to aiming direct.

---

## 7. Backend Security

### 7.1 HMAC-SHA1 signed requests with canonical sorted params (BoM — server/request.lua)

Build a canonical string by sorting param keys alphabetically, concatenating
`serviceID + each k..v + secret`, then HMAC it. The secret is `GetDedicatedServerKeyV2`
(only valid on a real dedicated server, so gate with `IsDedicatedServer()`).

```lua
function makeSign(params)
  local serviceKey = GetDedicatedServerKeyV2(serviceID)     -- server-only secret
  local str, keys = serviceID, {}
  for k in pairs(params) do table.insert(keys, k) end
  table.sort(keys)                                          -- canonical order is mandatory
  for _, k in pairs(keys) do str = str .. k .. tostring(params[k]) end
  return sha1.hmac(serviceKey, str .. serviceKey)
end
-- header: { ["x-service-id"]=serviceID, ["x-service-sign"]=makeSign(hData) }, then HttpPost.
```

BoM also probes the prod host on a startup think (`HttpGet(addr, nil, nil, 3000) == 200`) and
falls over to a test URL before firing a queued `OnReady` list — primary/fallback failover
with no server config.

### 7.2 Per-client murmurhash anti-spoof event token (WTF+ — server/gameevents.lua)

Each Panorama context generates `eventKey = Murmurhash2(RandomString(64))` once and registers
it. The server monkey-patches `RegisterListener` so every inbound event is intercepted: it
injects `PlayerID` and **learns** that player's key passively. Every send echoes the player's
own key; the client only fires callbacks when the echoed key matches its own.

```lua
local key_field_name = "_TeufortKey"
CCustomGameEventManager.player_keys = CCustomGameEventManager.player_keys or {}
CCustomGameEventManager.RegisterListener_Engine =
  CCustomGameEventManager.RegisterListener_Engine or CCustomGameEventManager.RegisterListener

function CCustomGameEventManager:RegisterListener(event_name, callback)
  return self:RegisterListener_Engine(event_name, function(idx, event)
    local player = EntIndexToHScript(idx)
    event.PlayerEntity, event.PlayerID = player, player:GetPlayerID()
    if event[key_field_name] ~= nil then
      self.player_keys[idx] = event[key_field_name]         -- learn the key passively
    end
    callback(event, idx)
  end)
end
-- SendToPlayer/SendToTeam/SendToAll: set event_data[key_field_name] = player_keys[entindex]
-- before each Send_ServerToPlayer (echo each recipient their own key), then clear it.
```

Client (util.js): `GameEvents.Subscribe2` wraps `Subscribe` and only fires the callback when
`args._TeufortKey == GameUI.CustomUIConfig().eventKey`; outbound sends attach the same key.

### 7.3 Reliable client→server ACK + adaptive-RTT retry + protected token (OT3 — protected_events.js)

Three pieces on top of `SendCustomGameEventToServer`: (1) tag each payload with a unique
`_id` and re-send until the server replies `EventStream:ack{ack_id}`; (2) the retry delay
self-calibrates from a 2x-pessimistic running average of measured RTT; (3) each client drops
any incoming event whose `protected_token` differs from its own.

```js
// (1) tag + resend until ACK. SendToServerEnsured sets payload._id = unique id, sends,
//     then $.Schedule(DEFAULT_RETRY_DELAY, resend) storing {retry_token, sent_time}.
// (2) on ACK: cancel retry, fold RTT into the self-calibrating running average:
frame.SubscribeProtected("EventStream:ack", (event) => {
  const entry = AWAITED_EVENTS[event.ack_id]; if (!entry) return;
  const pessimistic = Math.max(2 * (Game.GetGameTime() - entry.sent_time), MIN_PESSIMISTIC_PING);
  DEFAULT_RETRY_DELAY = (ACK_EVENTS_COUNT * DEFAULT_RETRY_DELAY + pessimistic) / (ACK_EVENTS_COUNT + 1);
  ACK_EVENTS_COUNT++;
  $.CancelScheduled(entry.retry_token); delete AWAITED_EVENTS[event.ack_id];
});

// (3) anti-spoof gate: drop any inbound event whose token isn't ours
GameEvents.SubscribeProtected = (event_name, callback) =>
  GameEvents.Subscribe(event_name, (event) => {
    if (event.protected_token === undefined) return;     // discard tokenless
    if (Game.GetLocalPlayerID() == -1 || GameEvents._PROTECTED_TOKEN == event.protected_token) {
      callback(event.event_data);
    } else { throw `Event ${event_name} has wrong server token`; }
  });
```

### 7.4 GetDedicatedServerKeyV3 + Blowfish-encrypted loadstring (WTF+ — packs/encoding.lua, server/script_host.lua)

WTF+ hides a privileged dedicated-server command by encrypting it with Blowfish keyed by
`GetDedicatedServerKeyV3`. The server keys the cipher with the secret; the client keys it
with a decoy. A player reading the decompiled VPK cannot recover or forge the command.

```lua
-- addon_init.lua: server keys the cipher with the secret, client with a decoy
if IsServer() then     cipher_init(GetDedicatedServerKeyV3("__=opghbh124AQWE1tgm;;WHAT??"))
elseif IsClient() then cipher_init("helvetica") end

-- packs/encoding.lua: Blowfish over a hand-rolled base64
function encrypt(data) return to_base64(string.char(unpack(encipher(to_bytes(data))))) end
function restore(data) return string.char(unpack(decipher(to_bytes(from_base64(data))))) end

-- server/script_host.lua: the privileged launch command rides as an encrypted blob
function CAddonScriptHost:NewSession(map, new_session_data)
  assert(IsDedicatedServer(), "NewSession must run on the dedicated server.")
  -- ...assemble session_data from keys mapped through encrypted SESSION_KEY_REFERENCE...
  local str = restore("Ds1f6aRVCUCBl/V3Rde0qtbUm6T54FNlSauoyKty0OjLOSYECWuHczQa2It...==")
  assert(loadstring(str))(map, table.concat(session_data, " "))   -- can't be forged by clients
end

-- pull other workshop content at runtime
function CAddonScriptHost:RequestUGCDownload(ugc_id)
  if IsDedicatedServer() then SendToServerConsole("sv_dota_custom_game_cache_test_download " .. ugc_id) end
end
```

---

## 8. Dev Tooling

### 8.1 Line-level Lua memory profiler via debug.sethook (BoM — utils/lua_memory_usage.lua)

A per-line debug hook reads `collectgarbage("count")` on every executed line, computes the
delta since the previous line, and aggregates `{count, total KB}` keyed by `source@line`.
`ShowRecord` prints the top-N allocation hotspots, exposed as a `FCVAR_CHEAT` command.

```lua
local memory_state, current_memory = {}, 0
local function recordAlloc(event, line_no)
  local inc = collectgarbage("count") - current_memory
  if inc < 1e-6 then return end                  -- ignore noise/dealloc
  local info = string.format("%s@%s", debug.getinfo(2, "S").source, line_no - 1)
  local item = memory_state[info]
  if not item then memory_state[info] = {info, 1, inc}
  else item[2] = item[2] + 1; item[3] = item[3] + inc end
  current_memory = collectgarbage("count")
end

function utilsMemoryLeakDetector:StartRecord()
  if debug.gethook() then self:EndRecord(); return end       -- toggle off if already on
  memory_state, current_memory = {}, collectgarbage("count")
  debug.sethook(recordAlloc, "l")                            -- "l" = per-line hook
end
function utilsMemoryLeakDetector:EndRecord() debug.sethook() end
-- ShowRecord(n): table.sort memory_state by total bytes desc, print top n. Register a
-- FCVAR_CHEAT "debug_dump_lua_memory_detail" command (IsInToolsMode only) that calls it.
```

### 8.2 Standard map → blank sandbox + skin-correct precache + cheat flag (training polygon — gamemode.lua)

Convert a normal map into an ability-testing sandbox at runtime: strip the engine's lane/
neutral spawners so no creeps spawn, precache every hero with **playerID 0** (omitting it
yields error models for non-default cosmetics), and raise a one-time cheat-mode notice for
leaderboard integrity.

```lua
-- 1) strip engine spawners -> no creeps
local classes_to_remove = {
  "npc_dota_neutral_spawner",
  "npc_dota_spawner_good_top","npc_dota_spawner_good_mid","npc_dota_spawner_good_bot",
  "npc_dota_spawner_bad_top", "npc_dota_spawner_bad_mid", "npc_dota_spawner_bad_bot",
}
for _, c in pairs(classes_to_remove) do
  for _, v in pairs(Entities:FindAllByClassname(c)) do v:RemoveSelf() end
end

-- 2) skins-correct precache: pass playerID 0 (omitting it => error models for custom skins)
PrecacheUnitByNameAsync(hero, function() --[[ chain next hero sequentially ]] end, 0)

-- 3) per-frame, one-time cheat flag for leaderboard integrity
Timers:CreateTimer(function()
  if GameRules:IsCheatMode() and CHEAT_MODE == 0 then
    CHEAT_MODE = 1
    CustomGameEventManager:Send_ServerToAllClients("send_nudes", { nudes = "Cheat mode detected" })
  end
  return FrameTime()
end)
```

---

## 9. Pitfalls / Stability

Each technique above pushes the engine. Read before shipping.

- **EHP rescale (§1.1).** `GetHealth()` returns 0..200000 — anything reading health (execute
  thresholds, lifesteal, "below X%") must use `GetHealth() * EHP_MULT` or work in fractions.
  EBF clamps on a 0.1s timer, so for one tick the unit has its real MaxHealth — also clamp in
  the modifier's `OnCreated`, and default `EHP_MULT = 1`. Divide regen by `EHP_MULT` or the
  boss heals its whole bar in seconds. Use `MODIFIER_ATTRIBUTE_PERMANENT` (dispel-proof); gate
  the hook with `IsServer()`.
- **Custom physics (§2).** Per-tick `SetAbsOrigin` bypasses Dota pathing — you own bounds
  checking (§3.5) and `GetGroundPosition` snapping. **Fixed dt is assumed**; drive from a
  fixed-rate think, not `FrameTime()`, or CCD/arc-length timing drifts. CCD only prevents
  tunneling if the broadphase pairs the objects — a fast object's swept extent must be in the
  §2.1 interval. The `±0.1` epsilon forces starts to sort before ends at equal X; drop it and a
  pair sharing an edge is skipped. Never frame-spread (§2.5) fast projectiles.
- **Offline-baked grids (§2.4, §3.1–3.3).** Baked data is map-version-specific: editing
  terrain, cutting/regrowing trees, or moving walls makes every baked file stale — re-bake as a
  build step. All bake commands must be `IsInToolsMode()`/`FCVAR_CHEAT` gated (`io.open`/
  `InitLogFile`/console commands don't exist on a published server). `anggrid` stores `-1` for
  corners/spikes — runtime **must** branch on `angle ~= -1` or rotating by `-1°` flings units.
  `GridNav` traversability changes with temp trees/buildings; bake static terrain, track
  dynamic blockers separately.
- **Navmesh → Panorama (§3.3, §3.4).** Screen-space particle grids are expensive — cull
  off-screen quads, re-seed only newly exposed cells, remap only past a threshold; never full
  rebuild per frame. Minimap projection depends on the *measured* `actuallayoutwidth`, unset at
  load — read it lazily, not in manifest-level JS. Keep the RLE length guard.
- **Procedural generation (§4).** The corridor guarantee holds only if the carve runs to
  completion and you plant **only** still-`true` cells. `while x < fLength + 1` over-runs the
  edge so the corridor exits. Staggered planting means traps aren't present at t=0 — don't start
  the round timer until planting completes.
- **Competitive systems (§5).** `SetBaseMoveSpeed` is overwritten by anything else that sets
  base speed — run the rubber-band pass *after* other speed logic, or use a modifier property.
  Track-progress assumes ordered crossings and a maintained `waypoints[i][w]`; a skipped
  checkpoint corrupts the scalar. The charger's exact `Vector(0,0,0)` stuck check should be
  `(last - cur):Length() < 1` in production to tolerate float jitter.
- **Bot AI (§6).** Every action runs inside `xpcall` — a raw error in `SetContextThink`
  silently stops the entity forever. The shared blackboard needs a write-then-read ordering per
  tick. Potential-field dodging is O(projectiles) ×3 — throttle the think interval and gate by
  range/cone.
- **Backend security (§7).** Everything depends on `IsDedicatedServer()` —
  `GetDedicatedServerKeyV2/V3` is useless on `dota2.exe`; sign/run-sessions/download-UGC only
  when true, with a no-op path for local testing. HMAC canonicalization must be **identical**
  on both ends (same key order, `tostring`, secret concat) or you get silent 401s. The spoof
  token is **not** a secret — it stops *cross-client* injection, not self-tampering; still
  validate inputs server-side. Spectators (PlayerID -1) can't register a key — handle `nil`.
  Client `loadstring` (§7.4): run only behind an auth check inside `xpcall`; the client cipher
  key is a decoy.
- **Dev tooling (§8).** `debug.sethook(fn, "l")` fires on **every line** — it slows the VM and
  allocates; use short targeted captures, keep it `IsInToolsMode()`-gated, never leave it on in
  a match. Sandbox precache: pass `0` (or owner) to `PrecacheUnitByNameAsync` or custom skins
  show error models; precache heroes **sequentially** to avoid a load spike. The cheat flag is
  one-way — mark the run leaderboard-ineligible once `-cheats` is seen, skip in tools mode.
