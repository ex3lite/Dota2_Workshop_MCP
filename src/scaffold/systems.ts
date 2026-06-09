// "Systems" scaffolders — generate battle-tested custom-game infrastructure distilled
// from shipping games (see docs panorama/animations-cookbook, panorama/hud-ux-patterns,
// scripting/custom-game-architecture and the dota_patterns KB):
//   - scaffoldNotifications  : a toast / kill-feed bus (Panorama XML+CSS+JS + Lua module)
//   - scaffoldNetTableBinding: prime-and-subscribe JS helpers + a debounced Lua writer
//   - scaffoldRpc            : correlation-id RPC over custom events (client + server)
//
// Panorama is emitted as plain .js/.xml/.css under content/panorama (works for both raw
// and tstl projects). Server modules are emitted as Lua under the runtime vscripts dir
// and require()'d from your game mode (same as the DebugSDK).

import { join } from "node:path";
import { AddonProject } from "../dota/project.js";
import { writeTextFile, pathExists, ensureDir } from "../util/fsx.js";
import { ScaffoldResult } from "./scaffolders.js";

async function writeGuarded(path: string, content: string, overwrite: boolean): Promise<void> {
  if (!overwrite && (await pathExists(path))) {
    throw new Error(`Refusing to overwrite existing file: ${path}. Pass overwrite=true to replace it.`);
  }
  await ensureDir(join(path, ".."));
  await writeTextFile(path, content, { encoding: "utf8" });
}

function panoramaPaths(project: AddonProject) {
  return {
    layout: join(project.panoramaContentDir, "layout", "custom_game"),
    styles: join(project.panoramaContentDir, "styles", "custom_game"),
    scripts: join(project.panoramaContentDir, "scripts", "custom_game"),
  };
}

// ---------------------------------------------------------------------------
// Notifications (toast / kill-feed bus)
// ---------------------------------------------------------------------------
export interface ScaffoldNotificationsOptions {
  name?: string;
  overwrite?: boolean;
}

export async function scaffoldNotifications(project: AddonProject, opts: ScaffoldNotificationsOptions = {}): Promise<ScaffoldResult> {
  const base = opts.name ?? "mcp_notifications";
  const r: ScaffoldResult = { created: [], modified: [], notes: [] };
  const pan = panoramaPaths(project);

  const xml = `<root>
    <styles>
        <include src="file://{resources}/styles/custom_game/${base}.css" />
    </styles>
    <scripts>
        <include src="file://{resources}/scripts/custom_game/${base}.js" />
    </scripts>

    <Panel hittest="false" style="width: 100%; height: 100%;">
        <Panel id="NotificationStack" hittest="false" />
    </Panel>
</root>
`;

  // Pop-in scale overshoot, upward-growing stack, fly-out — straight from the cookbook.
  const css = `#NotificationStack {
    flow-children: up;
    horizontal-align: center;
    vertical-align: bottom;
    margin-bottom: 240px;
}

.Toast {
    flow-children: right;
    margin: 4px;
    padding: 8px 14px;
    border-radius: 6px;
    background-color: gradient( linear, 0% 0%, 0% 100%, from( #1c2230f0 ), to( #0d1018f0 ) );
    box-shadow: fill #000000c0 0px 2px 6px 0px;
    opacity: 0;
    pre-transform-scale2d: 0.2;
    animation-name: ToastIn;
    animation-duration: 0.41s;
    animation-timing-function: ease-in-out;
    animation-fill-mode: forwards;
}

@keyframes ToastIn {
    0%   { opacity: 0; pre-transform-scale2d: 0.2; }
    50%  { opacity: 1; pre-transform-scale2d: 1.15; }
    100% { opacity: 1; pre-transform-scale2d: 1.0; }
}

.Toast.ToastLeaving {
    opacity: 0;
    transform: translateX( -40px );
    transition-property: opacity, transform;
    transition-duration: 0.25s;
    transition-timing-function: ease-in;
}

.ToastIcon { width: 28px; height: 28px; margin-right: 8px; vertical-align: center; }
.ToastText { color: #ffffff; font-size: 20px; vertical-align: center; }

/* type variants — wash-color tints the whole toast */
.Toast--good { wash-color: #6dff8a; }
.Toast--bad  { wash-color: #ff6d6d; }
.Toast--info { wash-color: #6db8ff; }
`;

  const js = `// ${base}: a client-side toast bus. Server fires "mcp_notify" with { text, icon?, type?, duration? }.
(function () {
    "use strict";
    var stack = $("#NotificationStack");

    function addToast(data) {
        if (!stack) return;
        var toast = $.CreatePanel("Panel", stack, "");
        toast.AddClass("Toast");
        if (data.type) toast.AddClass("Toast--" + data.type);

        if (data.icon) {
            var img = $.CreatePanel("Image", toast, "");
            img.AddClass("ToastIcon");
            img.SetImage(data.icon);
        }
        var label = $.CreatePanel("Label", toast, "");
        label.AddClass("ToastText");
        label.text = data.text || "";

        var dur = data.duration || 4.0;
        $.Schedule(dur, function () {
            toast.AddClass("ToastLeaving");
            $.Schedule(0.3, function () { toast.DeleteAsync(0); });
        });
    }

    GameEvents.Subscribe("mcp_notify", addToast);
})();
`;

  const lua = `-- ${base}: a server-side toast/kill-feed bus. Require this from your game mode:
--   pcall(require, "${base}")
-- then call Notifications:All("Hello!") / Notifications:ToPlayer(pid, "...", {type="good"}).
if Notifications == nil then Notifications = class({}) end

local function build(text, opts)
    opts = opts or {}
    return { text = tostring(text), icon = opts.icon, type = opts.type, duration = opts.duration }
end

function Notifications:All(text, opts)
    CustomGameEventManager:Send_ServerToAllClients("mcp_notify", build(text, opts))
end

function Notifications:ToTeam(team, text, opts)
    CustomGameEventManager:Send_ServerToTeam(team, "mcp_notify", build(text, opts))
end

function Notifications:ToPlayer(playerId, text, opts)
    local p = PlayerResource:GetPlayer(playerId)
    if p then CustomGameEventManager:Send_ServerToPlayer(p, "mcp_notify", build(text, opts)) end
end

-- Sugar
function Notifications:Good(text) self:All(text, { type = "good" }) end
function Notifications:Bad(text)  self:All(text, { type = "bad" }) end

return Notifications
`;

  await writeGuarded(join(pan.layout, `${base}.xml`), xml, !!opts.overwrite);
  await writeGuarded(join(pan.styles, `${base}.css`), css, !!opts.overwrite);
  await writeGuarded(join(pan.scripts, `${base}.js`), js, !!opts.overwrite);
  await writeGuarded(join(project.vscriptsOutDir, `${base}.lua`), lua, !!opts.overwrite);
  r.created.push(
    join(pan.layout, `${base}.xml`),
    join(pan.styles, `${base}.css`),
    join(pan.scripts, `${base}.js`),
    join(project.vscriptsOutDir, `${base}.lua`),
  );
  r.notes.push(`Add <Panel> referencing ${base}.xml to content/panorama/layout/custom_game/custom_ui_manifest.xml.`);
  r.notes.push(`Load the server module: add  pcall(require, "${base}")  to your game-mode bootstrap.`);
  r.notes.push(`Then: Notifications:All("Wave 5 incoming!", { type = "info" }).`);
  return r;
}

