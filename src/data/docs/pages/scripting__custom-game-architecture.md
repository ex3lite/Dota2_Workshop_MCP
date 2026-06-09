# Custom Game Architecture & Systems Patterns

Server-side (Lua / VScript) architecture for Dota 2 custom games, distilled from 18 shipping
games. Focus is the **server brain**: state machine, spawning, economy, progression,
modifiers, networking to Panorama, AI, and project structure. Source games are cited inline
(Guarding Athena = *Athena*, Dota IMBA = *IMBA*, Pudge Wars = *PudgeWars*, Dota 2 Horde Mode
= *Horde*). All code is copy-paste oriented; trim to your addon's conventions.

---

## 1. Project Structure & Module Loading

### 1.1 The `addon_game_mode.lua` entry points

Every addon ships exactly three engine entry points. Keep them thin and delegate to a
bootstrap.

```lua
-- scripts/vscripts/addon_game_mode.lua
require("enums")
require("libraries/built_in_modifier")
require("kv")            -- loads & caches all KeyValues into _G.KeyValues.*
require("abilities/init")
require("modifiers/init")

-- Called ONCE before the map loads. Link every Lua modifier + precache here.
function Precache(context)
    local list = require("precache")
    for mode, resources in pairs(list) do
        for _, res in pairs(resources) do PrecacheResource(mode, res, context) end
    end
    for name in pairs(KeyValues.UnitsKv) do
        if name ~= "Version" then PrecacheUnitByNameSync(name, context) end
    end
end

-- Called when the game mode activates. Instantiate your framework.
function Activate()
    Initialize(false)   -- false = not a hot-reload
end
```

*IMBA* does its bulk `LinkLuaModifier` (buyback penalty, command-restricted, war-veteran
talent tiers, roshan AI, illusion bonuses) inside `Precache`, then instantiates
`GameMode()` / `InitGameMode()` in `Activate`. Link modifiers **before** any unit that uses
them can spawn.

### 1.2 Class-based singleton modules with hot-reload (Athena)

The single most reusable Lua pattern: every system is a class-singleton guarded by `if X ==
nil`, with an `init(bReload)` that seeds state only on a cold start and (re)binds events
every time. This makes `script_reload` in-tools instant.

```lua
-- mechanics/player_data.lua
if PlayerData == nil then
    PlayerData = class({})
end
local public = PlayerData

function public:init(bReload)
    if not bReload then
        self.tPlayerData = {}          -- only seed state on a cold load
    end
    -- (re)bind listeners every init, even on reload:
    GameEvent("game_rules_state_change", Dynamic_Wrap(public, "OnGameRulesStateChange"), public)
    CustomUIEvent("item_purchase",       Dynamic_Wrap(public, "OnItemPurchase"),        public)
end

return public
```

### 1.3 The `Require` loader + event-wrapper globals (Athena)

A central `Require` table maps a global name to a module path, requires it, stashes it in
`_G`, and calls `:init(bReload)`. It also exposes thin wrappers (`GameEvent`,
`CustomUIEvent`, `TimerEvent`) so individual modules never touch Valve's raw listener APIs —
and every listener ID is tracked so a reload can unbind cleanly.

```lua
function Require(requireList, bReload)
    for globalName, path in pairs(requireList) do
        local t = require(path)
        if type(t) == "table" then
            _G[globalName] = t
            if t.init then t:init(bReload) end
        end
    end
end

function Initialize(bReload)
    _G.CustomUIEventListenerIDs = {}
    _G.GameEventListenerIDs     = {}
    Require({ Request = "libraries/request" },               bReload)
    Require({ Settings = "settings", Game = "game" },        bReload)
    Require({ Mechanics = "mechanics/main" },                bReload)
end

-- Wrapper: register a client->server custom event, tracking the listener id.
function CustomUIEvent(eventName, func, context)
    table.insert(CustomUIEventListenerIDs, CustomGameEventManager:RegisterListener(eventName,
        function(...) return context and func(context, ...) or func(...) end))
end
_G.CustomUIEvent = CustomUIEvent

function GameEvent(eventName, func, context)
    table.insert(GameEventListenerIDs, ListenToGameEvent(eventName, func, context))
end
_G.GameEvent = GameEvent
```

**When to use:** any game with more than a handful of systems. The class-singleton +
`Require` + wrapper trio scales to dozens of modules and gives you free hot-reload.

### 1.4 Common library set (use these, don't reinvent)

| Library | Source | Purpose |
|---|---|---|
| **Timers** (BMD) | PudgeWars `lib/timers.lua` | `Timers:CreateTimer(delay, cb)`; return a number from `cb` to re-loop; `useGameTime` respects pauses. One `SetContextThink` at `0.01s`. |
| **Notifications** (BMD) | Horde `barebones_notifications` | Server->client toast bus (top/bottom, rich icon pieces). |
| **Physics** (BMD) | PudgeWars `physics.lua` | Projectile/unit motion with `HALT/SLIDE/BOUNCE` nav modes. |
| **json / dkjson** | all | Encode/decode for net tables + HTTP. |
| **md5** | Athena, PudgeWars | Sign save-codes / HTTP payloads. |
| **statcollection** | Horde | Drop-in analytics HTTP backend. |

