# Novel techniques from 11 fresh games

Total novel findings: 55

## Dota Run (id 469890148)
  * [architecture] Rubber-banding catch-up via rank-ordered base move speed (Mario-Kart 'blue shell'): Every second, players are ranked by remaining track distance, then assigned an ASCENDING SetBaseMoveSpeed (1st place = 360, each next rank +20), so whoever is behind is literally fastest. The leader is also captured into self.leadingPlayerID during the same pass for use by targeted hazards. This is a complete, self-contained competitive-racing rubber-band mechanic done entirely server-side with no client involvement. The KB covers economy/talent/think-loops but not a position-driven dynamic-speed catch-up system, which is reusable for any race/parkour/chase mode. (C:\Users\work\.dota2-workshop-mcp\reflib\items\469890148\files\scripts\vscripts\addon_game_mode.lua)
      function CDotaRun:BlueShell(playerPositions)
          local speed = 360
          for key, t in pairs( playerPositions ) do
              ...
              hero:SetBaseMoveSpeed(speed)
              speed = speed + 20
              if key == 1 then self.leadingPlayerID = playerID end
  * [architecture] Track-progress scalar by summing remaining checkpoint segments: Reusable 'how far along the track is each player' computation. On init it precomputes pairwise distances between ordered checkpoints once (self.waypointDistances). Each tick, for every player it walks checkpoints from last to first and: for any not-yet-crossed checkpoint adds the full precomputed segment length, and for the next uncrossed checkpoint adds the live vector distance from the hero to that checkpoint, then breaks. The result is a single comparable scalar of remaining distance, which is then table.sort-ed into race positions. This is the canonical racing 'progress along a polyline path' technique and is directly reusable for laps, escort missions, or any waypoint course. (C:\Users\work\.dota2-workshop-mcp\reflib\items\469890148\files\scripts\vscripts\addon_game_mode.lua)
      for w = #self.checkpoints-1,0,-1 do
          if (w > 0 and not self.waypoints[i][w]) then
              dist = dist + self.waypointDistances[w]
          else
              local distvec = self.checkpoints[w+1]:GetAbsOrigin() - player:GetAssignedHero():GetOrigin()
              dist = dist + distvec:Length2D()
              break
          end
      end
      self.playerDistances[i+1] = dist
  * [mapping] Procedurally generated guaranteed-solvable minefield (random-walk carved gap): setUpMines fills a grid (fLength x fHeight) with 'mine = true', then carves a guaranteed-traversable corridor through it using a biased random walk: it starts at a random row in column 0, sets that cell false (safe), and on each step either advances a column (60% chance) or jiggles the row up/down (staying in-bounds), marking each visited cell safe until it exits the grid. Only the remaining (still-true) cells are planted as stasis-trap mines, with a staggered timeout so traps appear sequentially. The net effect is a randomized minefield maze that is solvable-by-construction every round. The KB has wave/round spawners but no procedural-yet-always-passable hazard layout generator. (C:\Users\work\.dota2-workshop-mcp\reflib\items\469890148\files\scripts\vscripts\techies.lua)
      x = 0
      y = RandomInt(0, fHeight-1)
      stasisTrap[x][y] = false
      while (x < fLength+1) do
          if (RandomFloat(0, 1) > 0.6) then x = x + 1
          else
              if (y == 0 or y == fHeight-1) then y = 1
              else if (RandomInt(0,1)==0) then y=0 else y=2 end end
          end
          if (x <= fLength-1 and y <= fHeight-1) then stasisTrap[x][y] = false end
      end
  * [ai] Targeted anti-leader homing hazard with self-cleanup stuck-detection think: A catch-up hazard that punishes the front-runner specifically: a 'last man' player gains a charge_player ability that spawns an invulnerable Spirit Breaker unit which, after a 0.5s grace timer, CastAbilityOnTarget against the dynamically-tracked GameRules.dotaRun.leadingPlayerID's hero. The charger registers ChargerThink which compares the unit's current AbsOrigin to its position one think ago and self-Destroy()s if it hasn't moved (i.e. its charge finished or got stuck) — a lightweight stuck/idle detector for transient minion entities instead of a fixed lifetime. The combination of dynamic-leader targeting + position-delta self-cleanup is a reusable hazard pattern beyond the KB's boss-phase/kiting AI. (C:\Users\work\.dota2-workshop-mcp\reflib\items\469890148\files\scripts\vscripts\heroes\hero_spirit_breaker\charge.lua)
      function ChargerThink()
          if (lastPosition - charger:GetAbsOrigin() == Vector(0,0,0)) then -- has not moved
              charger:Destroy()
              return
          end
          lastPosition = charger:GetAbsOrigin()
          return 2
      end
  * [panorama-ui] Overlapping avatar 'pile' with geometric decaying offset (Panorama vote tally): When a vote arrives, ReceiveVote dynamically CreatePanels a hero-face panel per existing vote and positions it with an accumulating x-offset whose increment SHRINKS geometrically each iteration (offsetInc *= 0.9). The result is a row of hero portraits that fan out generously for the first few voters then compress tighter and tighter as the pile grows, packing many faces into bounded width without overflow or a scrollbar. It also derives the hero face class by string-substringing the unit name past the 'npc_dota_hero_' prefix to reuse hero-portrait CSS classes. This is a reusable Panorama 'stacked tokens / pile-of-avatars' layout trick distinct from the KB's standard list/scoreboard panels. (C:\Users\work\.dota2-workshop-mcp\reflib\items\469890148\files\panorama\scripts\custom_game\voting.js)
      for (var i = 0; i < count; i++) {
          offset += offsetInc;
          offsetInc *= 0.9;
      }
      var heroFace = $.CreatePanel("Panel", countHolder, "countPanel");
      heroFace.AddClass(hero);
      heroFace.style.position = offset+"px 0 0 0";

## Epic Boss Fight (305278898)
  * [combat] EHP rescale: bypass Dota's 32-bit health cap with a damage-reduction multiplier + Panorama display scaling: Dota caps unit health at a signed 32-bit int (~2.1B), and the engine HP bar/numbers choke far below that. This game gives bosses effectively unlimited HP by capping the REAL MaxHealth at 200000, computing an EHP_MULT = goalHP/200000, and then attaching a modifier that returns MODIFIER_PROPERTY_INCOMING_DAMAGE_PERCENTAGE = -(1 - 1/EHP_MULT)*100, so every point of real HP soaks EHP_MULT points of damage. Base health regen is divided by EHP_MULT so regen scales correctly too. A server think loop multiplies real GetHealth()/GetMaxHealth() by EHP_MULT and ships the 'effective' values (comma-formatted) to a custom Panorama HP bar. Net effect: a boss can display & behave as if it has billions of HP while the engine only ever tracks 0..200000. This is a clean, reusable pattern for any boss/tower-defense mode with huge-HP enemies and is non-obvious (the trick is combining a hard MaxHealth clamp with proportional damage reduction rather than fighting the int cap directly). (C:\Users\work\.dota2-workshop-mcp\reflib\items\305278898\files\scripts\vscripts\modifier\bosshealthrescale.lua)
      function bossManager:EHPFix(EHP_GOAL,HP) local Multiplier = (EHP_GOAL/HP) return Multiplier end
      ...
      if spawnedUnit.MaxEHP > 200000 then
        spawnedUnit:SetMaxHealth(200000)
        spawnedUnit:SetHealth(200000)
        local EHP_MULT = self:EHPFix(spawnedUnit.MaxEHP,200000)
        spawnedUnit.EHP_MULT = EHP_MULT
        spawnedUnit:SetBaseHealthRegen(spawnedUnit:GetBaseHealthRegen()/EHP_MULT)
        spawnedUnit:AddNewModifier(spawnedUnit, spawnedUnit, "bossHealthRescale",{})
      end
      --- in modifier:
      function bossHealthRescale:GetModifierIncomingDamage_Percentage(event)
        local EHPMult = self:GetParent().EHP_MULT
        local damagemult = (1-(1/EHPMult))*100
        return -damagemult
      end
  * [combat] Continuous-value element-combination spell system (Invoker-style, but power-driven decision tree): Instead of Invoker's discrete 3-orb combo lookup, this builds a spell out of three continuously-summed element powers. Each invoked orb contributes a scalar 'ellement_power' (from GetLevelSpecialValueFor) into running totals invocation_power_fire/wind/ice. A large decision tree then selects ONE of ~30 spells purely from the RATIOS and SUMS of those three floats (e.g. fire > (ice+wind)*1.5 picks a fire branch, then thresholds 2.5/5/10 pick spear vs multi-spear vs explosive; ice+fire > 2*wind picks steam/iceflame/water variants, etc.). Spell scale (damage, radius, projectile count, distance, slow stacks) is then computed as polynomial functions of those same floats. This is a genuinely different, highly data-extensible way to do a combine-elements caster: you tune one numeric power per element and the gameplay emerges from inequalities rather than a hard-coded combo table. (C:\Users\work\.dota2-workshop-mcp\reflib\items\305278898\files\scripts\vscripts\ellement\combination.lua)
      if fire > (ice + wind)*1.5 then --Very High Damage + DoT
        if fire > 2.51 and fire <= 5 then projectile_fire_spear( keys )
        elseif fire > 5 and fire <= 10 then projectile_multiple_fire_spear( keys , fire)
        elseif fire > 10 then projectile_fire_spear( keys )
        else poweraura( keys , fire) end
      elseif ice + fire > 2*wind then
        if fire >= 1.5*ice then ... steam_tempest/steam_trail ...
        elseif ice >= 1.5*fire then ... IceFlame_Ball/Explosive_IceFlame ...
        else water_tempest/water_stream end
  * [effects] Weighted RGB particle tint blended from gameplay scalars: The element caster colors its 'invoke' particle by treating three fixed RGB anchor colors as vectors and computing a power-weighted centroid: tint = (ice_color*ice_pow + fire_color*fire_pow + wind_color*wind_pow) / (ice_pow+fire_pow+wind_pow), then pushing it into a particle control point. This is a neat, reusable trick: drive a particle's color smoothly from arbitrary gameplay weights (resource levels, charge, faction mix) by doing barycentric color interpolation in Vector space and setting it on a CP, instead of authoring N separate colored particle systems. Non-obvious because Vector math (component-wise * and /) doubles as a color mixer. (C:\Users\work\.dota2-workshop-mcp\reflib\items\305278898\files\scripts\vscripts\ellement\combination.lua)
      local ice_color = Vector(0, 153, 204)
      local wind_color = Vector(204, 0, 153)
      local fire_color = Vector(255, 102, 0)
      ParticleManager:SetParticleControl(invoke_particle_effect, 2,
        ((ice_color * caster.invocation_power_ice) + (fire_color * caster.invocation_power_fire) + (wind_color * caster.invocation_power_wind))
        / (caster.invocation_power_ice + caster.invocation_power_wind + caster.invocation_power_fire))
  * [panorama-ui] In-game live model-attachment / cosmetic editor as a draggable Panorama dev tool: A self-contained Panorama tool for authoring model attachments WITHOUT leaving the running game. It implements a draggable floating window using the engine drag events ($.RegisterEventHandler('DragStart'/'DragEnd', ...) + GameUI.GetCursorPosition() to compute offsetX/offsetY against panel.actualxoffset/actualyoffset, and reparents the dragged panel to the context panel on drop). It live-edits attach point, scale, pitch/yaw/roll and X/Y/Z position offsets via +/- steppers with a selectable step multiplier dropdown, mirrors every change to the server (Attachment_UpdateAttach) for instant preview, offers Freeze/Save/Load/Hide, dynamically builds a cosmetics toggle list with $.CreatePanel + closure-captured onactivate handlers, and snaps the camera to top/side/normal via GameUI.SetCameraPitchMax/Min + SetCameraYaw. This is a reusable data-driven content-pipeline / dev-tooling pattern (build authoring UIs that run inside the live game and round-trip to vscript), and the drag-window + camera-lock + per-field stepper combo is not something covered by generic HUD docs. (C:\Users\work\.dota2-workshop-mcp\reflib\items\305278898\files\panorama\scripts\custom_game\barebones_attachments.js)
      var cursor = GameUI.GetCursorPosition();
      dragCallbacks.offsetX = cursor[0] - panel.actualxoffset;
      dragCallbacks.offsetY = cursor[1] - panel.actualyoffset;
      dragCallbacks.removePositionBeforeDrop = false;
      ...
      $.RegisterEventHandler( 'DragStart', $('#AttachmentsHeader'), OnDragStart );
      $.RegisterEventHandler( 'DragEnd', $('#AttachmentsHeader'), OnDragEnd );
      ...
      function TopCamera(){ GameUI.SetCameraPitchMax(90); GameUI.SetCameraPitchMin(90); GameUI.SetCameraYaw(0); }
  * [panorama-ui] HP/mana bar fill via animated CSS clip:rect() on a static art texture: Rather than animating width or using a procedural ProgressBar, the boss HP/mana bars reveal a fancy pre-authored bar texture by mutating style.clip = 'rect(top,right,bottom,left)' from script every update. The right edge is mapped through a calibrated affine transform ((current/total)*77.3 + 22.7 for HP, *63.1 + 27.0 for mana) so the visible clip window lines up with the non-rectangular artwork of the bar (the offset/scale account for art that doesn't start at 0% and isn't full-width). The base style declares clip: rect(0%,100%,100%,0%) and z-index layering so the fill sits over the frame. This is a distinct Panorama fill technique from the @keyframes/transform tricks already documented: it lets you fill arbitrarily-shaped/skinned bars by clipping a single image and is calibrated with per-bar magic constants rather than a 0-100% mapping. (C:\Users\work\.dota2-workshop-mcp\reflib\items\305278898\files\panorama\scripts\custom_game\hp_bar_boss.js)
      function update_hp_bar(arg){
        $("#hp_bar_parent_health").style.clip = "rect( 0% ," + ((arg.current_life/arg.total_life)*77.3+22.7) + "%" + ", 100% ,0% )";
      }
      function update_mana_bar(arg){
        $("#hp_bar_parent_mana").style.clip = "rect( 0% ," + ((arg.current_mana/arg.total_mana)*63.1+27.0) + "%" + ", 100% ,0% )";
      }