// ---------------------------------------------------------------------------
// Net-table binding (prime-and-subscribe + debounced writer)
// ---------------------------------------------------------------------------
export interface ScaffoldNetTableOptions {
  table?: string;
  overwrite?: boolean;
}

export async function scaffoldNetTableBinding(project: AddonProject, opts: ScaffoldNetTableOptions = {}): Promise<ScaffoldResult> {
  const r: ScaffoldResult = { created: [], modified: [], notes: [] };
  const pan = panoramaPaths(project);
  const example = opts.table ?? "game_state";

  const js = `// Net-table helpers (client). Prime-and-subscribe avoids the classic
// "UI misses the first value" bug; the keyed variant filters to one row.
(function () {
    "use strict";
    var G = GameUI.CustomUIConfig();
    G.NetTable = G.NetTable || {};

    // Call cb with the current value immediately, then on every change to that key.
    G.NetTable.SubscribeKey = function (tableName, key, cb) {
        var current = CustomNetTables.GetTableValue(tableName, key);
        if (current != null) cb(current);
        return CustomNetTables.SubscribeNetTableListener(tableName, function (_t, k, val) {
            if (k === key && val != null) cb(val);
        });
    };

    // Subscribe to a whole table; cb(key, value) per change (primed with existing rows).
    G.NetTable.SubscribeTable = function (tableName, cb) {
        var all = CustomNetTables.GetAllTableValues(tableName) || [];
        for (var i = 0; i < all.length; i++) cb(all[i].key, all[i].value);
        return CustomNetTables.SubscribeNetTableListener(tableName, function (_t, k, v) { cb(k, v); });
    };

    // Example usage:
    // G.NetTable.SubscribeKey("${example}", "round", function (v) { $("#RoundLabel").text = "Round " + v.n; });
})();
`;

  const lua = `-- NetSync (server): debounced CustomNetTables writer. Many same-frame writes to the
-- same (table,key) collapse into ONE push next think — eliminates network churn from
-- chatty setters. Require from your game mode:  pcall(require, "net_sync").
if NetSync == nil then NetSync = class({}) end
NetSync._pending = NetSync._pending or {}
NetSync._scheduled = NetSync._scheduled or false

-- Immediate write.
function NetSync:Set(tableName, key, data)
    CustomNetTables:SetTableValue(tableName, key, data)
end

-- Debounced write: stores the latest value and flushes once on the next think.
function NetSync:SetDebounced(tableName, key, data)
    self._pending[tableName .. "\\0" .. tostring(key)] = { t = tableName, k = key, v = data }
    if not self._scheduled then
        self._scheduled = true
        local mode = GameRules:GetGameModeEntity()
        mode:SetContextThink("NetSyncFlush_" .. DoUniqueString("ns"), function()
            for _, row in pairs(self._pending) do CustomNetTables:SetTableValue(row.t, row.k, row.v) end
            self._pending = {}
            self._scheduled = false
            return nil -- one-shot
        end, 0)
    end
end

return NetSync
`;

  await writeGuarded(join(pan.scripts, "nettable_helpers.js"), js, !!opts.overwrite);
  await writeGuarded(join(project.vscriptsOutDir, "net_sync.lua"), lua, !!opts.overwrite);
  r.created.push(join(pan.scripts, "nettable_helpers.js"), join(project.vscriptsOutDir, "net_sync.lua"));
  r.notes.push("Include nettable_helpers.js from your panel XML <scripts> (or custom_ui_manifest).");
  r.notes.push('Load the server module: add  pcall(require, "net_sync")  to your bootstrap, then NetSync:SetDebounced("' + example + '", "round", {n=5}).');
  return r;
}

// ---------------------------------------------------------------------------
// RPC over custom game events (correlation id)
// ---------------------------------------------------------------------------
export interface ScaffoldRpcOptions {
  overwrite?: boolean;
}