```lua
-- Canonical BMD timer usage (PudgeWars/Horde):
Timers:CreateTimer(function()
    DoSlowThink()
    return 1.0          -- re-run in 1s; return nil/nothing to stop
end)
```

---

## 2. Game-State Machine & Flow

### 2.1 `game_rules_state_change` as the central dispatcher

Every game routes its lifecycle through one handler keyed on `GameRules:State_Get()`. This
is *the* flow backbone.

```lua
-- game.lua  (Athena/PudgeWars/Horde all use this shape)
function GameMode:OnGameRulesStateChange()
    local state = GameRules:State_Get()

    if state == DOTA_GAMERULES_STATE_HERO_SELECTION then
        self:SpawnAthena()                       -- create the base unit to defend
    elseif state == DOTA_GAMERULES_STATE_PRE_GAME then
        self:TallyDifficultyVotes()              -- resolve lobby votes
        self:GrantStartingGold()
    elseif state == DOTA_GAMERULES_STATE_GAME_IN_PROGRESS then
        self:StartThinkLoops()                   -- per-second + per-minute ticks
    end
end
```

### 2.2 Per-second / per-minute think loops with custom events

*Athena* drives global ticking by firing a custom game event and a modifier event every
second, letting any modifier opt in via `MODIFIER_EVENT_ON_TICK_TIME` without polling.

```lua
function GameMode:StartThinkLoops()
    local sec = 0
    Timers:CreateTimer(function()
        sec = sec + 1
        FireGameEvent("custom_time_event", { time = sec })
        -- broadcast a modifier event to every opted-in modifier:
        GameRules:GetGameModeEntity():FireModifierEvent(MODIFIER_EVENT_ON_TICK_TIME)
        if sec % 60 == 0 then self:OnMinuteTick(sec / 60) end
        return 1.0
    end)
end
```

### 2.3 GameRules configuration (PudgeWars `InitGameMode`)

Set every rule up-front in one place; register filters and the state listener here too.

```lua
function PudgeWarsMode:InitGameMode()
    GameRules:SetCustomGameTeamMaxPlayers(DOTA_TEAM_GOODGUYS, 5)
    GameRules:SetHeroSelectionTime(0)
    GameRules:SetPreGameTime(15)
    GameRules:SetUseUniversalShopMode(true)

    local mode = GameRules:GetGameModeEntity()
    mode:SetExecuteOrderFilter(Dynamic_Wrap(self, "OrderFilter"), self)
    mode:SetDamageFilter(Dynamic_Wrap(self, "DamageFilter"), self)
    ListenToGameEvent("game_rules_state_change",
        Dynamic_Wrap(self, "OnGameRulesStateChange"), self)
    ListenToGameEvent("npc_spawned", Dynamic_Wrap(self, "OnNPCSpawned"), self)
end
```

**When to use:** always. Even a tiny mode benefits from the state-change dispatcher; the
think-loop + custom-event broadcast pays off the moment you have multiple systems that need
"every second."

---

## 3. Wave / Round Spawning

Two distinct architectures appear, pick by genre.

### 3.1 KV-data-driven round pipeline (Athena) — for discrete waves

`Rounds` (manager) → `CRound` (one round, owns spawners + remaining-enemy tracking) →
`CSpawner` (one enemy group) → `CWeightPool` (weighted random selection). Round groups are
encoded as `"groupA#weight|groupB#weight"` strings and resolved via the weight pool.

```lua
-- class/round.lua  (constructor parses the weighted spawner-group string)
function CRound:constructor(iRoundNumber, params, hExternal)
    self.tSpawners = {}
    local groupId = params.SpawnerGroupID            -- e.g. "easy#3|hard#1"
    if groupId and groupId ~= "" then
        local pool = CWeightPool({})
        for _, s in pairs(string.split(string.gsub(groupId, " ", ""), "|")) do
            local a = string.split(s, "#")           -- {"easy","3"}
            pool:Add(a[1], tonumber(a[2]) or 1)
        end
        local chosen = pool:Random()
        local data = KeyValues.SpawnerGroupKvs[chosen]
        for k, v in pairs(data) do
            if type(v) == "table" and v.NPCName then
                self.tSpawners[k] = CSpawner(k, v, self)
            end
        end
    end
    self.bTimedRound        = tonumber(params.TimedRound or 0) ~= 0
    self.fPrepareRoundTime  = tonumber(params.PrepareRoundTime or 0)
end
```

Track remaining enemies by subscribing to engine events **per round**, then advance when the
count hits zero:

