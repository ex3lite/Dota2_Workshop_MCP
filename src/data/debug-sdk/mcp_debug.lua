--[[
  MCP DebugSDK  —  an in-game debug/control surface for the Dota 2 Workshop MCP.

  Drop this into a custom game's vscripts and require it once (the MCP's
  `addon_attach_debug_sdk` tool does this for you). It registers a set of console
  commands prefixed `mcp_*` that the MCP drives over the VConsole2 channel to
  inspect and control a running game deterministically — spawn units, grant
  gold/levels/items, dump game state as JSON, evaluate Lua, run assertions for
  self-tests, fire UI events, and prep clean screenshots.

  Every machine-readable line is prefixed with "[MCP]" so the MCP can grep it out
  of the live console stream. Safe to hot-reload (script_reload re-registers).

  This file is the source of truth bundled inside the MCP. Do not edit the copy in
  your addon by hand — re-attach to update.
]]

local SDK_VERSION = "1.0.0"

----------------------------------------------------------------------
-- Tiny JSON encoder (no dependencies; handles the shapes we emit).
----------------------------------------------------------------------
local function jsonEncode(v, seen)
  seen = seen or {}
  local t = type(v)
  if t == "nil" then return "null" end
  if t == "boolean" then return v and "true" or "false" end
  if t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return "null" end
    return tostring(v)
  end
  if t == "string" then
    return '"' .. v:gsub('[%z\1-\31\\"]', function(c)
      local map = { ['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
      return map[c] or string.format('\\u%04x', string.byte(c))
    end) .. '"'
  end
  if t == "table" then
    if seen[v] then return '"<cycle>"' end
    seen[v] = true
    -- array?
    local n, isArray = 0, true
    for k, _ in pairs(v) do
      n = n + 1
      if type(k) ~= "number" then isArray = false end
    end
    local parts = {}
    if isArray and n > 0 then
      for i = 1, #v do parts[#parts + 1] = jsonEncode(v[i], seen) end
      seen[v] = nil
      return "[" .. table.concat(parts, ",") .. "]"
    end
    for k, val in pairs(v) do
      parts[#parts + 1] = jsonEncode(tostring(k), seen) .. ":" .. jsonEncode(val, seen)
    end
    seen[v] = nil
    return "{" .. table.concat(parts, ",") .. "}"
  end
  -- functions, userdata, entities, etc.
  return jsonEncode(tostring(v), seen)
end

local function out(...)
  print("[MCP] " .. table.concat({ ... }, " "))
end

local function joinArgs(args, from)
  local t = {}
  for i = from, #args do t[#t + 1] = tostring(args[i]) end
  return table.concat(t, " ")
end

----------------------------------------------------------------------
-- Game-state helpers.
----------------------------------------------------------------------
local function firstHero()
  for pid = 0, 23 do
    if PlayerResource:IsValidPlayerID(pid) then
      local h = PlayerResource:GetSelectedHeroEntity(pid)
      if h and not h:IsNull() then return h, pid end
    end
  end
  return nil, nil
end

local function heroForPid(pid)
  if pid == nil then return firstHero() end
  pid = tonumber(pid)
  if pid == nil or not PlayerResource:IsValidPlayerID(pid) then return nil, nil end
  return PlayerResource:GetSelectedHeroEntity(pid), pid
end

local function snapshotState()
  local players = {}
  for pid = 0, 23 do
    if PlayerResource:IsValidPlayerID(pid) then
      local h = PlayerResource:GetSelectedHeroEntity(pid)
      players[#players + 1] = {
        pid = pid,
        team = PlayerResource:GetTeam(pid),
        gold = PlayerResource:GetGold(pid),
        hero = (h and not h:IsNull()) and h:GetUnitName() or nil,
        level = (h and not h:IsNull()) and h:GetLevel() or nil,
        alive = (h and not h:IsNull()) and h:IsAlive() or false,
        hp = (h and not h:IsNull()) and h:GetHealth() or nil,
      }
    end
  end
  local unitCount = 0
  local e = Entities:First()
  while e do
    if e.IsBaseNPC and e:IsBaseNPC() then unitCount = unitCount + 1 end
    e = Entities:Next(e)
  end
  return {
    gameTime = GameRules:GetGameTime(),
    dotaTime = GameRules:GetDOTATime(true, true),
    state = GameRules:State_Get(),
    paused = GameRules:IsGamePaused(),
    players = players,
    unitCount = unitCount,
  }
end

----------------------------------------------------------------------
-- Command implementations.
----------------------------------------------------------------------
local function cmd_ping()
  out("PONG", "v=" .. SDK_VERSION, "t=" .. string.format("%.2f", GameRules:GetGameTime()), "state=" .. tostring(GameRules:State_Get()))
end

local function cmd_state()
  out("STATE", jsonEncode(snapshotState()))
end

local function cmd_dump(_, section)
  section = section or "state"
  if section == "state" then
    out("DUMP", "state", jsonEncode(snapshotState()))
  elseif section == "heroes" then
    local heroes = {}
    for _, h in ipairs(HeroList and HeroList:GetAllHeroes() or {}) do
      heroes[#heroes + 1] = { name = h:GetUnitName(), pid = h:GetPlayerOwnerID(), level = h:GetLevel(), hp = h:GetHealth(), maxhp = h:GetMaxHealth(), alive = h:IsAlive(), pos = { h:GetAbsOrigin().x, h:GetAbsOrigin().y, h:GetAbsOrigin().z } }
    end
    out("DUMP", "heroes", jsonEncode(heroes))
  elseif section == "nettables" then
    out("DUMP", "nettables", "use mcp_eval to inspect CustomNetTables:GetAllTableValues(<name>)")
  elseif section == "units" then
    local units, e = {}, Entities:First()
    while e do
      if e.IsBaseNPC and e:IsBaseNPC() and not (e.IsHero and e:IsHero()) then
        units[#units + 1] = { name = e:GetUnitName(), team = e:GetTeamNumber(), hp = e:GetHealth() }
      end
      e = Entities:Next(e)
    end
    out("DUMP", "units", "count=" .. #units, jsonEncode(units))
  else
    out("DUMP_ERR", "unknown section '" .. tostring(section) .. "' (state|heroes|units|nettables)")
  end
end

local loadString = loadstring or load

local function cmd_eval(args)
  local code = joinArgs(args, 2)
  if code == "" then out("EVAL_ERR", "no code"); return end
  -- Try as an expression first (so `mcp_eval GameRules:GetGameTime()` returns a value).
  local fn, err = loadString("return " .. code)
  if not fn then fn, err = loadString(code) end
  if not fn then out("EVAL_ERR", tostring(err)); return end
  local ok, res = pcall(fn)
  if not ok then out("EVAL_ERR", tostring(res)); return end
  out("EVAL_OK", jsonEncode(res))
end

local function cmd_assert(args)
  local code = joinArgs(args, 2)
  if code == "" then out("ASSERT", "FAIL", "(no expression)"); return end
  local fn, err = loadString("return (" .. code .. ")")
  if not fn then out("ASSERT", "FAIL", "compile: " .. tostring(err), "::", code); return end
  local ok, res = pcall(fn)
  if not ok then out("ASSERT", "FAIL", "error: " .. tostring(res), "::", code); return end
  if res then out("ASSERT", "PASS", "::", code) else out("ASSERT", "FAIL", "falsy: " .. tostring(res), "::", code) end
end

local function cmd_spawn(_, unit, count, team)
  if not unit then out("SPAWN_ERR", "usage: mcp_spawn <unitname> [count] [team]"); return end
  count = tonumber(count) or 1
  local hero = firstHero()
  local origin = hero and hero:GetAbsOrigin() or Vector(0, 0, 0)
  local teamNum = tonumber(team) or DOTA_TEAM_BADGUYS
  local made = 0
  for i = 1, count do
    local pos = origin + RandomVector(RandomFloat(64, 256))
    local u = CreateUnitByName(unit, pos, true, nil, nil, teamNum)
    if u and not u:IsNull() then made = made + 1 end
  end
  out("SPAWN", unit, "x" .. made, "team=" .. teamNum)
end

local function cmd_gold(_, amount, pid)
  local hero, p = heroForPid(pid)
  amount = tonumber(amount) or 0
  if p == nil then out("GOLD_ERR", "no valid player"); return end
  PlayerResource:ModifyGold(p, amount, true, 0)
  out("GOLD", "pid=" .. p, "+" .. amount, "now=" .. PlayerResource:GetGold(p))
end

local function cmd_level(_, level, pid)
  local hero, p = heroForPid(pid)
  level = tonumber(level)
  if not hero or hero:IsNull() then out("LEVEL_ERR", "no hero"); return end
  if not level then out("LEVEL_ERR", "usage: mcp_level <level> [pid]"); return end
  local guard = 0
  while hero:GetLevel() < level and guard < 200 do hero:HeroLevelUp(false); guard = guard + 1 end
  out("LEVEL", "pid=" .. tostring(p), "now=" .. hero:GetLevel())
end

local function cmd_item(_, item, pid)
  local hero, p = heroForPid(pid)
  if not item then out("ITEM_ERR", "usage: mcp_item <item_name> [pid]"); return end
  if not hero or hero:IsNull() then out("ITEM_ERR", "no hero"); return end
  local it = CreateItem(item, hero, hero)
  if not it then out("ITEM_ERR", "could not create '" .. item .. "'"); return end
  hero:AddItem(it)
  out("ITEM", item, "-> pid=" .. tostring(p))
end

local function cmd_event(args)
  local name = args[2]
  if not name then out("EVENT_ERR", "usage: mcp_event <event_name> [json-data]"); return end
  local payload = joinArgs(args, 3)
  local data = {}
  if payload ~= "" then
    local fn = loadString("return " .. payload)
    if fn then local ok, t = pcall(fn); if ok and type(t) == "table" then data = t end end
  end
  CustomGameEventManager:Send_ServerToAllClients(name, data)
  out("EVENT", name, jsonEncode(data))
end

local function cmd_hud(_, on)
  -- Toggle HUD/cursor for clean screenshots (client-side conveniences via convars).
  local v = (tostring(on) == "0") and 0 or 1
  SendToServerConsole("dota_hud_visible " .. v)
  out("HUD", tostring(v))
end

local function cmd_pause(_, on)
  local p = (tostring(on) == "0") and false or true
  PauseGame(p)
  out("PAUSE", tostring(p))
end

----------------------------------------------------------------------
-- Registration (idempotent across script_reload).
----------------------------------------------------------------------
local function reg(name, fn, help)
  -- Wrap so a thrown error never kills the console command.
  local ok = pcall(function()
    Convars:RegisterCommand(name, function(...) local a = { ... }; local ok2, e = pcall(fn, a, a[2], a[3], a[4]); if not ok2 then out(name .. "_ERR", tostring(e)) end end, help or name, 0)
  end)
  return ok
end

reg("mcp_ping", function() cmd_ping() end, "MCP: health check")
reg("mcp_state", function() cmd_state() end, "MCP: dump high-level game state as JSON")
reg("mcp_dump", cmd_dump, "MCP: dump a section (state|heroes|units|nettables) as JSON")
reg("mcp_eval", cmd_eval, "MCP: eval Lua and print the JSON-encoded result")
reg("mcp_assert", cmd_assert, "MCP: evaluate a boolean Lua expression; prints PASS/FAIL")
reg("mcp_spawn", cmd_spawn, "MCP: spawn units near a hero (mcp_spawn <unit> [count] [team])")
reg("mcp_gold", cmd_gold, "MCP: grant gold (mcp_gold <amount> [pid])")
reg("mcp_level", cmd_level, "MCP: level a hero up to N (mcp_level <level> [pid])")
reg("mcp_item", cmd_item, "MCP: give an item (mcp_item <item> [pid])")
reg("mcp_event", cmd_event, "MCP: fire a custom game event to clients (mcp_event <name> [json])")
reg("mcp_hud", cmd_hud, "MCP: toggle HUD visibility (mcp_hud <0|1>) for clean shots")
reg("mcp_pause", cmd_pause, "MCP: pause/unpause (mcp_pause <0|1>)")

out("DebugSDK", "loaded", "v=" .. SDK_VERSION, "(commands: mcp_ping mcp_state mcp_dump mcp_eval mcp_assert mcp_spawn mcp_gold mcp_level mcp_item mcp_event mcp_hud mcp_pause)")

return { version = SDK_VERSION }