export async function scaffoldRpc(project: AddonProject, opts: ScaffoldRpcOptions = {}): Promise<ScaffoldResult> {
  const r: ScaffoldResult = { created: [], modified: [], notes: [] };
  const pan = panoramaPaths(project);

  const js = `// RPC client: turn Dota's one-way custom events into request/response calls.
// Rpc.Request("buy_item", { item: "item_blink" }, function (res) { ... });
(function () {
    "use strict";
    var G = GameUI.CustomUIConfig();
    if (G.Rpc) return;
    var nextId = 0;
    G.Rpc = {
        Request: function (name, data, callback, timeoutSeconds) {
            data = data || {};
            var id = ++nextId;
            data.__rpc = id;
            var done = false;
            var handle = GameEvents.Subscribe(name + "_res", function (res) {
                if (res.__rpc !== id || done) return;
                done = true;
                GameEvents.Unsubscribe(handle);
                if (callback) callback(res);
            });
            GameEvents.SendCustomGameEventToServer(name + "_req", data);
            if (timeoutSeconds) {
                $.Schedule(timeoutSeconds, function () {
                    if (done) return;
                    done = true;
                    GameEvents.Unsubscribe(handle);
                    if (callback) callback({ __ok: 0, error: "timeout" });
                });
            }
        },
    };
})();
`;

  const lua = `-- RPC server: register named handlers; replies are correlated by id so the client
-- gets a real callback. Handlers run inside coroutine.wrap+xpcall for CRASH ISOLATION
-- (a thrown error replies __ok=0 instead of killing the listener). NOTE: Dota's
-- CreateHTTPRequestScriptVM req:Send(cb) is CALLBACK-based and does NOT suspend the
-- coroutine — for a backend call, return nothing here and send the reply yourself from
-- inside the HTTP callback via CustomGameEventManager:Send_ServerToPlayer(p, name.."_res", {...}).
-- Require from your game mode:  pcall(require, "rpc").
if Rpc == nil then Rpc = class({}) end
Rpc._handlers = Rpc._handlers or {}
Rpc._bound = Rpc._bound or {}

-- handler(playerId, payload) -> table (sent back to the requesting client) or nil.
function Rpc:On(name, handler)
    self._handlers[name] = handler
    if self._bound[name] then return end
    self._bound[name] = true
    CustomGameEventManager:RegisterListener(name .. "_req", function(_, payload)
        local pid = payload.PlayerID
        local rpcId = payload.__rpc
        local fn = self._handlers[name]
        if not fn then return end
        coroutine.wrap(function()
            local ok, res = xpcall(function() return fn(pid, payload) end, function(e) return e end)
            local out = (ok and type(res) == "table") and res or {}
            out.__rpc = rpcId
            out.__ok = ok and 1 or 0
            if not ok then out.error = tostring(res) end
            local p = PlayerResource:GetPlayer(pid)
            if p then CustomGameEventManager:Send_ServerToPlayer(p, name .. "_res", out) end
        end)()
    end)
end

return Rpc
`;

  await writeGuarded(join(pan.scripts, "rpc.js"), js, !!opts.overwrite);
  await writeGuarded(join(project.vscriptsOutDir, "rpc.lua"), lua, !!opts.overwrite);
  r.created.push(join(pan.scripts, "rpc.js"), join(project.vscriptsOutDir, "rpc.lua"));
  r.notes.push("Include rpc.js from your panel XML <scripts>; load the server module with  pcall(require, \"rpc\").");
  r.notes.push('Server: Rpc:On("buy_item", function(pid, p) ... return { ok = true } end). Client: GameUI.CustomUIConfig().Rpc.Request("buy_item", {item="..."}, cb).');
  return r;
}

// ---------------------------------------------------------------------------
// Save codes (persistence) — self-contained encode/decode + HTTP-backend variant
// ---------------------------------------------------------------------------
export interface ScaffoldSaveCodesOptions {
  fields?: string[];
  overwrite?: boolean;
}

export async function scaffoldSaveCodes(project: AddonProject, opts: ScaffoldSaveCodesOptions = {}): Promise<ScaffoldResult> {
  const r: ScaffoldResult = { created: [], modified: [], notes: [] };
  const fields = (opts.fields && opts.fields.length ? opts.fields : ["level", "gold", "wins", "unlocks"]).filter((f) => /^[a-z][a-z0-9_]*$/i.test(f));
  const schema = fields.map((f) => `"${f}"`).join(", ");

  const lua = `-- SaveCodes: encode/decode a flat map of integer fields into a shareable code with a
-- tamper checksum. Dependency-free (pure-Lua, URL-safe base64). For large/nested saves
-- or strong anti-tamper, swap in libdeflate + dkjson + an HMAC, or use HttpSave/HttpLoad.
-- Require from your game mode:  pcall(require, "save_codes").
if SaveCodes == nil then SaveCodes = class({}) end

-- Ordered integer fields. Append new fields at the END and bump VERSION so old codes
-- still decode (missing trailing fields default to 0).
SaveCodes.SCHEMA = SaveCodes.SCHEMA or { ${schema} }
SaveCodes.VERSION = SaveCodes.VERSION or 1

local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
local function enc(n)
    n = math.floor(n)
    if n <= 0 then return B64:sub(1, 1) end
    local s = ""
    while n > 0 do local r = n % 64; s = B64:sub(r + 1, r + 1) .. s; n = math.floor(n / 64) end
    return s
end
local function dec(s)
    local n = 0
    for i = 1, #s do local p = B64:find(s:sub(i, i), 1, true); if not p then return nil end; n = n * 64 + (p - 1) end
    return n
end

function SaveCodes:Encode(data)
    data = data or {}
    local parts, sum = { enc(self.VERSION) }, self.VERSION
    for _, key in ipairs(self.SCHEMA) do
        local v = math.max(0, math.floor(tonumber(data[key]) or 0))
        sum = sum + v * 31
        parts[#parts + 1] = enc(v)
    end
    parts[#parts + 1] = enc(sum % 1000000) -- checksum
    return table.concat(parts, ".")
end

function SaveCodes:Decode(code)
    if type(code) ~= "string" then return nil, "not a string" end
    local fields = {}
    for token in code:gmatch("[^.]+") do fields[#fields + 1] = token end
    if #fields < 2 then return nil, "too short" end
    if dec(fields[1]) ~= self.VERSION then return nil, "version mismatch" end
    local data, sum = {}, self.VERSION
    for i, key in ipairs(self.SCHEMA) do
        local v = dec(fields[i + 1]) or 0
        sum = sum + v * 31
        data[key] = v
    end
    if dec(fields[#fields]) ~= (sum % 1000000) then return nil, "checksum failed (tampered?)" end
    return data
end

-- ---- HTTP backend variant (server-authoritative persistence) -------------
-- Generate a per-server key and hand it to clients over a net table so the sandboxed
-- Panorama UI can call your API directly (the pattern shipping games use).
function SaveCodes:InitServerKey()
    self.serverKey = self.serverKey or DoUniqueString("srv")
    CustomNetTables:SetTableValue("save_codes", "server_key", { key = self.serverKey })
end

function SaveCodes:HttpSave(steamId, data, onDone)
    local req = CreateHTTPRequestScriptVM("POST", "https://your.api/dota/save")
    req:SetHTTPRequestHeaderValue("X-Server-Key", self.serverKey or "")
    req:SetHTTPRequestRawPostBody("application/json", '{"id":"' .. tostring(steamId) .. '","code":"' .. self:Encode(data) .. '"}')
    req:SetHTTPRequestAbsoluteTimeoutMS(20000)
    req:Send(function(res) if onDone then onDone(res.StatusCode == 200, res.Body) end end)
end

function SaveCodes:HttpLoad(steamId, onDone)
    local req = CreateHTTPRequestScriptVM("GET", "https://your.api/dota/load?id=" .. tostring(steamId))
    req:SetHTTPRequestHeaderValue("X-Server-Key", self.serverKey or "")
    req:Send(function(res)
        if res.StatusCode ~= 200 then if onDone then onDone(nil) end; return end
        if onDone then onDone(self:Decode(res.Body)) end
    end)
end

return SaveCodes
`;

  await writeGuarded(join(project.vscriptsOutDir, "save_codes.lua"), lua, !!opts.overwrite);
  r.created.push(join(project.vscriptsOutDir, "save_codes.lua"));
  r.notes.push(`Save schema: ${fields.join(", ")} (integers). Edit SaveCodes.SCHEMA to change; append new fields at the end + bump VERSION.`);
  r.notes.push('Load with  pcall(require, "save_codes").  Encode: local code = SaveCodes:Encode({ level = 12, gold = 500 }).');
  r.notes.push("HTTP variant: call SaveCodes:InitServerKey() at startup, point the URLs at your API, read the key on the client from CustomNetTables('save_codes','server_key').");
  return r;
}