```lua
function CRound:Begin()
    self.tEnemiesRemaining = {}
    self.tListeners = {
        ListenToGameEvent("npc_spawned",   Dynamic_Wrap(self, "OnNPCSpawned"),  self),
        ListenToGameEvent("entity_killed", Dynamic_Wrap(self, "OnEntityKilled"), self),
    }
end

function CRound:OnEntityKilled(keys)
    -- prune dead/invalid units, then check for round completion:
    if self:GetEnemiesRemainingUnits() == 0 then
        self.hExternal:NextRound()
    end
    CustomNetTables:SetTableValue("common", "round_data", self:GetNetTableData())
end
```

### 3.2 Time-curve scheduler (Horde) — for continuous, time-based waves

*Horde* never counts kills; it derives wave start/end/boss times from constants and spawns
off `GameRules` time. Decouples the difficulty curve from spawn tables.

```lua
-- spawners.lua
local waveZeroDuration, waveDuration, wavePause = 180, 270, 30

function waveStart(n)
    if n == 0 then return 0 end
    return waveZeroDuration + wavePause + (waveDuration + wavePause) * (n - 1)
end
function waveEnd(n)   return n == 0 and waveZeroDuration or waveStart(n) + waveDuration end
function waveBoss(n)  return waveEnd(n) - 60 end   -- boss 60s before wave end

function Spawners:StartSpawners(difficulty, players, mapInfo)
    for n, wave in pairs(spawns.Waves) do
        local chosen = fetchRandomItem(wave.Options)   -- random variant per wave
        if chosen.boss_unit then
            Spawners:SpawnBoss(chosen.boss_unit, n, difficulty, players, mapInfo)
        end
        -- schedule lane spawns at waveStart(n) ... waveEnd(n)
    end
end
```

### 3.3 Generic difficulty/player-count scaling spawner (Horde)

The `SpawnTimer` returns its own interval to re-loop and scales each creep by player count
and difficulty, randomly granting auras at higher tiers.

```lua
-- libraries/spawners.lua
function Spawners:Spawn(unitName, count, difficulty, players, spawnerEnt, dest)
    for i = 1, count do
        local u = CreateUnitByName(unitName, spawnerEnt:GetAbsOrigin(), true, nil, nil,
                                   DOTA_TEAM_BADGUYS)
        u:SetMaxHealth(u:GetMaxHealth() * (1 + 0.25 * players) * 1.5 ^ difficulty)
        u:SetBaseDamageMin(math.floor(u:GetBaseDamageMin() * 1.5 ^ difficulty))
        if difficulty >= 2 and RandomInt(1, 4) == 1 then
            u:AddNewModifier(u, nil, "modifier_aura_frenzy", nil)
        end
        u:SetInitialGoalEntity(dest)        -- send it down the lane
    end
end

function Spawners:SpawnTimer(interval, ...)
    Timers:CreateTimer(function()
        self:Spawn(...)
        return interval                      -- loop; return nil after 'finish' to stop
    end)
end
```

**Time-curve escalation (Horde HoardBRS):** a 14s ticking timer maps elapsed minutes →
"how many random abilities and what level" via `timeList.kv`; creeps pull random hero
abilities from categorized pools the first time they cross a trigger, flagged once by a
hidden `modifier_brs_boosted` so they're never re-buffed. Tune one KV table to reshape the
whole late game.

**When to use:** §3.1 for discrete "clear the wave to advance" TDs; §3.2/§3.3 for endless
or timed survival where pressure is continuous.

---

## 4. Economy: Currencies, Shops, Persistence

### 4.1 Multi-currency player data with debounced net-table sync (Athena)

`PlayerData` holds gold / crystal (魂晶) / score (荣誉). Every setter re-pushes the row, but
the push is **debounced per frame** so several same-frame mutations collapse to one network
write — no explicit dirty flags.

```lua
-- mechanics/player_data.lua
function PlayerData:SetGold(id, v)
    local d = self.tPlayerData[id]; if type(d) ~= "table" then return end
    d.iGold = v
    self:UpdateNetTables(id)
end
function PlayerData:ModifyGold(id, delta) self:SetGold(id, self:GetGold(id) + delta) end

-- Frame-count-keyed debounce: many setters in one frame -> a single SetTableValue.
function PlayerData:UpdateNetTables(id)
    local key = "PlayerDataUpdateNetTables" .. id .. "_" .. GetFrameCount()
    if self.tPlayerData[id][key] == nil then
        self.tPlayerData[id][key] = true
        Timer(key, 0, function()                 -- 0-delay timer = end of frame
            self.tPlayerData[id][key] = nil
            CustomNetTables:SetTableValue("player_data", tostring(id), self.tPlayerData[id])
        end)
    end
end
```

This idiom is worth copying for **any** frequently-mutated shared state (gold+crystal+score
from one kill = one write instead of three).

### 4.2 Bounty on kill (Athena `OnEntityKilled`)

Grant currencies + XP with per-player multipliers from the central kill handler.