## Battle of Mirkwood (Battle Royale) (id 1092484716)
  * [panorama-ui] Battle-royale shrinking-zone circle drawn as an overlay on Dota's native minimap: Instead of a custom map widget, the game reaches into Dota's real minimap panel (FindChildTraverse('minimap_block')) and procedurally creates plain Panels with borderRadius:50% to draw the storm circle on top of it. World coordinates are converted to minimap pixel offsets with hand-derived constants (world half-extent 8176, minimap pixel size 260), the overlay panel has hittest=false so it never blocks minimap clicks/pings, and it shows a green 'predicted' circle first (sent 60s ahead via minimap_rescale_predict) which is then recolored white and promoted to the 'current' circle on the actual rescale event. A net-table fallback (minimap_rescale_data) lets late-loading/reconnecting clients reconstruct the circle. This is a reusable world-to-minimap overlay recipe that the KB's world-to-screen notes likely don't cover for the built-in minimap. (C:/Users/work/.dota2-workshop-mcp/reflib/items/1092484716/files/panorama/scripts/custom_game/overthrow_notification.js)
      var minimap = $.GetContextPanel().GetParent().GetParent().GetParent().FindChildTraverse("minimap_block");
      var maxx = 16352; var maxy = 16532;
      mPredictCircle = $.CreatePanel("Panel", minimap, "");
      var width = radius * 100 / 8176 * 260 / 100;
      var top = (8176 - y - radius) / 16352 * 260 - 11 + "px";
      var left = (8176 + x - radius) / 16352 * 260 - 11 + "px";
      mPredictCircle.hittest = false;
      mPredictCircle.style.borderRadius = "50% 50%";
  * [backend] Line-level Lua memory-allocation profiler via debug.sethook('l') + GC deltas: A vscript performance tool that installs a per-line debug hook (debug.sethook(recordAlloc, 'l')). On every executed line it reads collectgarbage('count'), computes the allocation delta since the previous line, and aggregates {count, total KB} keyed by 'source@line' using debug.getinfo(2,'S'). ShowRecord sorts by total bytes and prints the top-N allocation hotspots, exposed as a CHEAT console command 'debug_dump_lua_memory_detail'. This is a genuinely non-obvious, reusable way to find allocation/leak hotspots in Lua addons at line granularity — well beyond the generic profiling the KB documents. (C:/Users/work/.dota2-workshop-mcp/reflib/items/1092484716/files/scripts/vscripts/utils/lua_memory_usage.lua)
      local function recordAlloc(event, line_no)
          local memory_increased = collectgarbage("count") - current_memory
          if (memory_increased < 1e-6) then return end
          local info = debug.getinfo(2, "S").source
          info = string.format("%s@%s", info, line_no - 1)
          ...
      end
      debug.sethook(recordAlloc, "l")
  * [backend] HMAC-SHA1 request signing with canonical sorted-param string for the HTTP backend: The backend client signs every authenticated request to defeat tampering/forgery. makeSign builds a canonical string by sorting all param keys alphabetically, concatenating serviceID + each k..tostring(v) + the secret serviceKey, then returns sha1.hmac(serviceKey, str); the signature rides in an x-service-sign header alongside x-service-id. The secret is GetDedicatedServerKeyV2(serviceID) (only valid on a real dedicated server, gated by IsDedicatedServer()). It also does primary/fallback host failover (probes the prod URL, falls back to a test URL if down) before firing an OnReady queue, and per-player requests carry x-request-id/x-steamid/x-game headers. The KB notes 'HTTP backend with net-table server key' but not this sorted-canonical HMAC signing scheme, which is the reusable anti-tamper core. (C:/Users/work/.dota2-workshop-mcp/reflib/items/1092484716/files/scripts/vscripts/server/request.lua)
      function makeSign(params)
          local str = serviceID
          local serviceKey = GetDedicatedServerKeyV2(serviceID)
          local keys = {}
          for k in pairs(params) do table.insert(keys,k) end
          table.sort(keys)
          for _,k in pairs(keys) do str = str .. k .. tostring(params[k]) end
          str = str .. serviceKey
          return sha1.hmac(serviceKey, str)
      end
  * [effects] Data-driven parametric ballistic-arc motion controller with closed-form physics: A single reusable modifier (modifier_generic_arc_bom, on BaseModifierMotionBoth) makes ANY unit jump/arc to anywhere, fully parameterized by KV: target_x/y OR dir_x/y, distance, speed, duration (any two derive the third), apex height, and flags fix_end/fix_height/fix_duration, isStun/isRestricted/isForward, an OVERRIDE_ANIMATION activity passed via stack count, plus a SetEndCallback(interrupted) hook. The novelty is the closed-form ballistic solution in InitVerticalArc: it solves duration_end = (1+sqrt(1-height_end/height_max))/2 and precomputes const1/const2 so GetVerticalPos/GetVerticalSpeed are exact polynomials each frame — yielding a true parabola that respects differing start/end ground heights and a configurable apex, snapping to GetGroundHeight on landing. This is a drop-in 'toss/leap/knockback to point' component far more general than a hand-rolled per-ability jump. (Whole addon is compiled from TypeScript via TypeScriptToLua — note the dota_ts_adapter BaseModifierMotionBoth + registerModifier decorators + sourcemaps.) (C:/Users/work/.dota2-workshop-mcp/reflib/items/1092484716/files/scripts/vscripts/modifiers/modifier_generic_arc_bom.lua)
      local duration_end = (1 + math.sqrt(1 - (height_end / height_max))) / 2
      self.const1 = ((4 * height_max) * duration_end) / duration
      self.const2 = (((4 * height_max) * duration_end) * duration_end) / (duration * duration)
      -- GetVerticalPos:  (const1*t) - (const2*t*t)
      -- GetVerticalSpeed: const1 - 2*const2*t
  * [mapping] Build-time walkable-grid data pipeline + runtime cache pruned to the shrinking zone: A two-stage content pipeline for 'pick a random valid point'. At build time (IsInToolsMode-only) grid_position_finder.lua sweeps the whole map on a 128-unit grid, tests GridNav:CanFindPath from world center, and io.writes every reachable cell to data/grid_positions.lua (6772 entries shipped). At runtime GetRandomValidPosition lazily fills a cache (rejection-sampling RandomVector points until CanFindPath succeeds) and, once the BR zone shrinks, prunes the cache in one pass to drop every point outside the new circle (keyed by rescaleRadius so it only prunes once per stage) and biases new samples to rescaleCenter+RandomVector(0..radius). The combination — precomputed pathable grid as a checked-in Lua asset, plus a self-pruning runtime cache tied to a dynamic play area — is a reusable, non-obvious spawn/teleport-point system. (C:/Users/work/.dota2-workshop-mcp/reflib/items/1092484716/files/scripts/vscripts/utils/grid_position_finder.lua)
      for x = GetWorldMinX(), GetWorldMaxX(), 128 do
        for y = GetWorldMinY(), GetWorldMaxY(), 128 do
          if GridNav:CanFindPath(center, Vector(math.floor(x), math.floor(y), 256)) then
            file:write(',{x=' .. math.floor(x) .. ',y=' ..math.floor(y) .. '}\n')
          end
        end
      end