// ---------------------------------------------------------------------------
// HUD panel preloaded with cookbook micro-interactions
// ---------------------------------------------------------------------------
export interface ScaffoldHudPanelOptions {
  name: string;
  overwrite?: boolean;
}

export async function scaffoldHudPanel(project: AddonProject, opts: ScaffoldHudPanelOptions): Promise<ScaffoldResult> {
  const name = opts.name;
  if (!/^[a-z][a-z0-9_]*$/i.test(name)) throw new Error(`Invalid panel name "${name}".`);
  const r: ScaffoldResult = { created: [], modified: [], notes: [] };
  const pan = panoramaPaths(project);

  const xml = `<root>
    <styles>
        <include src="file://{resources}/styles/custom_game/${name}.css" />
    </styles>
    <scripts>
        <include src="file://{resources}/scripts/custom_game/${name}.js" />
    </scripts>

    <Panel id="${name}Root" class="HudRoot">
        <Label id="${name}Title" class="HudTitle" text="${name}" />
        <Panel id="${name}Card" class="HudCard">
            <Label class="HudCardText" text="Hover me" />
        </Panel>
        <Button id="${name}Toggle" class="HudButton">
            <Label text="Toggle" />
        </Button>
    </Panel>
</root>
`;

  // Gradient title, hover pop, rarity glow loop, fly-in show class — from the cookbook.
  const css = `.HudRoot {
    flow-children: down;
    horizontal-align: right;
    vertical-align: center;
    margin-right: 24px;
    padding: 12px;
    border-radius: 8px;
    background-color: gradient( linear, 0% 0%, 0% 100%, from( #161b27ee ), to( #0b0e16ee ) );
    box-shadow: fill #000000a0 0px 2px 8px 0px;

    /* fly-in: hidden state translates off-axis + scales down; .Shown resets it */
    opacity: 0;
    pre-transform-scale2d: 0.95;
    transform: translateX( 40px );
    transition-property: opacity, transform, pre-transform-scale2d;
    transition-duration: 0.2s;
    transition-timing-function: ease-in-out;
}
.HudRoot.Shown {
    opacity: 1;
    pre-transform-scale2d: 1.0;
    transform: translateX( 0px );
}

.HudTitle {
    font-size: 26px;
    font-weight: bold;
    horizontal-align: center;
    /* gradient text — supported in Panorama */
    color: gradient( linear, 0% 0%, 0% 100%, from( #ffffff ), color-stop( 0.5, #ffe08a ), to( #cf9b3e ) );
    text-shadow: 0px 2px 3px 2px #000000c0;
    margin-bottom: 8px;
}

.HudCard {
    width: 200px;
    height: 64px;
    margin: 6px 0px;
    border-radius: 6px;
    background-color: #232a3a;
    /* rarity 'breathe' glow loop */
    box-shadow: inset #6db8ff 0px 0px 1px 0px;
    animation-name: HudGlow;
    animation-duration: 2.0s;
    animation-timing-function: ease-in-out;
    animation-iteration-count: infinite;

    /* hover pop (GPU-cheap: scale + brightness, no layout) */
    pre-transform-scale2d: 1.0;
    brightness: 1.0;
    transition-property: pre-transform-scale2d, brightness;
    transition-duration: 0.12s;
    transition-timing-function: ease-in-out;
}
.HudCard:hover {
    pre-transform-scale2d: 1.04;
    brightness: 1.25;
}
@keyframes HudGlow {
    0%   { box-shadow: inset #6db8ff 0px 0px 1px 0px; }
    50%  { box-shadow: inset #6db8ff 0px 0px 5px 0px; }
    100% { box-shadow: inset #6db8ff 0px 0px 1px 0px; }
}

.HudCardText { color: #cfd6e6; font-size: 18px; horizontal-align: center; vertical-align: center; }

.HudButton {
    width: 120px; height: 32px; margin-top: 8px; horizontal-align: center;
    border-radius: 4px; background-color: #2c3650;
    pre-transform-scale2d: 1.0; transition-property: pre-transform-scale2d, brightness; transition-duration: 0.1s;
}
.HudButton:hover { brightness: 1.3; }
.HudButton:active { pre-transform-scale2d: 0.94; }
`;

  const js = `// HUD panel "${name}" — demonstrates the reusable Panorama micro-interactions:
// class-driven fly-in (.Shown), hover pop (CSS), and a net-table binding.
(function () {
    "use strict";
    var root = $("#${name}Root");

    // Reveal with the fly-in transition once layout is ready.
    $.Schedule(0.05, function () { root.AddClass("Shown"); });

    // Toggle button hides/shows via the single state class.
    var toggle = $("#${name}Toggle");
    if (toggle) toggle.SetPanelEvent("onactivate", function () { root.ToggleClass("Shown"); });

    // Example: bind a net-table row to the title (uses nettable_helpers if present).
    // var G = GameUI.CustomUIConfig();
    // if (G.NetTable) G.NetTable.SubscribeKey("game_state", "round", function (v) {
    //     $("#${name}Title").text = "Round " + v.n;
    // });
})();
`;

  await writeGuarded(join(pan.layout, `${name}.xml`), xml, !!opts.overwrite);
  await writeGuarded(join(pan.styles, `${name}.css`), css, !!opts.overwrite);
  await writeGuarded(join(pan.scripts, `${name}.js`), js, !!opts.overwrite);
  r.created.push(join(pan.layout, `${name}.xml`), join(pan.styles, `${name}.css`), join(pan.scripts, `${name}.js`));
  r.notes.push(`Add ${name}.xml to content/panorama/layout/custom_game/custom_ui_manifest.xml to display it.`);
  r.notes.push("Includes hover-pop, an infinite rarity glow, a gradient title and a class-driven fly-in — see docs panorama/animations-cookbook.");
  return r;
}