```lua
function GameMode:OnEntityKilled(keys)
    local killed  = EntIndexToHScript(keys.entindex_killed)
    local killerP = killed:GetKillRewardPlayerID and killed:GetKillRewardPlayerID()
    if not killed:IsRealHero() and PlayerResource:IsValidPlayerID(killerP) then
        local mult = 1 + PlayerData:GetGoldBonus(killerP)
        PlayerData:ModifyGold(killerP,    math.floor(killed.iGoldBounty    * mult))
        PlayerData:ModifyCrystal(killerP, math.floor(killed.iCrystalBounty * mult))
        PlayerData:ModifyScore(killerP,   killed.iScoreBounty or 0)
    end
end
```

### 4.3 Purchases routed through one custom event (Athena)

Both shop economies funnel through `item_purchase` / `sell_item` custom UI events; the server
validates cost against the right currency and consumes recipes/accessories.

```lua
function PlayerData:OnItemPurchase(data)
    local id   = data.PlayerID
    local kv   = KeyValues.ItemsKv[data.item_name]
    local cost = tonumber(kv.GoldCost or 0)
    local cur  = kv.Currency or "gold"           -- "gold" | "crystal" | "score"
    if self:Get(cur, id) < cost then
        Notification:Error(id, "#error_not_enough"); return
    end
    self:Modify(cur, id, -cost)
    local hero = PlayerResource:GetSelectedHeroEntity(id)
    hero:AddItemByName(data.item_name)
end
```

### 4.4 Persistence: HTTP backend keyed on SteamID (PudgeWars / IMBA / Horde)

The strongly preferred alternative to fragile save-codes. State lives in a web service; the
client never sees credentials. The server authenticates with `GetDedicatedServerKeyV2`.

```lua
-- components/api/init.lua  (PudgeWars / IMBA)
function api:Request(endpoint, okCb, failCb, method, payload)
    method = method or "GET"
    local req = CreateHTTPRequestScriptVM(method, baseUrl .. endpoint)
    req:SetHTTPRequestAbsoluteTimeoutMS(5000)

    local key = IsDedicatedServer() and GetDedicatedServerKeyV2("2")
              or LoadKeyValues("scripts/vscripts/components/api/backend_key.kv").server_key
    req:SetHTTPRequestHeaderValue("X-Dota-Server-Key", key)

    -- Hand the key to clients so THEY can call the REST API directly (see §6.4):
    CustomNetTables:SetTableValue("game_options", "server_key", { key })

    if payload then req:SetHTTPRequestRawPostBody("application/json", json.encode(payload)) end

    req:Send(function(result)
        local code = result.StatusCode
        if code == 0    then return failCb("timeout") end
        if code >= 500  then return failCb("server error") end
        if code == 204  then return okCb() end
        local obj = json.decode(result.Body)
        if obj and obj.error == false then return okCb(obj.data) else return failCb() end
    end)
end

-- Save/load is just stateless HTTP keyed on steamid:
function api:RegisterGame(cb)    -- on game start: pull donator/xp/cosmetics per steamid
    self:Request("game-register", cb, nil, "POST",
        { map = GetMapName(), steamids = self:CollectSteamIDs() })
end
function api:CompleteGame()      -- on game end: POST the whole match
    self:Request("game-complete", nil, nil, "POST", self:BuildMatchPayload())
end
```

**Anti-cheat gate (PudgeWars):** `api:CheatDetector` flips a `game_count` net-table flag to
`0` and fires `safe_to_leave` so cheated games aren't recorded — all enforced server-side.

### 4.5 Save-codes / external RPC: the coroutine service-event router (Athena)

When you do want client-driven backend calls (save codes, payments, persistence), *Athena*
exposes a named service-event router. Handlers run inside `coroutine.wrap` + `xpcall`, so a
handler can `yield` on `CreateHTTPRequest` and crashes are isolated. Replies match a
client-supplied `queueIndex` (this is request/response RPC over one-way events).

```lua
-- libraries/request.lua
function Request:Event(name, func, context)            -- register a handler
    self.tEvents[name] = { callback = func, context = context }
end

function Request:ServiceEventsRequest(_, tData)
    local hPlayer = PlayerResource:GetPlayer(tData.PlayerID); if not hPlayer then return end
    local entry = self.tEvents[tData.event];               if not entry  then return end
    local data  = json.decode(tData.data)

    coroutine.wrap(function()
        xpcall(function()
            data.PlayerID = tData.PlayerID
            local result = entry.context and entry.callback(entry.context, data)
                                          or  entry.callback(data)
            if tData._IsServer ~= true and type(result) == "table" then
                CustomGameEventManager:Send_ServerToPlayer(hPlayer, "service_events_res",
                    { result = json.encode(result), queueIndex = tData.queueIndex })
            end
        end, function() print("[Request] error: " .. debug.traceback()) end)
    end)()
end
```

**When to use HTTP vs save-codes:** prefer HTTP (§4.4) whenever you control a server — it
avoids client-tamperable codes and supports leaderboards/anti-cheat. Use the coroutine
router (§4.5) when you need client-initiated, yielding round-trips (payments, opening a
treasure that hits a backend).