## Petri Reborn (483720948)
  * [panorama-ui] Respecting the player's own Dota keybinds for custom hotkeys (DOTAHotkey panel probe): Instead of hardcoding keys, the game discovers what key a player has currently bound to a named Dota action by spawning a throwaway native `DOTAHotkey` panel with `keybind:<name>`, reading the resolved key glyph out of its child label text, deleting the panel, then registering a custom Game.AddCommand and binding that exact key to it via Game.CreateCustomKeyBind. This lets a custom game add hotkeys (e.g. ShopToggle, PurchaseQuickbuy) that automatically match each player's existing keyboard layout/rebinds rather than forcing a fixed key. Verified actively used by shop.js. Non-obvious because DOTAHotkey is normally just a display widget; here it's used as a read-only query for the live keybind table. Exposed globally via GameUI.CustomUIConfig().RegisterKeyBind so any panel can use it. (C:/Users/work/.dota2-workshop-mcp/reflib/items/483720948/files/panorama/scripts/custom_game/hotkey_tracker.js)
      function GetKeyBind(name) {
      	$.CreatePanelWithProperties('DOTAHotkey', contextPanel, "", { keybind: name });
      	var keyElement = contextPanel.GetChild(contextPanel.GetChildCount() - 1);
      	keyElement.DeleteAsync(0);
      	return keyElement.GetChild(0).text;
      }
      function RegisterKeyBind(name, callback) {
         RegisterKeyBindHandler(name, callback);
         var key = GetKeyBind(name);
         if (key !== '') Game.CreateCustomKeyBind(key, 'petro_' + name);
      }
  * [panorama-ui] Hand-built HSV color picker in Panorama (no native control): A complete saturation/brightness square plus hue slider color picker implemented from scratch in Panorama, since Source 2 has no native color-wheel control. It tracks dragging with a self-rescheduling `$.Schedule(0.01, ...)` polling loop gated on GameUI.IsMouseDown(0)/hover, computes marker margins from GetPositionWithinWindow() and actuallayoutwidth, applies a layout-scale `multiplier` so it works at any panel size, and implements the full HSV<->RGB<->panel-position math (SetColorFromAngle hue ramp, HSBToRGB, RGBToHSV->HSVToPosition for setting an initial color). Exposes SetColor/RegisterEventHandler('OnColorChanged') so it is a reusable drop-in widget. This is a genuinely reusable Panorama UI component, not a CSS effect. (C:/Users/work/.dota2-workshop-mcp/reflib/items/483720948/files/panorama/scripts/custom_game/building_helper/colorpicker.js)
      function HSBToRGB() {
        var HSV = PositionToHSV();
        var H = HSV[0]; var V = HSV[2] * 255;
        var Vmin = (1 - HSV[1] * 1) * V;
        var a = (V - Vmin) * (H % 60) / 60;
        var Vinc = Vmin + a; var Vdec = V - a;
        var num = Math.floor(H / 60);
        switch(num){ case 0: case 6: return [V, Vinc, Vmin]; case 1: return [Vdec, V, Vmin]; ... }
      }
      function TrackMouseMarker(){ if (GameUI.IsMouseDown(0)){ ... SetPositionMarker(...); OnColorChanged( HSBToRGB() ); } ... $.Schedule(0.01, TrackMouseMarker); }
  * [panorama-ui] Hijacking Valve's built-in HUD controls (repurpose Radar/Scan button, restyle native buffs): A `Hack()` routine walks the panel tree up to the real `Hud` panel (while(parent.id != 'Hud') parent = parent.GetParent()) and then mutates Valve's own HUD instead of building parallel UI: it grabs the native RadarButton (the scan button), overrides its icon backgroundImage, hides its CooldownCover, and rebinds its `onactivate` PanelEvent to cast a custom ability on the local hero -- turning a stock Dota control into a custom-game button. It also loops Buff0..Buff29 to resize/restyle the native buff icons and their StackCount labels, hides AghsStatusContainer and the TP-scroll slot. Re-run on a delay so it survives HUD rebuilds. This is a reusable pattern for retrofitting custom behavior onto built-in HUD widgets rather than disabling+replacing them. Verified active (called at load and exposed as GameUI.CustomUIConfig().Hack). (C:/Users/work/.dota2-workshop-mcp/reflib/items/483720948/files/panorama/scripts/custom_game/shop.js)
      function Hack() {
      	var parent = $.GetContextPanel().GetParent();
      	while(parent.id != "Hud") parent = parent.GetParent();
      	...
      	var radar = parent.FindChildTraverse("RadarButton");
      	radar.FindChildTraverse("RadarIcon").style.backgroundImage = "url(\"s2r://panorama/images/hud/reborn/icon_scan_on_psd.vtex\");";
      	radar.FindChildTraverse("CooldownCover").visible = false;
      	radar.FindChildTraverse("RadarIcon").SetPanelEvent("onactivate", function () { ... cast custom ability ... });
      }
  * [panorama-ui] Custom right-click context menu by gutting the native ContextMenuScript panel: To attach a right-click menu (vote-kick) to scoreboard player rows, the game creates the engine's native `ContextMenuScript` panel type, then reaches into its default contents (contextMenu.GetContentsPanel().GetParent()), DropInputFocus + RemoveAndDeleteChildren() to wipe Valve's default menu, and BLoadLayout's its own menu layout into a fresh child -- passing per-row data (PlayerID) through panel attributes. Dismissal is done by dispatching the engine event 'DismissAllContextMenus' / DropInputFocus. This is a clean, reusable recipe for native-looking context menus populated from custom-game data, including auth gating (only shown if IsAllowedToKick). Pairs with a vscript side that can actually remove a real player via SendToServerConsole('kick '..name). (C:/Users/work/.dota2-workshop-mcp/reflib/items/483720948/files/panorama/scripts/custom_game/scoreboard/simple_scoreboard_updater.js)
      var contextMenu = $.CreatePanel( "ContextMenuScript", $.GetContextPanel(), "" );
      contextMenu.SetAcceptsFocus(false);
      var menu = contextMenu.GetContentsPanel().GetParent();
      $.DispatchEvent('DropInputFocus', menu);
      menu.RemoveAndDeleteChildren();
      var content = $.CreatePanel( "Panel", menu, "" );
      content.SetAttributeInt("PlayerID", playerID);
      content.BLoadLayout( "file://{resources}/layout/custom_game/scoreboard/scoreboard_context_menu.xml", false, false );
  * [architecture] Navmesh -> Panorama build-grid pipeline: binary+hex+RLE pack on server, screen-space particle grid with off-screen culling on client: A full data pipeline to expose the map's collision grid to client UI for build placement. Server side (gridnav.lua) walks every grid cell calling GridNav:IsTraversable/IsBlocked, packs the whole map into a bitstring, converts each 8 bits to hex, then run-length-encodes it but only emits the '(count)' form when it is actually shorter than the literal repeat (string.rep(prevChar,count):len() > strLen:len()), and ships it through a custom event plus an incremental 'LayersQueue' net table for per-region updates that self-clear after 15s. Client side (gnv.js) decodes the RLE/hex back into a 2D grid, and renders a build overlay as screen-space particles: it samples GameUI.GetScreenWorldPosition across the screen on a step grid, but instead of rebuilding every frame it only destroys quads that have scrolled off-screen (DestroyUnusedVisibleGridParticles via Game.WorldToScreenX/Y bounds) and re-seeds only newly exposed cells, and remaps only when the screen center moves >128 units. Configurable per-player (alpha/FPS/radius/grid-mode cycled with Alt). This RLE map-packing + screen-space-particle-culling combo is a substantial, reusable technique beyond stock placement ghosts. (C:/Users/work/.dota2-workshop-mcp/reflib/items/483720948/files/scripts/vscripts/libraries/gridnav.lua)
      function PackGNVTable( gnvTable, length )
        ...
          if prevChar ~= curChar then
            local strLen = "(" .. count .. ")"
            if string.rep(prevChar, count):len() > strLen:len() then
              table.insert(packedTable, prevChar); table.insert(packedTable, strLen)
            else
              table.insert(packedTable, string.rep(prevChar, count))
            end
            count = 0
          end
          count = count + 1; prevChar = curChar
        end
      -- client (gnv.js) only recreates quads that scrolled into view:
      -- if (scrX<0||scrX>Res[0]||scrY<0||scrY>Res[1]) Particles.DestroyParticleEffect(...) else keep