// ---------------------------------------------------------------------------
// Wave / round spawner (KV-data-driven, round-state net table)
// ---------------------------------------------------------------------------
export interface ScaffoldWaveSystemOptions {
  overwrite?: boolean;
}

export async function scaffoldWaveSystem(project: AddonProject, opts: ScaffoldWaveSystemOptions = {}): Promise<ScaffoldResult> {
  const r: ScaffoldResult = { created: [], modified: [], notes: [] };

  const lua = `-- Waves: a declarative, data-driven wave/round spawner with a boss every N rounds,
-- live round-state broadcast over a net table, and a leak/clear callback. Spawns at a
-- named map entity. Dependency-free (uses the game-mode entity's think for cadence).
-- Require from your game mode:  pcall(require, "waves").  Then: Waves:Start("wave_spawn").
if Waves == nil then Waves = class({}) end

-- Declarative wave data. Add/tune freely.
Waves.WAVES = Waves.WAVES or {
    { unit = "npc_dota_creep_badguys_melee",  count = 10, interval = 0.7, bounty = 20 },
    { unit = "npc_dota_creep_badguys_ranged", count = 12, interval = 0.6, bounty = 25 },
    { unit = "npc_dota_creep_badguys_melee",  count = 16, interval = 0.5, bounty = 30 },
}
Waves.BOSS = Waves.BOSS or { unit = "npc_dota_creep_badguys_flagbearer", everyN = 5, bounty = 200 }
Waves.PREP_TIME = Waves.PREP_TIME or 5.0       -- seconds between rounds
Waves.TEAM = Waves.TEAM or DOTA_TEAM_BADGUYS

function Waves:Start(spawnName, opts)
    opts = opts or {}
    self.spawnName = spawnName or "wave_spawn"
    self.onLeak = opts.onLeak       -- function(unit) called when a creep reaches the end trigger you wire up
    self.onCleared = opts.onCleared -- function(roundIndex) when a round is fully killed
    self.index = 0
    if not self._killListener then
        self._killListener = ListenToGameEvent("entity_killed", function(e) self:_onKilled(e) end, self)
    end
    self:_beginRound()
end

function Waves:_def(index)
    if self.BOSS and self.BOSS.everyN > 0 and index % self.BOSS.everyN == 0 then
        return { unit = self.BOSS.unit, count = 1, interval = 0.5, bounty = self.BOSS.bounty, boss = true }
    end
    return self.WAVES[((index - 1) % #self.WAVES) + 1]
end

function Waves:_beginRound()
    self.index = self.index + 1
    local wave = self:_def(self.index)
    self.alive = 0
    self.spawnedThisRound = 0
    self.roundTotal = wave.count
    CustomNetTables:SetTableValue("waves", "current", {
        index = self.index, total = wave.count, boss = wave.boss and 1 or 0, state = "prep",
    })
    local mode = GameRules:GetGameModeEntity()
    mode:SetContextThink("WavesPrep_" .. DoUniqueString("w"), function() self:_spawnLoop(wave) return nil end, self.PREP_TIME)
end

function Waves:_spawnLoop(wave)
    CustomNetTables:SetTableValue("waves", "current", { index = self.index, total = wave.count, boss = wave.boss and 1 or 0, state = "active" })
    local spawnEnt = Entities:FindByName(nil, self.spawnName)
    local origin = spawnEnt and spawnEnt:GetAbsOrigin() or Vector(0, 0, 0)
    local mode = GameRules:GetGameModeEntity()
    mode:SetContextThink("WavesSpawn_" .. DoUniqueString("w"), function()
        if self.spawnedThisRound >= wave.count then return nil end
        local u = CreateUnitByName(wave.unit, origin + RandomVector(RandomFloat(32, 128)), true, nil, nil, self.TEAM)
        if u then
            self.spawnedThisRound = self.spawnedThisRound + 1
            self.alive = self.alive + 1
            u._waveBounty = wave.bounty
            u._waveTag = true
        end
        if self.spawnedThisRound >= wave.count then return nil end
        return wave.interval
    end, 0)
end

function Waves:_onKilled(event)
    local u = EntIndexToHScript(event.entindex_killed)
    if not u or not u._waveTag then return end
    self.alive = math.max(0, self.alive - 1)
    if self.alive == 0 and self.spawnedThisRound >= self.roundTotal then
        CustomNetTables:SetTableValue("waves", "current", { index = self.index, total = self.roundTotal, state = "cleared" })
        if self.onCleared then self.onCleared(self.index) end
        self:_beginRound()
    end
end

return Waves
`;

  await writeGuarded(join(project.vscriptsOutDir, "waves.lua"), lua, !!opts.overwrite);
  r.created.push(join(project.vscriptsOutDir, "waves.lua"));
  r.notes.push('Load with  pcall(require, "waves").  Place a point entity named "wave_spawn" in your map, then Waves:Start("wave_spawn").');
  r.notes.push("Edit Waves.WAVES / Waves.BOSS to design rounds. Round state is on CustomNetTables('waves','current') for your HUD.");
  r.notes.push("For tower-defense pathing (waypoints / maze A*) use scaffold_td instead/in addition.");
  return r;
}