---

## 5. Talent / Upgrade / Progression

### 5.1 Ability-point upgrade tree via a stacking modifier (PudgeWars)

Upgrade abilities are spammable; each `OnUpgrade` decrements a `modifier_ability_points`
stack and auto-closes the menu at zero.

```lua
-- abilities/pudge_upgrades.lua
pudge_wars_upgrade_hook_damage = class({})
function pudge_wars_upgrade_hook_damage:OnUpgrade() SpendAbilityPoint(self:GetCaster()) end

function SpendAbilityPoint(hero)
    local mod = hero:FindModifierByName("modifier_ability_points")
    if not mod then return end
    mod:SetStackCount(hero:GetAbilityPoints() - 1)
    if mod:GetStackCount() == 0 then
        hero:FindAbilityByName("pudge_wars_abilities_down"):CastAbility()  -- close menu
    end
end
```

### 5.2 Roguelike "draw 3, pick 1" upgrade engine (Athena)

On level/reborn milestones the server draws a rarity from a weighted pool, builds 3
candidate cards (filtered by prerequisites / max-count / unit), and publishes them to a
per-unit net-table key. The UI sends the choice back; unselected draws are stashed.

```lua
-- mechanics/ability_upgrades.lua  (sketch of DrawAbilityUpgrades)
function AbilityUpgrades:DrawAbilityUpgrades(hUnit, n)
    local rarity     = self.RarityPool:Random()                 -- weighted
    local candidates = self:FilterEligible(hUnit, rarity)       -- prereq/max/unit checks
    local draw = {}
    for i = 1, math.min(n or 3, #candidates) do
        table.insert(draw, table.remove(candidates, RandomInt(1, #candidates)))
    end
    CustomNetTables:SetTableValue("ability_upgrades_selection",
        tostring(hUnit:entindex()), { cards = draw })
end
```

### 5.3 The 5-op upgrade math + column-zip compression (Athena)

Upgrades support `SPECIAL_VALUE`, `SPECIAL_VALUE_PROPERTY`, `STATS`, `ABILITY_MECHANICS`,
and `ADD_ABILITY`. Results are precomputed and cached per unit. The accumulation rule is
always `(base + add) * (1 + mul%)`:

```lua
function AbilityUpgrades:CalcSpecialValue(hUnit, ability, name)
    local base = self:GetCachedBase(hUnit, ability, name)
    local add  = self:GetSpecialValueUpgrade(hUnit, ability, name, ABILITY_UPGRADES_OP_ADD)
    local mul  = self:GetSpecialValueUpgrade(hUnit, ability, name, ABILITY_UPGRADES_OP_MUL)
    return (base + add) * (1 + mul * 0.01)
end
```

Net tables have a hard size budget. Before sending a growing upgrade list, Athena emits a
**column-oriented "zip"**: one header row of field names, then value-only rows, then
json-encodes and replaces the largest literal `"null"` with `"*"`. Clients reconstruct by
zipping header→values.

```lua
function AbilityUpgrades:zip(tData)
    local T = { [1] = zip_list }                 -- header row of field names
    for _, v in pairs(tData) do
        local row = {}
        for i = 1, #zip_list do row[i] = v[zip_list[i]] end   -- value-only row
        table.insert(T, row)
    end
    return T
end
-- caller:
local str = json.encode(self:zip(tUpgrades))
str = string.gsub(str, "null", "*")              -- trim the biggest literal
CustomNetTables:SetTableValue("ability_upgrades_result", tostring(id), { json = str })
```

### 5.4 Prestige / reborn loop (Athena 转生)

Leveling far past 100 via a "reborn" loop: a teleport-to-reborn quest, model-skin swap, and
a stacking `modifier_reborn`. Each reborn resets level but adds a permanent stack granting
bonuses — the classic prestige attractor.

### 5.5 Persistent meta-progression (IMBA / PudgeWars)

Per-player XP, an IMR/MMR rank, and battlepass levels are fetched on game start
(`RegisterGame`) and posted on game end (`CompleteGame`), all keyed on steamid against the
external backend (§4.4). The end screen reads the deltas and animates XP-gain bars.

**When to use:** §5.1 for simple "spend points" trees; §5.2/§5.3 for roguelike runs;
§5.4/§5.5 for cross-game persistence.

---

## 6. Networking to UI (CustomNetTables + CustomGameEventManager)

Two channels, two purposes:
- **CustomNetTables** — *durable shared state* the UI reads/subscribes (player_data,
  round_data, hero_selection). Survives reconnects.
- **CustomGameEventManager** — *transient one-shot messages* (toasts, "play this animation").
  Fire-and-forget.

### 6.1 Server → client state via net tables

```lua
-- Server: publish a row. Key it by player id or entindex (as a STRING).
CustomNetTables:SetTableValue("player_data", tostring(playerID), {
    iGold = 1500, iCrystal = 30, iScore = 12,
})
```