## Angel Arena Black Star (699441891)
  * [panorama-ui] Reaching into Valve's native HUD: root-panel traversal + event rebind + tooltip hijack: Instead of only adding custom Panorama panels, this game performs surgery on the SHIPPING Dota HUD. GetDotaHud() walks GetParent() from the context panel up to the root, then FindChildTraverse(id) reaches arbitrary native panels by id (minimap_block, ShopButton, StatBranch, level_stats_frame's LevelUpTab, ChatLinesPanel, topbar, combat_events, QuickBuyRows, stats_tooltip_region, PortraitContainer). It then HIDES native panels, and crucially REBINDS native buttons: shopbtn.ClearPanelEvent('onactivate'/'onmouseover'/'onmouseout') followed by SetPanelEvent to call the game's own shop/talent handlers. It even hijacks Valve's damage/armor tooltip by dispatching DOTAHUDShowDamageArmorTooltip and then SetDialogVariable on the live DOTAHUDDamageArmorTooltip panel to inject custom BAT/attack-speed/armor numbers. This is a general, reusable pattern for retheming/extending the stock HUD without replacing it, and the ClearPanelEvent-then-SetPanelEvent dance to override native onclick handlers is non-obvious. Custom panels are also pinned onto live HUD anchors via GetPositionWithinWindow() (PortraitContainer) and measured native element dimensions (minimap_block.actuallayoutwidth/contentwidth) so overlays track the real HUD exactly. (C:\Users\work\.dota2-workshop-mcp\reflib\items\699441891\files\panorama\scripts\custom_hud.js (and arena_util.js))
      function GetDotaHud() { var p = $.GetContextPanel(); while (true) { var parent = p.GetParent(); if (parent == null) return p; else p = parent; } }
      function FindDotaHudElement(id) { return hud.FindChildTraverse(id); }
      ...
      shopbtn.ClearPanelEvent('onactivate'); shopbtn.SetPanelEvent('onactivate', function() { ... CustomHooks.panorama_shop_open_close.call(); });
      stats_region.SetPanelEvent('onmouseover', function(){ $.DispatchEvent('DOTAHUDShowDamageArmorTooltip', stats_region); var DOTAHUDDamageArmorTooltip = FindDotaHudElement('DOTAHUDDamageArmorTooltip'); DOTAHUDDamageArmorTooltip.SetDialogVariable('seconds_per_attack', '('+secondsPerAttack.toFixed(2)+'s)'); ... }
  * [effects] Runtime cosmetic wearables with invisibility-synced fade + per-wearable particle remap: A from-scratch dynamic cosmetics system that attaches custom models to heroes at runtime, either via bone-merge (a dummy npc_arena_wearable unit that FollowEntity(unit,true) + SetModel) or via an attachment library. The clever part is keeping attached cosmetics consistent with the hero's visual state: a 1/30s timer reads unit:IsInvisible() and unit:HasModelChanged(), then encodes a desired invisibility level into a modifier StackCount (level*100). The modifier_arena_wearable declares MODIFIER_PROPERTY_INVISIBILITY_LEVEL and on the CLIENT decodes the stack back into a fractional invisibility level (stacks>100 ? (stacks-101)/100 : stacks/100), while on the SERVER it AddNoDraw/RemoveNoDraw past a threshold. Net effect: attached wearables fade/vanish exactly with the hero's invisibility/model-swap instead of floating visibly — a real gotcha most addons get wrong. It also MONKEY-PATCHES ParticleManager:CreateParticle so any particle name is rewritten per equipped wearable via a particleMap (TranslateParticleName), letting cosmetics override ability VFX transparently. (C:\Users\work\.dota2-workshop-mcp\reflib\items\699441891\files\scripts\vscripts\modules\dynamic_wearables\dynamic_wearables.lua (+ modifier_arena_wearable.lua))
      local itemInvisibilityLevel = heroInvisibilityLevel
      if modelChanged or wearable.entity.WearableVisible == false then itemInvisibilityLevel = itemInvisibilityLevel + 1.01 end
      modifier:SetStackCount(itemInvisibilityLevel * 100)
      -- client:
      function modifier_arena_wearable:GetModifierInvisibilityLevel()
        local stacks = self:GetStackCount()
        if stacks > 100 then return (stacks - 101) / 100 end
        return stacks / 100
      end
      -- monkey patch:
      function ParticleManager:CreateParticle(name, attach, unit, caster, ...) if caster or unit then name = DynamicWearables:TranslateParticleName(caster or unit, name) end ... end
  * [panorama-ui] BTTV/Twitch emote chat + scaleY(-1) reverse-flow auto-trimming chat: A fully custom chat rebuilt in Panorama on top of a server custom_chat_send_message/recieve_message round-trip. Two reusable tricks: (1) Streamer-emote support — it ships the full BetterTTV + Twitch emote name->id maps and builds word-boundary regexes (\b(name|name|...)\b) from the keys, then AddSmiles() replaces matched tokens with <img src='https://static-cdn.jtvnw.net/emoticons/...'/> / betterttv CDN URLs, proving Panorama <img> can load arbitrary REMOTE https images inside rich-text chat labels (html=true). (2) Reverse chat flow without a real reversed list: the container flows 'down' but each ChatLine label gets style.transform='scaleY(-1)' and is inserted with MoveChildBefore(msg, firstChild) so newest appears at the bottom and old lines push off the top, with a $.Schedule(7.5,...) adding an 'Expired' class to fade them. It also redirects NATIVE pause/unpause chat lines into the custom panel by regex-matching localized DOTA_Chat_* strings on the real ChatLinesPanel children and reparenting them. (C:\Users\work\.dota2-workshop-mcp\reflib\items\699441891\files\panorama\scripts\customchat.js (maps in chat_smiles.js))
      var twitchUrlMask = 'https://static-cdn.jtvnw.net/emoticons/v1/{id}/1.0';
      var twitchRegExp = new RegExp('\\b(' + Object.keys(twitchSmileMap).map(_.escapeRegExp).join('|') + ')\\b', 'g');
      function AddSmiles(string){ return string.replace(twitchRegExp, function(m){ return "<img src='"+twitchUrlMask.replace('{id}',twitchSmileMap[m])+"'/>"; })... }
      // reverse flow:
      msgBox.style.transform = 'scaleY(-1)'; msgBox.html = true; if (lastLine) rootPanel.MoveChildBefore(msgBox, lastLine);
  * [panorama-ui] Reading the player's REAL configured keybind via a throwaway <DOTAHotkey> panel: To make custom abilities/UI respect the player's own Dota hotkey config (rather than hardcoding keys), it spawns a hidden <DOTAHotkey keybind="..."/> child via BCreateChildren, reads back the resolved key text from that panel's generated child label, deletes it (DeleteAsync), then registers a matching engine binding with Game.CreateCustomKeyBind(key, command) wired to a Game.AddCommand handler. This 'render-a-DOTAHotkey-to-discover-the-bound-key' trick is the only reliable way to read a player's current keybind from Panorama, and the multiplexing handler (a dict of named callbacks per command so multiple subscribers share one key) makes it a clean reusable RegisterKeyBind(name, callback) API on GameUI.CustomUIConfig(). (C:\Users\work\.dota2-workshop-mcp\reflib\items\699441891\files\panorama\scripts\hotkey_tracker.js)
      function GetKeyBind(name) {
        contextPanel.BCreateChildren('<DOTAHotkey keybind="' + name + '" />');
        var keyElement = contextPanel.GetChild(contextPanel.GetChildCount() - 1);
        keyElement.DeleteAsync(0);
        return keyElement.GetChild(0).text;
      }
      ...
      if (key !== '') Game.CreateCustomKeyBind(key, GetCommandName(name));
  * [mapping] Custom minimap-overlay layer: server world->minimap %% projection pushed per-team, client point panels sized to native minimap: A reusable arbitrary-icons-on-minimap system Valve doesn't expose. Server side, DynamicMinimap keeps a point registry and converts world coords to minimap percentages with WorldPosToMinimap(vec) = (x+MAP_LENGTH)/(2*MAP_LENGTH) etc., returning a CSS 'x% y%' position string, then publishes per-team tables (dynamic_minimap_points_<team>) via PlayerTables with per-team visibility. Client side, _DynamicMinimapSubscribe creates one child Panel per point id (hittest=false) under a DynamicMinimapRoot that is sized/positioned to overlay the REAL native minimap_block (using its measured actuallayoutwidth/contentwidth), and just sets panel.style.position to the server's percentage string + adds style classes. This cleanly decouples gameplay (server registers/moves/destroys points, controls team fog) from rendering (pure CSS-positioned panels) and works for bosses/spawners/runes etc. (C:\Users\work\.dota2-workshop-mcp\reflib\items\699441891\files\scripts\vscripts\modules\dynamic_minimap\dynamic_minimap.lua (+ util/other.lua, arena_util.js, custom_hud.js))
      -- server
      function WorldPosToMinimap(vec)
        local pct1 = (vec.x + MAP_LENGTH) / (MAP_LENGTH * 2)
        local pct2 = (MAP_LENGTH - vec.y) / (MAP_LENGTH * 2)
        return pct1*100 .. "% " .. pct2*100 .. "%"
      end
      -- client
      panel = $.CreatePanel('Panel', minimapPanel, 'minimap_point_id_'+index); panel.hittest=false; panel.AddClass('icon');
      panel.style.position = changesObject[index].position + ' 0'; panel.visible = changesObject[index].visible === 1;
      // overlay sizing to native minimap:
      var minimap = FindDotaHudElement('minimap_block');
      $('#DynamicMinimapRoot').style.width = ((minimap.actuallayoutwidth + minimap.contentwidth - minimap.actuallayoutwidth)/sw*100)+'%';

## training polygon (813598504)
  * [backend] Runtime DB of the BASE GAME's KV files (not the addon's) via LoadKeyValues: DotaDB:Init() calls LoadKeyValues on Valve's shipping data files - scripts/npc/npc_abilities.txt, scripts/npc/npc_heroes.txt, scripts/npc/npc_units.txt, scripts/npc/items.txt - then iterates every hero and loads its per-hero file scripts/npc/heroes/<hero>.txt, MERGING all of those ability blocks into one flat self.abilities_KV[abilityName] lookup. This builds a complete, queryable in-memory database of every real Dota ability/hero/item/unit at runtime, with helpers GetAbilityKV(name), GetAllHeroes(), GetHeroByAbility() (which matches AbilityN keys), and a filtered GetAllAbilities() that strips seasonal/halloween/greevil/attributes entries. The whole DB is then shipped to Panorama via a 'dotadb_answer' custom event. Non-obvious because most addons hardcode spell values; this side-steps that by reading the game's own KV at runtime. The author's own comment notes the tradeoff: cast points/projectile speeds break on patch unless you read them from KV like this, but the KV structure itself can also change per patch. Reusable for any tool/sandbox that needs real ability metadata. (C:\Users\work\.dota2-workshop-mcp\reflib\items\813598504\files\scripts\vscripts\libraries\dota_database.lua)
      self.abilities_KV=LoadKeyValues("scripts/npc/npc_abilities.txt")
      self.heroes_KV=LoadKeyValues("scripts/npc/npc_heroes.txt")
      local heroTable=DotaDB:GetAllHeroes()
      for k,v in pairs(heroTable) do
        if v~="npc_dota_hero_base" and v~="Version" then
          heroAbilities=LoadKeyValues("scripts/npc/heroes/"..v..".txt")
          for kk,vv in pairs(heroAbilities) do
            if kk~="Version" then self.abilities_KV[kk]=vv end
          end
        end
      end
  * [combat] Sub-frame reaction-time benchmark from order/modifier/damage filters: A reaction-trainer measures how many milliseconds LATE the player reacted by timestamping three distinct engine callbacks with Time() and subtracting. OrderFilter detects the exact frame the player presses their dodge/escape ability (matched against a manta_skills list) and stores MANTA_CASTED_TIME=Time(). The incoming threat is timestamped at the moment it actually lands: OnEntityHurt sets MANTA_HERO_HURT_TIME for damage spells, while the ModifierGained filter sets MANTA_MODIFIER_GAINED specifically for hard-CC modifiers (modifier_stunned, modifier_medusa_stone_gaze_stone, modifier_axe_berserkers_call). The delta (badTime = MANTA_CASTED_TIME - MANTA_HERO_HURT_TIME) is the reaction delay; if abs(delta) < 1.5s it's reported to the UI as e.g. 'Bad! Delay: 0.087'. Using the correct landing event per spell category (damage vs debuff vs stun) is the clever part - it gives a precise, generalizable way to score human reaction latency against any spell. Same file also has evasionCheckerStun/Debuff/Target variants and a FrameTime() think-loop that re-issues a caster's order frame-by-frame if its cast was interrupted. (C:\Users\work\.dota2-workshop-mcp\reflib\items\813598504\files\scripts\vscripts\gamemodes\dodge_remake.lua)
      function dodge:OrderFilter(event)
        ... if ability_found==1 then MANTA_CASTED_TIME=Time() end
      function dodge:ModifierGained(event)
        if event['name_const']=="modifier_stunned" then MANTA_MODIFIER_GAINED=Time() end
      function dodge:OnEntityHurt(entCause,entVictim,damagingAbility)
        if entVictim==active_hero then MANTA_HERO_HURT_TIME=Time() end
      -- in casting.lua:
      local badTime=MANTA_CASTED_TIME-MANTA_HERO_HURT_TIME
  * [panorama-ui] Predictive spell-combo timeline ('pro-cast') driven by live distance + KV constants: A client-side overlay that tells the player the exact moment to press each key of a multi-spell combo. Every 0.05s it reads live AbsOrigin of hero and dummy target, computes 2D distance, and converts it to projectile/spell travel time with projectile_time = (distance - width/2) / speed (special-cased for AA Ice Blast's two-stage projectile). It then positions ability-icon markers along a fixed-width timeline bar: offset = bar_w - 100 - castpoint*100 - projectile_time*100. It additionally factors target Status Resistance into stun durations (TargetStatusResistance = 1 - sr/100) so e.g. Invoker EMP/Tornado, Kunkka X+Ghostship+Torrent, and Eul-into-combo sequences re-align in real time as units move and as the target's strength/SR is adjusted. This is a reusable pattern for any 'show me when to cast' trainer or combo-assist HUD: derive timing from KV speed/castpoint constants + live geometry rather than scripted timers. The accompanying timebar uses a manual Date.now()-delta 60fps width animation (animateOnTimeAppear) instead of a CSS transition, specifically so the bar position is queryable/sync-able at exact moments. (C:\Users\work\.dota2-workshop-mcp\reflib\items\813598504\files\panorama\scripts\custom_game\eul.js)
      var distance=Math.sqrt(Math.pow((heroPos[0]-enemyPos[0]),2)+Math.pow((heroPos[1]-enemyPos[1]),2))
      projectile_time=(distance-(vars.width/2))/vars.speed
      var offset=timing_bar_w-100-castpoint*100-projectile_time*100
      moveProcastMarker('timing_mark',offset)
      ... TargetStatusResistance=1-(data.sr.toFixed(3)/100)
  * [panorama-ui] Reading the engine's own NetGraph HUD label to get real ping into vscript: Instead of round-tripping a timestamp to measure latency, this walks up the default Dota HUD panel tree to the built-in net-graph widget and reads its already-rendered PING text label: Hud.FindChild('HUDElements').FindChild('NetGraph').FindChild('RightColumn_2').FindChild('NetGraph_PING'). It then forwards that string to the server every 5s via a 'store_ping' custom event, where ping_reader:SetPing() caches it for leaderboard display. It also guards with Game.IsInToolsMode() to skip in the editor. This is a genuinely non-obvious Panorama trick: FindChild-traversing Valve's own HUD to scrape engine-computed values that aren't otherwise exposed to custom games. The same traversal idea can scrape FPS (NetGraph_FPS) or other built-in HUD readouts. (The server-side code shows an abandoned alternative that tried Time()-sentTimestamp math and was commented out in favor of just trusting the HUD value.) (C:\Users\work\.dota2-workshop-mcp\reflib\items\813598504\files\panorama\scripts\custom_game\ping_reader.js)
      let Hud=$.GetContextPanel().GetParent().GetParent().GetParent()
      let ping_panel=Hud.FindChild('HUDElements').FindChild('NetGraph')
      let ping_label=ping_panel.FindChild('RightColumn_2').FindChild('NetGraph_PING')
      ...
      GameEvents.SendCustomGameEventToServer("store_ping",{"ping":ping_label.text})
  * [architecture] Turning a standard Dota map into a clean sandbox by stripping engine spawners + a per-frame cheat detector: OnFirstPlayerLoaded converts a normal Dota map ('dotaaaaa') into an ability-testing sandbox at runtime: it enumerates the engine's lane/neutral spawner entities by classname (npc_dota_neutral_spawner, npc_dota_spawner_good_top/mid/bot, npc_dota_spawner_bad_top/mid/bot) via Entities:FindAllByClassname and RemoveSelf()'s them so no creeps ever spawn, while picking a TRAINING_PLACE relocate point. It also precaches EVERY hero in npc_heroes.txt sequentially with PrecacheUnitByNameAsync(hero, cb, 0) - passing playerID 0 so the player's own equipped cosmetics load (the comment explains that since the Monster Hunter collab, omitting the playerID arg gives error models for non-default skins). Separately, InitGameMode wires up a Timers loop returning FrameTime() that watches GameRules:IsCheatMode() (skipped in tools mode) and pushes a 'Cheat mode detected' notice to clients the first time -cheats is enabled, a lightweight integrity flag for leaderboard submissions. Together these are a reusable recipe for 'standard map -> blank sandbox + skin-correct precache + cheat flag'. (C:\Users\work\.dota2-workshop-mcp\reflib\items\813598504\files\scripts\vscripts\gamemode.lua)
      local classes_to_remove={"npc_dota_neutral_spawner","npc_dota_spawner_good_bot",..."npc_dota_spawner_bad_bot"}
      for k,class_to_remove in pairs(classes_to_remove) do
        local spawns_to_remove=Entities:FindAllByClassname(class_to_remove)
        for k,v in pairs(spawns_to_remove) do v:RemoveSelf() end
      end
      -- skins-correct precache:
      PrecacheUnitByNameAsync(hero,function() ... end,0)
      -- cheat flag (per-frame):
      if GameRules:IsCheatMode() and CHEAT_MODE==0 then CustomGameEventManager:Send_ServerToAllClients("send_nudes",{nudes="Cheat mode detected"}) end

## Crumbling Island Arena (473718711)
  * [architecture] From-scratch React-style virtual-DOM reconciler for Panorama (structure.js + odiff.js): A hand-rolled declarative UI engine that is architecturally distinct from react-panorama (which our KB covers). You describe a UI subtree as a plain JS object tree (tag/id/class/style/children/dvars/onactivate/onChange...), and Structure.Create(parentPanel, structure) renders it. On every subsequent call it CLONES the new structure, runs odiff() (a generic recursive array/object diff that emits minimal set/rm/add patches with array index alignment), then walks the patch list IN REVERSE and applies only the minimal mutations to the live Panorama tree: $.CreatePanel / DeleteAsync / MoveChildBefore for child list changes, AddClass/RemoveClass diffing for 'class', per-key style diffing, SetDialogVariable(Int) for 'dvars', SetPanelEvent/ClearPanelEvent for events, and auto $.Localize for '#'-prefixed text with a localizeTargetMap so dvar changes re-localize. It also supports per-node onChange(panel,property,value) hooks fired when a specific value changes (used to retrigger CSS animations, e.g. score increment). This is React reconciliation (keyed-ish diff + patch instead of teardown/rebuild) implemented in raw Panorama JS, with odiff as the reusable diff core. Drop-in reusable: structure.js depends only on odiff.js + underscore _.compact and standard Panorama APIs. Used in production by scoreboard.js which re-renders the whole scoreboard from a net-table 'players' object 10x/sec without flicker. (panorama/scripts/custom_game/structure.js)
      var differences = odiff(oldStructure, structure);
      for (var change of differences.reverse()) {
        ... if (change.type === "set") { ... this.SetProperty(panel, property, val, originalValue); }
        if (change.type === "rm") { ... p.DeleteAsync(0); structurePanel.children.splice(...); }
        if (change.type === "add") { ... Structure.CreateStructureInternal(parent, val, atIndex); }
      }
  * [architecture] KV-embedded JS expression DSL evaluated client-side every frame (jsep + jsep_eval): Ability KV .txt files contain live JavaScript expressions as string values, which are parsed (jsep -> AST) and evaluated (jsep_eval, a 100-line tree-walking interpreter supporting binary/unary/logical/ternary/member/call/array nodes) on the CLIENT against a context built with Object.create(globalThis) plus a 'unit' field. Because the context prototypes off globalThis, any Panorama global is callable from the data string: real examples include MaxLength "400 + GetStackCount(unit, 'modifier_undying_q_health') * 60", Radius "HasModifier(unit, 'modifier_sven_r') ? 500 : 300", MaxLength "Entities.GetIdealSpeed(unit)", and MaxLength "GetGyroRocketDistance(unit)" (a JS helper defined in the same file). GetNumber() short-circuits plain numerics (IsNumeric) and only invokes the parser for formula strings, so it is cheap enough to run inside a 144Hz update loop. This turns ability config into a sandbox-free formula language: designers write conditional/stacking math in KV instead of hardcoding per-ability JS. The two files (jsep.js parser with a ternary plugin, jsep_eval.js evaluator) are a reusable, dependency-free formula engine for any data-driven Panorama system. (panorama/scripts/custom_game/target_indicator.js)
      function GetNumber(value, or, unit) {
          if (!value) return or;
          if (IsNumeric(value)) return value;
          const context = Object.create(globalThis);
          context.unit = unit;
          return evaluateExpressionNode(new Jsep(value).parse(), context)
      }
      // KV: "MaxLength" "400 + GetStackCount(unit, 'modifier_undying_q_health') * 60"
  * [effects] Fully data-driven client-side skillshot/targeting-reticle engine (~20 reticle types): A pure-client targeting indicator framework that renders ground-targeting reticles entirely in Panorama from net-table'd KV data, with NO server round-trip per frame. Server publishes 'targetingIndicators' and 'hoverIndicators' maps (keyed by ability name) into a net table; the client subscribes and, in a 1/144s $.Schedule loop, reads GetLocalPlayerActiveAbility() + GameUI.GetScreenWorldPosition(GetCursorPosition()) and drives a registry indicatorTypes[Type](data, unit) of ~20 reticle classes, each a constructor with Update(worldPos)/Delete() managing its own particles. Notable: it distinguishes ACTIVE targeting from a passive HoverIndicator/DisplayRange (range circle shown on hover), reconciles indicator lifecycle when the active/hover ability changes (Delete old, build new), and includes per-hero bespoke geometry done with vector math (Tiny avalanche bounce arcs that halve distance per bounce, WK triple-AoE at 120deg, AM dual offset dashes, gyro 3-spread lines, antimage curved twin lines via SetParticleControlTransformForward, ember remnant mirror line that auto-finds the remnant entity by classname/owner). Reusable pattern: register reticle types by string, drive from KV-per-ability + the jsep formula layer, all client-side at high refresh. (panorama/scripts/custom_game/target_indicator.js)
      function UpdateTargetIndicator(){
          $.Schedule(1 / 144, UpdateTargetIndicator);
          var active = Abilities.GetLocalPlayerActiveAbility();
          var data = targetingIndicators[Abilities.GetAbilityName(active)];
          if (active != lastAbility && data && data.Type) {
              indicator = new indicatorTypes[data.Type](data, unit);
          }
      }
      SubscribeToNetTableKey("main", "targetingIndicators", true, function(d){ targetingIndicators = d; });
  * [combat] Click-drag vector (directional) targeting UI with rangefinder particle CP mapping: Client half of a vector-targeting library (Earth-Spirit-roll style: cast direction = drag vector, not just a point). On a server-fired 'vector_target_order_start' it calls Abilities.ExecuteAbility to arm the spell, spawns a rangefinder particle, and in a 0.01s loop maps the drag (initialPosition -> current cursor world pos, clamped to min/max distance) onto particle control points via a string CP map ('initial'/'terminal'/'terminalArrow'/'midpoint' tokens resolved per-component to xyz). Two reusable subtleties: (1) a 'fast click-drag' mode polled at 1/120s in CheckDrag() that auto-completes the cast the instant the mouse button is RELEASED while the ability is active (Abilities.ExecuteAbility(...true)), giving drag-to-aim-release-to-cast feel; (2) it listens to dota_hud_error_message reason 105 (order queue full) and dota_update_selected_unit to robustly cancel/retry the order, with an INACTIVE_CANCEL_DELAY to dodge client/server race conditions. Pairs a vscript server lib with this client handler over custom game events (vector_target_order_start/cancel/finish/queue_full). (panorama/scripts/custom_game/vector_target.js)
      function CheckDrag() {
          if (eventKeys.abilId && VectorTarget.IsFastClickDragMode() && !GameUI.IsMouseDown(0)
              && Abilities.GetLocalPlayerActiveAbility() == eventKeys.abilId) {
              Abilities.ExecuteAbility(eventKeys.abilId, eventKeys.unitId, true);
          }
          $.Schedule(1 / 120, CheckDrag);
      }
      // reason 105 = full order queue -> retry prevEventKeys
  * [panorama-ui] Twitch/BTTV emotes in chat via remote HTTP <img> sources in Panorama HTML labels: In-chat emote rendering that loads images from the public internet directly into the Dota client. game_hud.js sets label.html = true and feeds it InsertEmotes(message,...), which HTML-escapes the text then regex word-boundary-replaces ~250 Twitch global emote codes and ~150 BetterTTV codes with <img src='...'> tags pointing at live CDNs (https://static-cdn.jtvnw.net/emoticons/v1/{id}/1.0 and https://cdn.betterttv.net/emote/{id}/1x). This demonstrates a non-obvious Panorama capability: an html=true Label will fetch and render REMOTE http(s) images, not just file:// assets. It also implements a 'golden Kappa' easter egg (top players' Kappa renders a bundled golden_kappa.png), a chat-wheel-icon prefix path, and ships the emote tables as data (with the commented-out scrape snippets used to generate them). Same file also routes a client-side-only custom event 'custom_chat_wheel' (GameEvents.SendEventClientSide) so chat-wheel messages render locally without a server hop. (panorama/scripts/custom_game/kappa.js)
      function ProcessEmote(input, template, emote, id) {
          var url = template.replace("{image_id}", id);
          return input.replace(new RegExp("\\b" + emote + "\\b", "g"), "<img src='" + url + "'/>");
      }
      var template = "https://static-cdn.jtvnw.net/emoticons/v1/{image_id}/1.0";
      // game_hud.js: label.html = true; label.SetDialogVariable("message", InsertEmotes(message, wasTopPlayer, wheel));

## WTF+ (1579522476)
  * [backend] Pure-Lua Blowfish cipher keyed by GetDedicatedServerKeyV3, used to encrypt a loadstring payload: packs/encoding.lua implements full Blowfish (P-array + 4 S-boxes from CONST_P/CONST_S, Feistel rounds in encipher_tuple/decipher_tuple, key schedule in cipher_init) on top of a hand-rolled base64. addon_init.lua keys it with the dedicated server's secret: `cipher_init(GetDedicatedServerKeyV3(...))` on the server and a fixed key on the client. server/script_host.lua then stores the privileged dedicated-server session-launch command as an encrypted base64 blob and runs `assert(loadstring(restore(blob)))(map, args)`. Because the chunk is encrypted with the server key, a player reading the decompiled VPK cannot recover or forge the command that relists/relaunches the match. This is a real anti-tamper / secret-hiding pattern (block cipher + keyed-by-server-secret + obfuscated loadstring) far beyond the KB's plaintext 'net-table server key'. Reusable for hiding any server-only command, backend secret, or save-code signing key. (scripts/vscripts/packs/encoding.lua)
      function encrypt(data)
      	data = to_bytes(data)
      	return to_base64(string.char(unpack(encipher(data))))
      end
      function restore(data)
      	data = to_bytes(from_base64(data))
      	return string.char(unpack(decipher(data)))
      end
      -- addon_init.lua: cipher_init(GetDedicatedServerKeyV3("__=opghbh124AQWE1tgm;;WHAT??"))
      -- script_host.lua: assert(loadstring(restore("Ds1f6aRVCUCBl/...==")))(map, table.concat(session_data, " "))
  * [backend] Dedicated-server session orchestration: server_spawn/shutdown events + programmatic new-session launch + on-demand UGC download: server/script_host.lua (CAddonScriptHost) listens to the rarely-used engine events server_spawn, server_pre_shutdown, server_shutdown, server_cvar, server_message, lobby_updated, match_details_updated and exposes lifecycle hooks (ServerSpawn/ServerPreShutdown/ServerShutdown). NewSession() asserts IsDedicatedServer(), assembles a session-config string from human keys mapped through an encrypted SESSION_KEY_REFERENCE table (lid/mode/ugc/dont_check stored as ciphertext) and invokes the obfuscated loadstring command to start a fresh map/session - i.e. the addon chains its own matches on a dedicated box. RequestUGCDownload() pulls other workshop content at runtime via `SendToServerConsole('sv_dota_custom_game_cache_test_download '..ugc_id)`, and on GAMERULES_STATE_INIT it auto-downloads the lobby's configured bot script (dota_bot_practice_script from GetGameSessionConfigValue). This is a self-hosting/match-chaining server controller, almost unheard of in shipped customs. (scripts/vscripts/server/script_host.lua)
      function CAddonScriptHost:NewSession(map, new_session_data)
      	assert(IsDedicatedServer(), "...must be called on the dedicated server.")
      	...
      	local str = restore("Ds1f6aRVCUCBl/V3Rde0qtbUm6T54FNlSauoyKty0OjLOSYECWuHczQa2ItxlznikAAQPUmAj6iP3jb9uMOK7w==")
      	assert(loadstring(str))(map, table.concat(session_data, " "))
      end
      function CAddonScriptHost:RequestUGCDownload(ugc_id)
      	if IsDedicatedServer() then
      		SendToServerConsole("sv_dota_custom_game_cache_test_download "..ugc_id)
  * [architecture] Per-client Murmurhash event key as a bidirectional auth + routing token (server learns it passively): Each panorama context generates `eventKey = Murmurhash2(RandomString(64))` once (api/init.js) and registers it with `register_key`. Server gameevents.lua monkey-patches CCustomGameEventManager:RegisterListener so EVERY inbound custom event is intercepted: it injects PlayerEntity/PlayerID and, if the event carries `_TeufortKey`, caches it as that player's key (player_keys[entindex]). All server->client sends (SendToPlayer/SendToTeam/SendToAll) then echo each player's own key back into the payload. On the client, GameEvents.Subscribe2 only fires the callback when the echoed _TeufortKey equals its own, and SendCustomGameEventToServer2 attaches it on the way out. Net effect: the key doubles as (a) an anti-spoof token the server can validate on inbound events and (b) a per-recipient routing filter so broadcasts can be ignored by contexts they're not addressed to - and the server discovers the key passively from any client event rather than pushing a shared key down a nettable. Cleverer and more granular than the KB's static server key. (scripts/vscripts/server/gameevents.lua)
      function CCustomGameEventManager:RegisterListener(event_name, callback)
      	return self:RegisterListener_Engine(event_name, function(event_source_index, event)
      		local player = EntIndexToHScript(event_source_index)
      		event.PlayerEntity = player; event.PlayerID = player:GetPlayerID()
      		if event[key_field_name] ~= nil then
      			self.player_keys[event_source_index] = event[key_field_name]
      		end
      		callback(event, event_source_index)
      	end)
      end
      // util.js: if (args._TeufortKey == GameUI.CustomUIConfig().eventKey) callback(args);
  * [mapping] Runtime playable-map bounds discovery via TraceHull from 6 sides toward center: server/common.lua CalculateMapAABB() determines the actual collision-bounded playable area at runtime instead of hardcoding map extents. It fires six TraceHull queries (using GetWorldMinX/MaxX/MinY/MaxY and WORLD_MIN/MAX_Z) - one per face of the world box - each a thin slab hull moving inward toward the map center, then assembles the AABB from the six hit points (Mins from left/down/bottom hits, Maxs from right/up/top hits). This yields the true walled boundary of any map without per-map config, useful for spawn clamping, camera limits, procedural placement, or out-of-bounds checks. The companion packs/unused/raytrace.lua adds a slab-method Ray:IntersectsBox / BoxIntersectionPoint and OBB/NPC ray-picking - custom CPU-side geometry math rarely seen in vscript. (scripts/vscripts/server/common.lua)
      function CalculateMapAABB(center)
      	local min_x, min_y, max_x, max_y, min_z, max_z = GetWorldMinX(), GetWorldMinY(), GetWorldMaxX(), GetWorldMaxY(), WORLD_MIN_Z, WORLD_MAX_Z
      	...
      	if TraceHull(params) and params.hit then result[i] = params.pos
      	...
      	return { Mins = Vector(result[1].x, result[2].y, result[3].z), Maxs = Vector(result[4].x, result[5].y, result[6].z) }
      end
  * [ai] Stack-based hierarchical bot-AI framework with a shared-blackboard multi-agent supervisor: entities/ai/base.lua defines a 3-tier reusable AI scaffold: CBaseAI (SetContextThink loop calling self.Actions[current_action], per-action return value = next delay, xpcall-guarded, exposes GetDebugString via OnEntText for in-game ent_text debugging) -> CStateMachineAI (action returns the next state name) -> CStackStateMachineAI (a true pushdown automaton: PushAction/PopAction/ReplaceAction maintain an ActionStack of {name, delay} pairs so behaviors nest and resume, e.g. attack_enemy PushAction 'cast_ability' which ReplaceActions to 'wait_ability_cast' then pops back). CAISupervisor runs several independent agents per unit (e.g. CWTFEasyBotAgent for combat + CEconomyAgent/itembuild_agent for shopping) all sharing one public_storage blackboard, so perception/intent written by one agent is read by others. Actions are plain functions on an Actions table, making behaviors data-like and composable. This is a clean, reusable bot-AI architecture (pushdown FSM + blackboard + multi-agent), well beyond the KB's generic 'think loop / kiting'. (scripts/vscripts/entities/ai/base.lua)
      function CStackStateMachineAI:PushAction(name, delay) table.insert(self.ActionStack, {name, delay}) end
      function CStackStateMachineAI:ReplaceAction(name, delay)
      	local ret = table.remove(self.ActionStack); table.insert(self.ActionStack, {name, delay}); return ret end
      function CStackStateMachineAI:PopAction() return table.remove(self.ActionStack) end
      function CStackStateMachineAI:NextAction()
      	... local stack_top = self.ActionStack[#self.ActionStack]
      	if stack_top ~= nil then self.current_action = stack_top[1] or self.default_action; return stack_top[2] end
      end
      -- CAISupervisor:Begin() sets one shared self.storage on every ai:SetPublicStorage(self.storage)

## Battle of Characters (511860561)
  * [effects] Offline-baked wall-normal "angle grid" for O(1) terrain bounce reflection: The custom physics engine pre-bakes the reflection normal of every blocked GridNav cell into a 2D array (anggrid). At map dev time a console command scans every cell; for each blocked cell it sums the unit vectors toward its 8 neighbors that are *open*, normalizes that sum to get the outward surface normal, and stores the angle. It also detects and skips corners/spikes: if the open neighbors form more than one contiguous segment ('OVERSEG') or 6+ neighbors are open ('PROTRUDE') it stores -1 (no clean normal). At runtime a projectile/physics-unit that hits a wall in BOUNCE mode just looks up anggrid[x][y], rotates Vector(1,0,0) by that angle to recover the normal, and reflects velocity in O(1) instead of expensively probing neighbor cells every collision. This is a genuinely clever data-driven collision-response baking technique not in our KB (we only document runtime FindUnitsInRadius/projectile bounce, not precomputed terrain-normal grids). (scripts/vscripts/physics.lua)
      if seg > 1 then
        print ('OVERSEG x=' .. i .. ' y=' .. j)
        anggrid[i+offsetX][j+offsetY] = -1
      elseif count > 5 then
        print ('PROTRUDE x=' .. i .. ' y=' .. j)
        anggrid[i+offsetX][j+offsetY] = -1
      ...
      local sum = sum:Normalized()
      local angle = math.floor((math.acos(Vector(1,0,0):Dot(sum:Normalized()))/ math.pi * 180))
      if sum.y < 0 then angle = -1 * angle end
      anggrid[i+offsetX][j+offsetY] = angle
      ...
      normal = RotatePosition(Vector(0,0,0), QAngle(0,angle,0), Vector(1,0,0))
  * [other] GridNav-to-text export pipeline (map-blockage bitmap + serialized angle grid) via console commands + InitLogFile: A set of FCVAR_CHEAT console commands turns the in-game map into reusable data files written to disk with InitLogFile/AppendToLogFile. The 'spider' command walks the whole world grid and emits a '1'/'0' bitmap of blocked cells (including manually-added WALL segments rasterized at 30-unit steps) in a format another tool can consume. The 'anggrid'/'angsave' commands bake the surface-normal grid (above) and serialize the entire 2D Lua table back out as a literal '{{..},{..}}' string. Notably the serializer uses a stack-based concatenation trick (addString) that merges equal-length fragments to keep string building near O(n) instead of Lua's naive O(n^2). This is a data-content pipeline / build-tooling technique (bake expensive map analysis once, ship it as a data file) that our KB does not cover. (scripts/vscripts/physics.lua)
      local addString = function (stack, s)
          table.insert(stack, s)    -- push 's' into the the stack
          for i=table.getn(stack)-1, 1, -1 do
            if string.len(stack[i]) > string.len(stack[i+1]) then break end
            stack[i] = stack[i] .. table.remove(stack)
          end
        end
      ... InitLogFile("addons/dotadash/" .. fname .. ".txt", s)
  * [panorama-ui] Full custom HUD inventory with native Panorama drag-drop item swapping + right-click context menus: This game replaces the default Dota inventory/HUD entirely and wires up Panorama's native drag-and-drop callback contract (DragStart/DragEnter/DragDrop/DragLeave/DragEnd registered via $.RegisterEventHandler, plus draggable panels). On DragStart it spawns a temporary DOTAItemImage as the drag visual and stashes m_DragItem/m_DragCompleted in panel .data(); a drop on another slot issues a real DOTA_UNIT_ORDER_MOVE_ITEM order to swap, while a drop on empty world triggers Game.DropItemAtCursor. Right-click spawns a DOTAContextMenuScript panel, toggles per-action classes (bSellable/bDisassemble/bDropFromStash/bAlertable) based on Items.* capability queries, and the menu buttons call Items.LocalPlayerSellItem / DisassembleItem / DropItemFromStash / ItemAlertAllies and dismiss via DispatchEvent('DismissAllContextMenus'). Our KB documents shops/HUD but not native drag-drop item reordering or DOTAContextMenuScript context menus — both are reusable Panorama techniques. (panorama/scripts/custom_game/inventory_item.js)
      var moveItemOrder = {
        OrderType: dotaunitorder_t.DOTA_UNIT_ORDER_MOVE_ITEM,
        TargetIndex: m_ItemSlot,
        AbilityIndex: draggedItem
      };
      Game.PrepareUnitOrders( moveItemOrder );
      ...
      var contextMenu = $.CreatePanel( "DOTAContextMenuScript", $.GetContextPanel(), "" );
      contextMenu.GetContentsPanel().SetHasClass( "bSellable", bSellable );
      contextMenu.GetContentsPanel().BLoadLayout( "file://{resources}/layout/custom_game/inventory_context_menu.xml", false, false );
  * [effects] Round-robin collider frame-spreading to amortize collision cost: The physics think loop runs at 100Hz over all colliders, but each collider can opt into being checked only every Nth frame via a per-collider skipFrames value combined with a globally-incrementing skipOffset so different colliders fire on different frames (load is spread, not bursty). The gate is a single modulo: (frameCount + collider.skipOffset) % (collider.skipFrames + 1) == 0. skipOffset is auto-assigned at AddCollider time (colliderSkipOffset++), guaranteeing an even phase distribution across many colliders. This is a concrete, reusable performance pattern for any high-frequency think system with many independent checks — not something our KB's think-loop notes capture. (scripts/vscripts/physics.lua)
      for name,collider in pairs(Physics.Colliders) do
        if collider.skipFrames == 0 or ((self.frameCount + collider.skipOffset) % (collider.skipFrames + 1) == 0) then
      ...
      collider.skipOffset = self.colliderSkipOffset
      self.colliderSkipOffset = self.colliderSkipOffset + 1
  * [panorama-ui] Repurposing the HeroSelection CustomUIElement as an in-arena duel-lobby / voting screen with host-gated controls: Instead of using the HeroSelection custom UI for picking a hero, the manifest injects the duel-setup layout (solo_duel.xml) into the HeroSelection slot, turning that lifecycle phase into an in-arena challenge/vote UI. Host-only controls are gated client-side by reading Game.GetLocalPlayerInfo().player_has_host_privileges and toggling a 'player_has_host_privileges' class, while votes/locks are sent to the server with GameEvents.SendCustomGameEventToServer('host_lock_option'/'foc_vote*'). The duel mechanic itself (server side) seats spectators at named map entities rad_sit_N/dire_sit_N via FindClearSpaceForUnit and swaps the challenge/accept abilities in place with SwapAbilities. The novel, reusable bit is the CustomUIElement-type repurposing (HeroSelection slot used for arbitrary lobby UI) plus the host-privilege-gated voting pattern — distinct from the standard GameSetup/team-select flows in our KB. (panorama/layout/custom_game/custom_ui_manifest.xml)
      <CustomUIElement type="HeroSelection" 		layoutfile="file://{resources}/layout/custom_game/solo_duel.xml" />
      ...
      $.GetContextPanel().SetHasClass( "player_has_host_privileges", playerInfo.player_has_host_privileges );
      GameEvents.SendCustomGameEventToServer("host_lock_option", {})

## Warlock Brawl (296662770)
  * [architecture] Sweep-and-prune broadphase + continuous collision detection (CCD) via binary heap: A from-scratch deterministic 2D collision pipeline that runs every fixed tick, completely independent of Dota's FindUnitsInRadius. Each frame it computes every collision component's swept X-axis extent (min/max over the frame, accounting for velocity*dt and sphere radius), pushes both the start (x-0.1) and end (x+0.1) into a min-heap, then sweeps in sorted X order maintaining an 'active set' so only objects whose X-intervals overlap are pairwise tested (sort-and-sweep / sweep-and-prune broadphase). For each candidate pair it solves the quadratic ((dp+dv*t)^2=(r1+r2)^2) for the exact sub-frame time-to-collision (CCD, so fast projectiles can't tunnel through thin targets), and collisions are resolved in time order from a second min-heap (actors are advanced to the precise collision instant via moveInTime(t), handled, then rewound). The +/-0.1 epsilon trick guarantees interval-starts sort before interval-ends at equal X. Nothing in the KB covers broadphase, CCD, swept volumes, or time-ordered resolution — KB only has radius queries. This is a reusable, generic physics core for any knockback/bumper/movement mod. (C:/Users/work/.dota2-workshop-mcp/reflib/items/296662770/files/scripts/vscripts/base/physics.lua)
      -- 0.1 is added/substracted so that starts are always sorted before ends (at the same x)
      		cc_heap:insert(x_start - 0.1, cc)
      		cc_heap:insert(x_end + 0.1, cc)
      ...
      		time_to_coll = _timeToCollision(cc1, cc2)
      		if time_to_coll >= 0 and time_to_coll <= dt then
      			self.phys_collisions:insert(time_to_coll, {cc1=cc1, n1=notify_1, cc2=cc2, n2=notify_2, ellastic=ellastic})
  * [architecture] Hybrid: Dota pathing velocity re-integrated into a unified custom physics world: Heroes are NOT moved by Dota's engine — they live as 'actors' in the custom velocity-based simulation, yet the game still lets players click-to-move normally. Each tick Pawn:onPreTick reads where Dota's pathing moved the unit (GetAbsOrigin - last sim location)/dt, clamps it to WALK_SPEED, and treats that as a 'walk_velocity' component of the actor's true physics velocity (subtracting last frame's walk contribution first so it composes cleanly with knockback/momentum). Then friction is applied to the non-walk part, the physics engine integrates everything, and Pawn:_updateLocation writes the authoritative result back via SetAbsOrigin. Because heroes, projectiles, and obstacles all share one velocity field with mass/elasticity/momentum, you get true elastic hero-vs-hero bouncing, knockback that scales with accumulated damage ('KB points' stored in the mana bar), and even projectiles that deflect OTHER projectiles (a gravity-well projectile injects velocity into nearby pawns AND projectiles in onPreTick). This 'physics-on-top-of-native-movement' bridge is the central reusable insight and is absent from the KB. (C:/Users/work/.dota2-workshop-mcp/reflib/items/296662770/files/scripts/vscripts/base/pawn.lua)
      -- remove previous walk vel
      	self.velocity = self.velocity - self.walk_velocity
      	-- apply friction
      	self.velocity = self.velocity * Config.FRICTION
      	-- get new walk velocity
      	self.walk_velocity = (self.unit:GetAbsOrigin() - self.location)/dt
      	self.walk_velocity.z = 0
      	if self.walk_velocity:Dot(self.walk_velocity) > self.WALK_SPEED_SQ then
      		self.walk_velocity = self.walk_velocity:Normalized() * self.WALK_SPEED end
      	self.velocity = self.velocity + self.walk_velocity
  * [ai] Potential-field gradient-descent dodging bot AI: A reusable bot framework that dodges incoming projectiles using a continuous scalar 'danger' field rather than scripted reactions. getDanger(loc) sums a 1/(1+d) contribution from every enemy projectile, where d is the perpendicular point-to-line distance from loc to that projectile's extrapolated trajectory (with cone/range gating so only projectiles actually heading toward the point count). getDodgeDirection then does a finite-difference gradient estimate — sampling danger at the bot's position and at small +X / +Y offsets — and steers down the negative gradient (away from the most dangerous direction). It also includes analytic lead/intercept aiming (getPredictedDir solves the interception quadratic for a moving target) and a danger-threshold to cancel channels and flee. KB only lists generic 'kiting' and 'FindUnitsInRadius targeting'; a danger-potential-field + numerical gradient steering AI is a genuinely different, reusable technique. (C:/Users/work/.dota2-workshop-mcp/reflib/items/296662770/files/scripts/vscripts/base/aicontroller.lua)
      local danger_self = self:getDanger(self.pawn.location)
          local danger_right = self:getDanger(self.pawn.location + Vector(1, 0, 0) * self.danger_dodge_delta)
          local danger_up = self:getDanger(self.pawn.location + Vector(0, 1, 0) * self.danger_dodge_delta)
          local dir = Vector(danger_self - danger_right, danger_self - danger_up)
      ...
          local line_dst = math.abs(delta.y * loc.x - delta.x * loc.y + proj_new_loc.x * proj.location.y - proj_new_loc.y * proj.location.x) / delta:Length()
          danger = danger + self.danger_scale / (1.0 + line_dst)
  * [combat] Arc-length-reparameterized analytic curve flight injected as physics velocity: The 'twin' projectile flies a true ellipse (semi-axes derived from cast distance and a fixed enclosed area) but moves at CONSTANT linear speed along the curve, not constant parameter rate. Each tick it computes the analytic tangent dEllipse/dt = (-a*sin t, b*cos t), then scales the parameter step ellipse_dt = dt*speed / |dEllipse/dt| so the actual arc-length traveled per frame is constant (arc-length reparameterization). Crucially it does not teleport the unit along the curve: it converts the parametric displacement into a velocity, rotates it into world space by the cast direction, and INJECTS it into the shared physics engine by subtracting the previous frame's contribution and adding the new one (velocity = velocity - old_applied + new_applied). That means the elliptical motion still composes with collisions, knockback and deflection from other systems, and reflectVelocity also reflects the ellipse's orientation vector. A reusable recipe for 'fly an arbitrary analytic path at constant speed while remaining a first-class physics body'. (C:/Users/work/.dota2-workshop-mcp/reflib/items/296662770/files/scripts/vscripts/warlock/projectiles/twinprojectile.lua)
      local ellipse_vel = self:getEllipseVelocity()
      	local ellipse_dt = dt * self.speed / ellipse_vel:Length()
      	ellipse_dt = max(0.001, ellipse_dt)
      	self.ellipse_t = min(math.pi, self.ellipse_t + ellipse_dt)
      ...
      	local unrotated_velocity = (ellipse_loc - self.virtual_location) / dt
      	local new_applied_velocity = self:rotateEllipseVector(unrotated_velocity)
      	local old_applied_velocity = self:rotateEllipseVector(self.prev_unrotated_velocity)
      	self.velocity = self.velocity - old_applied_velocity + new_applied_velocity
  * [mapping] Precomputed bidirectional ring-delta arena with packed transform-style ints: The shrinking circular platform is data-driven by a precomputed LAYERS table: each layer transition stores explicit forward AND backward deltas as {add, remove, change} lists of grid tiles, so growing or shrinking the arena is O(ring) and exactly reversible without recomputing geometry. Each tile carries a single packed 'style' integer that encodes BOTH rotation and mesh variant: yaw = (style % 4) * 90, tile_type = floor(style / 4) + 1 — so one small int picks among rounded-corner edge models AND their 4 orientations to seamlessly tile a circle out of square props. Tile removal isn't instant: a per-tile 0.05s task sinks the prop's Z while fading its render color (lava reveal), then destroys it at the floor height. isLocationSafe maps world XY back to the grid to apply lava DPS. A reusable pattern for reversible, animated, data-driven destructible terrain built from a small set of rotated edge meshes. (C:/Users/work/.dota2-workshop-mcp/reflib/items/296662770/files/scripts/vscripts/base/arena.lua)
      function Arena:setTileStyle(grid_x, grid_y, style)
          local yaw = (style % 4) * 90
          local tile_type = math.floor(style / 4) + 1
          tile:SetAngles(0, yaw, 0)
          tile:SetModel(Arena.tile_model[tile_type])
      ...
      -- forward = { add={...}, remove={}, change={...} }, backward = { add={}, remove={...}, change={...} }

## OVERTHROW 3.0 (id 2760533777)
  * [backend] Reliable client→server events: ACK + adaptive-RTT retry + per-client anti-spoof token: protected_events.js builds a delivery layer on top of SendCustomGameEventToServer that our KB's plain 'RPC via correlation id' does NOT cover. Three non-obvious pieces: (1) SendToServerEnsured tags every payload with a unique _id, then ScheduleRetry re-sends the SAME payload on an interval until the server replies with EventStream:ack{ack_id}; the matching ACK cancels the scheduled retry. (2) The retry delay self-calibrates: on each ACK it measures recv-sent RTT, applies a 2x pessimistic multiplier (floored at 1/30s), and folds it into a running average DEFAULT_RETRY_DELAY = (n*old + ping)/(n+1) — so the system learns the player's ping with no server config. (3) Anti-spoof: each client generates a random _PROTECTED_TOKEN, registers it with the server (ProtectedEvents:set_token), and SubscribeProtected drops any incoming server event whose protected_token != this client's — preventing a cheater from injecting events that drive another player's custom UI. Reusable as a drop-in 'guaranteed delivery + authenticated events' library for any custom game. (C:/Users/work/.dota2-workshop-mcp/reflib/items/2760533777/files/panorama/layout/custom_game/scripts/protected_events.js)
      const bare_ping = recv_time - event_entry.sent_time;
      const pessimistic_ping = Math.max(2 * bare_ping, MIN_PESSIMISTIC_PING);
      // average ping through all events accepted
      DEFAULT_RETRY_DELAY = (ACK_EVENTS_COUNT * DEFAULT_RETRY_DELAY + pessimistic_ping) / (ACK_EVENTS_COUNT + 1);
      ...
      if (Game.GetLocalPlayerID() == -1 || GameEvents._PROTECTED_TOKEN == event.protected_token) { callback(event.event_data); } else { throw `Registered event ${event_name} has wrong server token` }
  * [panorama-ui] Augmenting Dota's BUILT-IN ability/Aghs/innate tooltips by injecting live panels (te_lock re-dispatch): tooltip_extender.js does not build custom tooltips — it hijacks Valve's native ones. It RegisterForUnhandledEvent's the engine's own tooltip events (DOTAShowAbilityTooltip, DOTAHUDShowAghsStatusTooltip, DOTAShowInnateTooltip, DOTAShowDroppedItemTooltip, etc.), reaches into the live FindDotaHudElement('Tooltips') DOM, and inserts extra DOTAAghsDescription / hint panels (CreateExtender, MoveChildAfter) into the real tooltip while it's open. The load-bearing trick is panel.te_lock: after it mutates the tooltip's children it re-dispatches the SAME tooltip event ($.DispatchEvent(event_name,...)) to force the engine to re-layout the now-larger tooltip, and uses te_lock as a one-shot guard so the re-dispatch doesn't recurse. It also fixes the side effect of a taller tooltip by measuring GetPositionWithinWindow vs Game.GetScreenHeight and applying a negative marginTop so the injected content doesn't clip off-screen. A reusable recipe for 'add data to stock Dota tooltips' that's far beyond the KB's custom-tooltip entries. (C:/Users/work/.dota2-workshop-mcp/reflib/items/2760533777/files/panorama/layout/custom_game/tooltip_extender/tooltip_extender.js)
      panel.te_lock = true;
      $.DispatchEvent("DOTAHUDShowAghsStatusTooltip", panel, -1, hero_id);
      ...
      const pos = aghs_tooltips.GetPositionWithinWindow();
      const bottom_space = Game.GetScreenHeight() - aghs_tooltips.actuallayoutheight - pos.y;
      ...
      if (extra_space > 0) aghs_tooltips.style.marginTop = `-${extra_space}px`;
  * [effects] Particle control points as a per-frame data bus for a world-space 'danger range' overlay: fountain_range.js renders the 'you are in enemy fountain/tower range' warning entirely through a single .vpcf whose shader is driven live from Panorama. Instead of redrawing UI, it computes each frame (in a $.Schedule(0,...) loop) the hero's distance to the source, whether it's within attack range (is_targeted) or range+aura buffer (is_in_range), and the projected position, then pushes those as plain numbers into particle control points: CP6 = in-range flag, CP7 = the target position to draw toward, CP13 = packed [is_in_range, is_targeted, danger_level]. SetParticleAlwaysSimulate keeps it ticking off-screen. Holding Alt forces a full preview. This treats CPs not as one-time spawn config but as a continuous client→shader data channel for an interactive overlay — a pattern not in the KB's particle entries (which only cover spawn→setCP→release and damage numbers). (C:/Users/work/.dota2-workshop-mcp/reflib/items/2760533777/files/panorama/layout/custom_game/scripts/fountain_range.js)
      let is_in_range = distance <= current_attack_radius + aura_bonus_range;
      let is_targeted = distance <= current_attack_radius;
      let target_position = is_in_range ? current_pos : config.position;
      ...
      Particles.SetParticleControl(config.p_id, 6, [is_in_range ? 1 : 0, 0, 0]);
      Particles.SetParticleControl(config.p_id, 7, target_position);
      Particles.SetParticleControl(config.p_id, 13, [is_targeted, is_targeted, 2]);
      $.Schedule(0, UpdateFountainParticles);
  * [panorama-ui] Alt-click a stock HUD buff/debuff icon to broadcast that modifier to chat (with anti-spam throttle): ping_modifiers_fix.js adds a brand-new interaction to Valve's default buff bar: it walks the live FindDotaHudElement('buffs'/'debuffs') containers, attaches onactivate to each modifier icon, and on Alt+click resolves WHICH buff was clicked by index into the portrait unit's visible, non-hidden buff list (GetBuffBySerialNumber skips Buffs.IsHidden and filters by IsDebuff to map panel position → modifier serial). It localizes DOTA_Tooltip_<modifier> (bailing if there's no loc string) and fires a server event so teammates get a chat/ping of that exact modifier. It also ships a hand-rolled rate limiter — SPAM_COUNT_LIMIT pings, then a SPAM_COOLDOWN lockout, with a sliding ANTI_SPAM_DELAY window — to stop chat flooding. Novel because it bolts gameplay communication onto an engine HUD element the mod never created, and solves the 'which native buff did the user click' indexing problem. (C:/Users/work/.dota2-workshop-mcp/reflib/items/2760533777/files/panorama/layout/custom_game/scripts/ping_modifiers_fix.js)
      let mod_id = Entities.GetBuff(entity_id, i);
      if (mod_id == -1 || Buffs.IsHidden(entity_id, mod_id)) continue;
      if (Buffs.IsDebuff(entity_id, mod_id)) { if (!check_debuffs) continue; } else if (check_debuffs) continue;
      if (counter == n_serial) return mod_id;
      ...
      GameEvents.SendToServerEnsured("PingModifeirs:ping", { target_entity: portrait_unit, modifier_name: modifier_name });
  * [panorama-ui] Reusing Dota's native red error popup for custom localized messages via dota_hud_error_message reason:80: display_custom_error.js shows a cheap way to surface custom server-driven messages without building any UI: emit the ENGINE's own client-side event dota_hud_error_message with reason: 80 (a reason code that maps to a free-form message) and splitscreenplayer: 0, and Dota renders it in its standard red action-error banner (the same one used for 'cannot cast there'). DisplayCustomErrorWithValue adds ##key## token interpolation over a $.Localize'd template before sending. This reuses first-party HUD feedback the mod could otherwise never trigger. (Same file/dir also reveals a build-time codegen pipeline: innates_auto_generated.js is emitted from innates.mjs via 'npm run innates', a data-driven content pipeline generating Panorama JS lookup tables.) (C:/Users/work/.dota2-workshop-mcp/reflib/items/2760533777/files/panorama/layout/custom_game/scripts/display_custom_error.js)
      GameEvents.SendEventClientSide("dota_hud_error_message", {
        splitscreenplayer: 0,
        reason: 80,
        message: event.message,
      });