// ---------------------------------------------------------------------------
// Shop / store (UI grid + server purchase handler)
// ---------------------------------------------------------------------------
export interface ScaffoldShopOptions {
  overwrite?: boolean;
}

export async function scaffoldShop(project: AddonProject, opts: ScaffoldShopOptions = {}): Promise<ScaffoldResult> {
  const r: ScaffoldResult = { created: [], modified: [], notes: [] };
  const pan = panoramaPaths(project);

  const xml = `<root>
    <styles>
        <include src="file://{resources}/styles/custom_game/shop.css" />
    </styles>
    <scripts>
        <include src="file://{resources}/scripts/custom_game/shop.js" />
    </scripts>

    <Panel id="ShopRoot" class="ShopRoot">
        <Label class="ShopTitle" text="Shop" />
        <Panel id="ShopItems" class="ShopGrid" />
    </Panel>
</root>
`;

  const css = `.ShopRoot {
    flow-children: down;
    width: 360px;
    padding: 12px;
    horizontal-align: center;
    vertical-align: bottom;
    margin-bottom: 120px;
    border-radius: 8px;
    background-color: gradient( linear, 0% 0%, 0% 100%, from( #161b27f2 ), to( #0b0e16f2 ) );
    box-shadow: fill #000000a0 0px 2px 8px 0px;
}
.ShopTitle {
    font-size: 22px; font-weight: bold; horizontal-align: center; margin-bottom: 8px;
    color: gradient( linear, 0% 0%, 0% 100%, from( #ffffff ), to( #cf9b3e ) );
}
.ShopGrid { flow-children: right-wrap; width: 100%; }
.ShopCard {
    flow-children: down; width: 76px; height: 100px; margin: 4px; padding: 4px;
    border-radius: 6px; background-color: #232a3a;
    pre-transform-scale2d: 1.0; brightness: 1.0;
    transition-property: pre-transform-scale2d, brightness; transition-duration: 0.12s; transition-timing-function: ease-in-out;
}
.ShopCard:hover { pre-transform-scale2d: 1.05; brightness: 1.25; }
.ShopCard:active { pre-transform-scale2d: 0.95; }
.ShopCard DOTAItemImage { width: 64px; height: 48px; horizontal-align: center; }
.ShopName { font-size: 13px; color: #cfd6e6; horizontal-align: center; text-overflow: shrink; width: 100%; }
.ShopCost { font-size: 14px; color: #ffd24a; horizontal-align: center; }
.ShopCard.cant_afford { saturation: 0.2; }
.ShopCard.cant_afford .ShopCost { color: #ff6d6d; }
`;

  const js = `// Shop panel: renders item cards from CustomNetTables('shop','items') and buys via a
// custom event. Server validates gold + grants (see shop.lua). Net-table arrays arrive
// as objects keyed "1","2",... so we normalize.
(function () {
    "use strict";
    var grid = $("#ShopItems");

    function toArray(v) {
        if (!v) return [];
        if (Array.isArray(v)) return v;
        var a = [];
        for (var k in v) a.push(v[k]);
        return a;
    }

    var cards = []; // { panel, cost } — for live affordability styling

    function refreshAfford() {
        var gold = Players.GetGold(Players.GetLocalPlayer());
        for (var i = 0; i < cards.length; i++) cards[i].panel.SetHasClass("cant_afford", gold < cards[i].cost);
        $.Schedule(0.3, refreshAfford); // poll gold (no reliable client gold-change event)
    }

    function render(items) {
        if (!grid) return;
        grid.RemoveAndDeleteChildren();
        cards = [];
        items.forEach(function (it) {
            var card = $.CreatePanel("Panel", grid, "");
            card.AddClass("ShopCard");
            var img = $.CreatePanel("DOTAItemImage", card, "");
            img.itemname = it.id;
            var name = $.CreatePanel("Label", card, ""); name.AddClass("ShopName"); name.text = $.Localize(it.name || it.id);
            var cost = $.CreatePanel("Label", card, ""); cost.AddClass("ShopCost"); cost.text = (it.cost || 0) + "g";
            card.SetPanelEvent("onactivate", function () { GameEvents.SendCustomGameEventToServer("shop_buy", { item: it.id }); });
            card.SetPanelEvent("onmouseover", function () { $.DispatchEvent("DOTAShowAbilityTooltip", card, it.id); });
            card.SetPanelEvent("onmouseout", function () { $.DispatchEvent("DOTAHideAbilityTooltip", card); });
            cards.push({ panel: card, cost: it.cost || 0 });
        });
    }
    refreshAfford();

    var current = CustomNetTables.GetTableValue("shop", "items");
    if (current) render(toArray(current));
    CustomNetTables.SubscribeNetTableListener("shop", function (_t, key, val) {
        if (key === "items") render(toArray(val));
    });

    GameEvents.Subscribe("shop_result", function (d) {
        $.Msg("[shop] result: ", d);
    });
})();
`;

  const lua = `-- Shop: publishes its catalog to a net table, validates purchases server-side (gold
-- check), grants the item, and replies. Require from your game mode:  pcall(require, "shop")
-- then call Shop:Init() once the game is in progress.
if Shop == nil then Shop = class({}) end

-- Catalog. id must be a real item (item_lua or a base item). Edit freely.
Shop.ITEMS = Shop.ITEMS or {
    { id = "item_tango", name = "#DOTA_Item_Tango", cost = 90 },
    { id = "item_blink", name = "#DOTA_Item_Blink_Dagger", cost = 2250 },
    { id = "item_branches", name = "#DOTA_Item_Branches", cost = 50 },
}

function Shop:Init()
    CustomNetTables:SetTableValue("shop", "items", self.ITEMS)
    if not self._bound then
        self._bound = true
        CustomGameEventManager:RegisterListener("shop_buy", function(_, payload) self:OnBuy(payload) end)
    end
end

local function reply(pid, data)
    local p = PlayerResource:GetPlayer(pid)
    if p then CustomGameEventManager:Send_ServerToPlayer(p, "shop_result", data) end
end

function Shop:OnBuy(payload)
    local pid = payload.PlayerID
    local def
    for _, it in ipairs(self.ITEMS) do if it.id == payload.item then def = it break end end
    if not def then reply(pid, { ok = false, reason = "unknown item", item = payload.item }); return end
    if PlayerResource:GetGold(pid) < def.cost then
        reply(pid, { ok = false, reason = "not_enough_gold", item = def.id }); return
    end
    local hero = PlayerResource:GetSelectedHeroEntity(pid)
    if not hero or hero:IsNull() then reply(pid, { ok = false, reason = "no_hero", item = def.id }); return end
    PlayerResource:ModifyGold(pid, -def.cost, true, 0)
    local item = CreateItem(def.id, hero, hero)
    if item then hero:AddItem(item) end
    reply(pid, { ok = true, item = def.id })
end

return Shop
`;

  await writeGuarded(join(pan.layout, "shop.xml"), xml, !!opts.overwrite);
  await writeGuarded(join(pan.styles, "shop.css"), css, !!opts.overwrite);
  await writeGuarded(join(pan.scripts, "shop.js"), js, !!opts.overwrite);
  await writeGuarded(join(project.vscriptsOutDir, "shop.lua"), lua, !!opts.overwrite);
  r.created.push(join(pan.layout, "shop.xml"), join(pan.styles, "shop.css"), join(pan.scripts, "shop.js"), join(project.vscriptsOutDir, "shop.lua"));
  r.notes.push("Add shop.xml to custom_ui_manifest.xml. Load server: pcall(require, \"shop\") then Shop:Init() at GAME_IN_PROGRESS.");
  r.notes.push("Edit Shop.ITEMS to set your catalog. Purchases are validated server-side (gold check + grant) and replied via 'shop_result'.");
  return r;
}