```js
// Client: prime-then-subscribe (the standard IMBA helper)
function SubscribeToNetTableKey(table, key, cb) {
    var v = CustomNetTables.GetTableValue(table, key);
    if (v != null) cb(v);                          // prime with current value
    CustomNetTables.SubscribeNetTableListener(table, function (_t, k, val) {
        if (k === key && val != null) cb(val);     // then react to changes
    });
}
SubscribeToNetTableKey("player_data", String(Players.GetLocalPlayer()), UpdateGoldHud);
```

### 6.2 Server → client one-shot events (toasts) — Athena/Horde

```lua
-- Server: send a rich notification to one player or everyone.
CustomGameEventManager:Send_ServerToPlayer(hPlayer, "notification_combat", {
    message = "{s:player_name} slew {s:victim}!", player_name = name, victim = victim,
})
-- Horde-style top/bottom toast:
CustomGameEventManager:Send_ServerToAllClients("top_notification",
    { text = "#round_incoming", duration = 4, hero = "npc_dota_hero_axe" })
```

```js
// Client: bind handlers in a module IIFE (Horde barebones_notifications)
(function () {
    GameEvents.Subscribe("top_notification",    TopNotification);
    GameEvents.Subscribe("notification_combat", CombatToast);
})();
```

### 6.3 Client → server with RPC correlation ids (IMBA)

Dota's `SendCustomGameEventToServer` is one-way. Wrap it with an incrementing id +
auto-unsubscribe to get promise-like round-trips.

```js
// createEventRequestCreator — turns fire-and-forget into request/response
var idCounter = 0;
function requestServer(eventName, data, callback) {
    var id = ++idCounter;
    data.id = id;
    GameEvents.SendCustomGameEventToServer(eventName, data);
    var l = GameEvents.Subscribe(eventName, function (d) {
        if (d.id !== id) return;          // ignore replies for other calls
        GameEvents.Unsubscribe(l);        // tear down immediately — no leak
        callback(d);
    });
}
```

### 6.4 Net-table-delivered server key as an HTTP auth token (IMBA / PudgeWars)

The clever decoupling: the sandboxed client has no secrets, but the Lua server pushes a
per-server key over a net table; the client then calls the REST backend directly.

```js
var secret_key = CustomNetTables.GetTableValue("game_options", "server_key")["1"];
$.AsyncWebRequest(api.base + "modifyCompanion", {
    type: "POST", dataType: "json", data: data, timeout: 5000,
    headers: { "X-Dota-Server-Key": secret_key },
    success: onOk, error: onErr,
});
```

### 6.5 Pre-baked KV → JS modules (Athena)

Tooltips/costs/icons read locally without round-trips: server KeyValues (items, abilities,
upgrades, shops, tasks) are pre-generated into `panorama/scripts/custom_game/kv/*.js`
(e.g. `itemskv.js`, `shopskv.js`). The UI imports these lookup tables directly.

### 6.6 Transient lobby votes need NO net table (Horde)

For ephemeral pre-game options, plain custom events suffice: radio button →
`SendCustomGameEventToServer("setting_vote", …)` → server `VoteTable` → `ProcessVotes()`
with random tie-break → `Send_ServerToAllClients("info_difficulty")`.

```lua
-- internal/events.lua
CustomGameEventManager:RegisterListener("setting_vote", function(_, data)
    VoteTable[data.PlayerID] = data.vote
end)
function ProcessVotes()
    local tally = {}
    for _, v in pairs(VoteTable) do tally[v] = (tally[v] or 0) + 1 end
    -- pick max, random tie-break, then:
    CustomGameEventManager:Send_ServerToAllClients("info_difficulty", { difficulty = winner })
end
```

**Donator-weighted voting (PudgeWars):** votes carry a weight from a donator list; the tally
picks highest weight and resolves ties with `math.random`, then applies via
`api:SetCustomGamemode`.

---

## 7. Custom Modifier / Ability Conventions

### 7.1 Ability + intrinsic modifier pairing (IMBA — the fundamental block)

Every custom passive is an ability that declares an intrinsic modifier; the modifier
implements `DeclareFunctions` + `GetModifier*` property hooks. One file, both classes.

```lua
-- components/abilities/courier.lua
courier_movespeed = class({})
function courier_movespeed:GetIntrinsicModifierName() return "modifier_courier_hack" end

LinkLuaModifier("modifier_courier_hack", "components/abilities/courier", LUA_MODIFIER_MOTION_NONE)

modifier_courier_hack = class({})
function modifier_courier_hack:IsHidden()       return true  end
function modifier_courier_hack:IsPurgable()     return false end
function modifier_courier_hack:RemoveOnDeath()  return false end

function modifier_courier_hack:DeclareFunctions()
    return { MODIFIER_PROPERTY_MOVESPEED_ABSOLUTE }
end
function modifier_courier_hack:GetModifierMoveSpeed_Absolute()
    return self:GetAbility():GetSpecialValueFor(
        self:GetParent():HasFlyMovementCapability() and "flying_movespeed" or "ground_movespeed")
end
```

### 7.2 Server-authoritative active spell guarded by `IsServer()` (IMBA)

Read `AbilitySpecials` with `GetSpecialValueFor`, emit sound/particles, find units, apply
effects — with `IsServer()` separating authoritative logic from prediction-safe code.

```lua
function my_nuke:OnSpellStart()
    if not IsServer() then return end
    local caster, point = self:GetCaster(), self:GetCursorPosition()
    local radius = self:GetSpecialValueFor("radius")
    EmitSoundOn("Hero_Lina.LightStrikeArray", caster)
    local fx = ParticleManager:CreateParticle("particles/units/.../blast.vpcf",
                                              PATTACH_WORLDORIGIN, caster)
    ParticleManager:SetParticleControl(fx, 0, point)
    ParticleManager:ReleaseParticleIndex(fx)
    local units = FindUnitsInRadius(caster:GetTeamNumber(), point, nil, radius,
        DOTA_UNIT_TARGET_TEAM_ENEMY, DOTA_UNIT_TARGET_HERO + DOTA_UNIT_TARGET_BASIC,
        DOTA_UNIT_TARGET_FLAG_NONE, FIND_ANY_ORDER, false)
    for _, u in pairs(units) do
        ApplyDamage({ victim = u, attacker = caster, damage = self:GetSpecialValueFor("damage"),
                      damage_type = DAMAGE_TYPE_MAGICAL, ability = self })
    end
end
```

### 7.3 Tiered modifiers from one file via name suffix (IMBA)

`modifier_imba_war_veteran` is linked three times (`_0`/`_1`/`_2`) to represent escalating
talent tiers that share code but differ by suffix.

```lua
for tier = 0, 2 do
    LinkLuaModifier("modifier_imba_war_veteran_" .. tier,
        "modifiers/modifier_war_veteran", LUA_MODIFIER_MOTION_NONE)
end
```

### 7.4 Time-scaling creep modifier (IMBA)

An innate ability (`IsInnateAbility`) attaches a modifier whose stack count =
`floor(GetDOTATime / 60)`, applying escalating multipliers per minute; `string.find` on the
unit name gives bigger multipliers to "upgraded"/"mega" creeps.

```lua
function modifier_custom_creep_scaling:OnIntervalThink()
    local minutes = math.floor(GameRules:GetDOTATime(false, false) / 60)
    self:SetStackCount(minutes)
end
function modifier_custom_creep_scaling:GetModifierHealthBonus()
    local per = string.find(self:GetParent():GetUnitName(), "mega") and 80 or 30
    return self:GetStackCount() * per
end
```

### 7.5 Linear projectile with wearable hide (PudgeWars hook)

The core hook fires a linear projectile, hides the offhand wearable with `EF_NODRAW`, and on
hit applies a slow modifier + magical damage.

```lua
function pudge_wars_cleaver:OnSpellStart()
    self.wearable:AddEffects(EF_NODRAW)            -- hide cleaver model in flight
    ProjectileManager:CreateLinearProjectile({
        Ability = self, Source = self:GetCaster(),
        vSpawnOrigin = self:GetCaster():GetAbsOrigin(),
        vVelocity = direction * self:GetSpecialValueFor("speed"),
        fDistance = self:GetSpecialValueFor("range"),
        fStartRadius = 100, fEndRadius = 100,
        EffectName = "particles/.../meat_hook.vpcf",
    })
end
function pudge_wars_cleaver:OnProjectileHit(target, loc)
    if target then
        self.wearable:RemoveEffects(EF_NODRAW)
        target:AddNewModifier(self:GetCaster(), self, "modifier_pudge_slow", { duration = 2 })
        ApplyDamage({ victim = target, attacker = self:GetCaster(), ability = self,
                      damage = self:GetSpecialValueFor("damage"), damage_type = DAMAGE_TYPE_MAGICAL })
    end
end
```

### 7.6 Vanilla-baseclass inheritance (IMBA)

Heroes derive abilities from `class(VANILLA_ABILITIES_BASECLASS)` to keep original behavior,
and bulk-register modifiers via `MergeTables` into a `LinkedModifiers` table.

```lua
imba_axe_berserkers_call = class(VANILLA_ABILITIES_BASECLASS)
local LinkedModifiers = {}
MergeTables(LinkedModifiers, { modifier_imba_call = LUA_MODIFIER_MOTION_NONE, ... })
for name, motion in pairs(LinkedModifiers) do
    LinkLuaModifier(name, "components/abilities/heroes/hero_axe", motion)
end
```

---

## 8. AI

### 8.1 Per-hero AI modules (Athena `ai/heroes/*.lua`)

*Athena*'s allied/summoned heroes are auto-piloted by per-hero scripts (antimage, lina,
nevermore, …) — an AI "brain" modifier attached on spawn that decides cast/move on an
interval.