// ---------------------------------------------------------------------------
// Talent / upgrade tree (tiered nodes, points, prereqs)
// ---------------------------------------------------------------------------
export interface ScaffoldTalentTreeOptions {
  overwrite?: boolean;
}

export async function scaffoldTalentTree(project: AddonProject, opts: ScaffoldTalentTreeOptions = {}): Promise<ScaffoldResult> {
  const r: ScaffoldResult = { created: [], modified: [], notes: [] };
  const pan = panoramaPaths(project);

  const xml = `<root>
    <styles>
        <include src="file://{resources}/styles/custom_game/talent_tree.css" />
    </styles>
    <scripts>
        <include src="file://{resources}/scripts/custom_game/talent_tree.js" />
    </scripts>

    <Panel id="TalentRoot" class="TalentRoot">
        <Label class="TalentTitle" text="Talents" />
        <Label id="TalentPoints" class="TalentPoints" text="" />
        <Panel id="TalentTiers" class="TalentTiers" />
    </Panel>
</root>
`;

  const css = `.TalentRoot {
    flow-children: down; width: 320px; padding: 12px; horizontal-align: center; vertical-align: center;
    border-radius: 8px; background-color: gradient( linear, 0% 0%, 0% 100%, from( #161b27f2 ), to( #0b0e16f2 ) );
    box-shadow: fill #000000a0 0px 2px 8px 0px;
}
.TalentTitle { font-size: 22px; font-weight: bold; horizontal-align: center; color: gradient( linear, 0% 0%, 0% 100%, from( #ffffff ), to( #cf9b3e ) ); }
.TalentPoints { font-size: 16px; color: #ffd24a; horizontal-align: center; margin-bottom: 8px; }
.TalentTier { flow-children: right; horizontal-align: center; margin: 4px 0px; }
.TalentNode {
    flow-children: down; width: 90px; height: 70px; margin: 4px; padding: 4px; border-radius: 6px;
    background-color: #232a3a;
    pre-transform-scale2d: 1.0; brightness: 1.0;
    transition-property: pre-transform-scale2d, brightness; transition-duration: 0.12s;
}
.TalentNode:hover { pre-transform-scale2d: 1.05; brightness: 1.2; }
.TalentName { font-size: 13px; color: #cfd6e6; horizontal-align: center; text-overflow: shrink; width: 100%; }
.TalentDesc { font-size: 11px; color: #8b93a7; horizontal-align: center; text-overflow: shrink; width: 100%; }
/* state classes the JS toggles */
.TalentNode.locked { saturation: 0.15; opacity: 0.6; }
.TalentNode.available { box-shadow: inset #ffd24a 0px 0px 1px 0px; animation-name: TalentGlow; animation-duration: 2.0s; animation-timing-function: ease-in-out; animation-iteration-count: infinite; }
.TalentNode.picked { box-shadow: inset #6dff8a 0px 0px 3px 0px; brightness: 1.1; }
@keyframes TalentGlow { 0% { box-shadow: inset #ffd24a 0px 0px 1px 0px; } 50% { box-shadow: inset #ffd24a 0px 0px 5px 0px; } 100% { box-shadow: inset #ffd24a 0px 0px 1px 0px; } }
`;

  const js = `// Talent tree: renders tiered nodes from CustomNetTables('talents','tree'), reflects the
// player's picked nodes + points, and picks via a custom event (server validates).
(function () {
    "use strict";
    var tiers = $("#TalentTiers"), pointsLabel = $("#TalentPoints");
    var pid = Players.GetLocalPlayer();
    var tree = [], picked = {}, points = 0;

    function toArray(v) { if (!v) return []; if (Array.isArray(v)) return v; var a = []; for (var k in v) a.push(v[k]); return a; }

    function render() {
        if (!tiers) return;
        tiers.RemoveAndDeleteChildren();
        pointsLabel.text = "Points: " + points;
        var byTier = {};
        tree.forEach(function (n) { (byTier[n.tier] = byTier[n.tier] || []).push(n); });
        Object.keys(byTier).sort().forEach(function (t) {
            var row = $.CreatePanel("Panel", tiers, ""); row.AddClass("TalentTier");
            byTier[t].forEach(function (n) {
                var node = $.CreatePanel("Panel", row, ""); node.AddClass("TalentNode");
                var name = $.CreatePanel("Label", node, ""); name.AddClass("TalentName"); name.text = n.name || n.id;
                var desc = $.CreatePanel("Label", node, ""); desc.AddClass("TalentDesc"); desc.text = (n.desc || "") + "  (" + (n.cost || 1) + ")";
                var isPicked = !!picked[n.id];
                var reqOk = !n.requires || !!picked[n.requires];
                var afford = points >= (n.cost || 1);
                node.SetHasClass("picked", isPicked);
                node.SetHasClass("available", !isPicked && reqOk && afford);
                node.SetHasClass("locked", !isPicked && (!reqOk || !afford));
                node.SetPanelEvent("onactivate", function () { GameEvents.SendCustomGameEventToServer("talent_pick", { node: n.id }); });
            });
        });
    }

    function loadTree(v) { tree = toArray(v); render(); }
    function loadPlayer(v) { if (!v) return; picked = {}; toArray(v.picked).forEach(function (id) { picked[id] = true; }); points = v.points || 0; render(); }

    var t = CustomNetTables.GetTableValue("talents", "tree"); if (t) loadTree(t);
    var pl = CustomNetTables.GetTableValue("talents", "player_" + pid); if (pl) loadPlayer(pl);
    CustomNetTables.SubscribeNetTableListener("talents", function (_t, key, val) {
        if (key === "tree") loadTree(val);
        else if (key === "player_" + pid) loadPlayer(val);
    });
    GameEvents.Subscribe("talent_result", function (d) { $.Msg("[talents] ", d); });
})();
`;

  const lua = `-- TalentTree: tiered upgrade nodes with point cost + prerequisites. Server validates
-- picks and applies effects; per-player state + the tree are published to a net table.
-- Require:  pcall(require, "talent_tree")  then TalentTree:Init() in-game.
if TalentTree == nil then TalentTree = class({}) end

-- Define your nodes. requires = a prerequisite node id (or nil). Wire effects in :Apply.
TalentTree.NODES = TalentTree.NODES or {
    { id = "t1_damage", tier = 1, cost = 1, name = "Power",     desc = "+10 dmg" },
    { id = "t1_health", tier = 1, cost = 1, name = "Vitality",  desc = "+200 hp" },
    { id = "t2_lifesteal", tier = 2, cost = 2, requires = "t1_damage", name = "Lifesteal", desc = "15%" },
    { id = "t2_regen",     tier = 2, cost = 2, requires = "t1_health", name = "Regen",     desc = "+5 hp/s" },
}
TalentTree._picked = TalentTree._picked or {}

function TalentTree:Init()
    CustomNetTables:SetTableValue("talents", "tree", self.NODES)
    if not self._bound then
        self._bound = true
        CustomGameEventManager:RegisterListener("talent_pick", function(_, p) self:OnPick(p) end)
    end
    -- Publish initial per-player state (points + picked) so the UI isn't blank before the
    -- first pick. Deferred so heroes exist (points are level-derived). Call Init at/after
    -- GAME_IN_PROGRESS; re-_sync on hero level-up if you want live point updates.
    GameRules:GetGameModeEntity():SetContextThink("TalentInitSync_" .. DoUniqueString("t"), function()
        for pid = 0, 23 do if PlayerResource:IsValidPlayerID(pid) then self:_sync(pid) end end
        return nil
    end, 2.0)
end

function TalentTree:_node(id) for _, n in ipairs(self.NODES) do if n.id == id then return n end end end

-- Available points. Default: hero level minus points spent. Customize freely.
function TalentTree:GetPoints(pid)
    local hero = PlayerResource:GetSelectedHeroEntity(pid)
    local level = (hero and not hero:IsNull()) and hero:GetLevel() or 0
    local spent = 0
    for id, _ in pairs(self._picked[pid] or {}) do local n = self:_node(id); if n then spent = spent + (n.cost or 1) end end
    return level - spent
end

function TalentTree:OnPick(payload)
    local pid = payload.PlayerID
    local node = self:_node(payload.node)
    if not node then return end
    self._picked[pid] = self._picked[pid] or {}
    if self._picked[pid][node.id] then return end
    if node.requires and not self._picked[pid][node.requires] then self:_reply(pid, { ok = false, reason = "locked" }); return end
    if self:GetPoints(pid) < (node.cost or 1) then self:_reply(pid, { ok = false, reason = "no_points" }); return end
    self._picked[pid][node.id] = true
    self:Apply(pid, node)
    self:_sync(pid)
    self:_reply(pid, { ok = true, node = node.id })
end

-- Hook your effects here (grant a modifier/ability or raw stats).
function TalentTree:Apply(pid, node)
    local hero = PlayerResource:GetSelectedHeroEntity(pid)
    if not hero or hero:IsNull() then return end
    -- if node.modifier then hero:AddNewModifier(hero, nil, node.modifier, {}) end
    -- if node.id == "t1_health" then hero:SetBaseMaxHealth(hero:GetBaseMaxHealth() + 200) end
end

function TalentTree:_sync(pid)
    local list = {}
    for id, _ in pairs(self._picked[pid] or {}) do list[#list + 1] = id end
    CustomNetTables:SetTableValue("talents", "player_" .. pid, { picked = list, points = self:GetPoints(pid) })
end

function TalentTree:_reply(pid, data)
    local p = PlayerResource:GetPlayer(pid)
    if p then CustomGameEventManager:Send_ServerToPlayer(p, "talent_result", data) end
end

return TalentTree
`;

  await writeGuarded(join(pan.layout, "talent_tree.xml"), xml, !!opts.overwrite);
  await writeGuarded(join(pan.styles, "talent_tree.css"), css, !!opts.overwrite);
  await writeGuarded(join(pan.scripts, "talent_tree.js"), js, !!opts.overwrite);
  await writeGuarded(join(project.vscriptsOutDir, "talent_tree.lua"), lua, !!opts.overwrite);
  r.created.push(join(pan.layout, "talent_tree.xml"), join(pan.styles, "talent_tree.css"), join(pan.scripts, "talent_tree.js"), join(project.vscriptsOutDir, "talent_tree.lua"));
  r.notes.push("Add talent_tree.xml to custom_ui_manifest.xml. Load server: pcall(require, \"talent_tree\") then TalentTree:Init().");
  r.notes.push("Edit TalentTree.NODES (tiers/cost/requires) and wire effects in TalentTree:Apply. Points default to hero level − spent.");
  return r;
}