```lua
-- modifier_ai_brain : OnIntervalThink (attached to AI-controlled units)
function modifier_ai_brain:OnIntervalThink()
    local me = self:GetParent()
    if not me:IsAlive() then return end
    local enemy = self:AcquireTarget()                       -- nearest valid enemy
    if not enemy then
        ExecuteOrderFromTable({ UnitIndex = me:entindex(),
            OrderType = DOTA_UNIT_ORDER_MOVE_TO_POSITION, Position = self.defendPos })
        return
    end
    local ability = self:PickAbility(enemy)                  -- mana/cd/range checks
    if ability then
        ExecuteOrderFromTable({ UnitIndex = me:entindex(),
            OrderType = DOTA_UNIT_ORDER_CAST_TARGET,
            AbilityIndex = ability:entindex(), TargetIndex = enemy:entindex() })
    else
        me:MoveToTargetToAttack(enemy)
    end
end
```

### 8.2 Creep pathing to objective (Horde)

Spawned enemies are simply pointed at the lane goal; the engine handles navigation.

```lua
unit:SetInitialGoalEntity(laneDestinationEnt)   -- creeps walk toward the Ancient/base
```

### 8.3 Boss AI as a modifier (IMBA leveling Roshan)

The leveling Roshan boss carries an AI modifier (linked in `Precache`) plus a top-screen HP
bar fed from a `game_options/roshan` net table. Boss logic (level scaling, ability rotation)
lives in `OnIntervalThink` exactly like §8.1, but the bar auto-deletes on maps where it
shouldn't appear.

**When to use:** §8.1 for allied auto-heroes/summons; §8.2 for lane creeps (cheapest);
§8.3 for bosses needing scripted phases.

---

## 9. Pitfalls

- **`CustomNetTables` keys are stringly typed.** Always
  `tostring(playerID)` / `tostring(entindex)` on write, and read with the string (`["1"]`).
  Mismatched int vs string keys silently fail to match.
- **Net tables have a hard size budget.** A growing roguelike upgrade list will overflow.
  Use Athena's column-zip + `null→"*"` (§5.3), or split across multiple keys. Don't push
  giant blobs every frame.
- **Chatty setters cause network churn.** Don't `SetTableValue` on every field mutation —
  debounce per frame (§4.1). Three currency writes from one kill should be one push.
- **Modifiers must be `LinkLuaModifier`'d before any user spawns**, ideally in `Precache`.
  A unit spawned with an unlinked modifier silently has no modifier.
- **`GetSpecialValueFor` outside an ability context returns 0.** It needs a real ability
  handle; on a modifier use `self:GetAbility():GetSpecialValueFor(...)`, and the special
  must exist in the KV `AbilitySpecials`.
- **Guard authoritative logic with `IsServer()`.** Damage/particles/units created on the
  client desync or error. Prediction code runs on both; effects must be server-only.
- **`Send_ServerToPlayer` needs a player handle, not an id.** Use
  `PlayerResource:GetPlayer(id)`; it returns nil for disconnected players — null-check it
  (Athena's router returns early when `hPlayer == nil`).
- **RPC listeners leak if you never unsubscribe.** The IMBA correlation-id helper (§6.3)
  *must* `GameEvents.Unsubscribe(l)` on the matching reply, or each call piles up a dead
  listener.
- **Panorama v8 closures capture loop vars by reference.** Wiring `onactivate` inside a
  `for` loop binds the *last* value to every panel. Wrap the handler in an IIFE that
  captures by value (PudgeWars notes this explicitly for companion/vote buttons).
- **`$.Schedule` chains keep running after a panel is deleted.** Guard self-rescheduling
  loops with a `.deleted` flag or prefer `setInterval` + `onCleanup` so teardown is explicit.
- **Layout isn't computed the frame you make a panel visible.** Defer one frame
  (`$.Schedule(0.06, …)`) before reading `actuallayoutwidth` / `GetPositionWithinWindow()`
  for popup positioning (Athena's eomdesign).
- **HTTP only works on dedicated servers / tools.** `GetDedicatedServerKeyV2` is empty on a
  listen server; fall back to a local `backend_key.kv` for in-tools testing (PudgeWars/IMBA).
  Always handle `StatusCode == 0` (timeout) and code `>= 500`.
- **`game_rules_state_change` fires for every state.** Branch explicitly on
  `GameRules:State_Get()`; don't assume it's only called once or in a fixed order across
  reconnects.
- **Hot-reload re-runs module top-level code.** Guard singletons with `if X == nil` and only
  seed state when `not bReload` (§1.2), or a reload wipes player data mid-game.
- **`Timer(key, 0, …)` end-of-frame timers need unique keys.** Athena keys them by
  `name..id.."_"..GetFrameCount()`; reusing a key within a frame drops the second schedule
  (which is exactly how the debounce works — but a bug if unintended).
- **Pruning a list while iterating with `ipairs` skips elements.** The round's
  remaining-enemy tracker iterates *backwards* (`for i = #t, 1, -1`) when calling
  `table.remove` (§3.1) — do the same anywhere you remove during iteration.
