# Novel techniques (batch 2) — 45 findings from 9 games

## Epic Boss Fight Reborn (id 1844502841)
  * [AI/combat] MMO-style threat/aggro table for boss targeting (data-driven AbilityThreat): A full World-of-Warcraft-style 'tank aggro' system layered onto Dota AI, which is meaningfully different from the kiting / potential-field / blackboard bot AI already in the KB. Each hero carries a numeric `threat` field; abilities/items declare an `AbilityThreat` value in their KV (e.g. boots have AbilityThreat -25 = a deliberate 'drop aggro' item), read via a custom `CDOTABaseAbility:GetThreat()`/`CDOTA_BaseNPC:ModifyThreat()`. The boss AI's `AttackHighestPriority` then (a) targets the highest-threat hero, (b) applies HYSTERESIS so it only switches targets when a rival's threat exceeds the current target by `5 * AIbehavior` (aggressive/cautious/safe personalities raise the switch threshold), and (c) keeps target STICKINESS via a per-target timer that only drops aggro after 1.5s of lost vision (AIPreviousTargetTimerTicker). `PlayerResource:SortThreat()` ranks heroes into aggro=1 (primary) / aggro=2 (secondary) / 0 and pushes a per-player `Update_threat` event so each client can render its own aggro rank. Files: scripts/vscripts/libraries/utility.lua (threat accessors + SortThreat), scripts/vscripts/ai/ai_core.lua (hysteresis + stickiness), scripts/vscripts/addon_game_mode.lua:1529 (SortThreat), scripts/npc/items/item_boots.txt (AbilityThreat -25). (C:/Users/work/.dota2-workshop-mcp/reflib/items/1844502841/files/scripts/vscripts/ai/ai_core.lua + libraries/utility.lua:851-910)
      elseif entity.AIprevioustarget and enemy:IsAlive() and enemy.threat > minThreat + 5*(entity.AIbehavior or 1) and distanceToEnemy < range then
          minThreat = enemy.threat
          target = enemy
          entity.AIprevioustarget = target
      end
      -- stickiness: only drop a target after 1.5s of no vision
      if entity.AIprevioustarget and ... and entity.AIPreviousTargetTimerTicker < 1.5 then target = entity.AIprevioustarget end
      -- SortThreat -> aggro rank pushed per-player:
      if unit == aggrosecond then unit.aggro = 2 elseif unit == aggrounit then unit.aggro = 1 else unit.aggro = 0 end
      CustomGameEventManager:Send_ServerToPlayer( player, "Update_threat", {threat=self.threat, aggro=self.aggro} )
  * [engine workarounds / architecture] Custom ability-metadata layer via GameRules.AbilityKV (non-engine KV keys): A reusable pattern for attaching arbitrary metadata to abilities/items that the engine itself ignores. All ability/item KV files are pre-parsed into a `GameRules.AbilityKV[abilityName]` table, then extended C-method-style accessors read CUSTOM keys the engine has no concept of: `AbilityThreat` (aggro weight), `PiercesDisableReduction`, `InnateAbility`, `IsAetherAmplified`, etc. This lets designers tune gameplay-system behavior purely in data (the same .txt KV files) without per-ability Lua, and gives a single lookup point that works for both datadriven and lua abilities. It's a clean 'extend the data schema, not the code' technique distinct from custom modifiers / talent systems in the KB. (C:/Users/work/.dota2-workshop-mcp/reflib/items/1844502841/files/scripts/vscripts/libraries/utility.lua:730-858)
      function CDOTABaseAbility:GetThreat()
          if GameRules.AbilityKV[self:GetName()] then
              return GameRules.AbilityKV[self:GetName()]["AbilityThreat"] or 0
          end
          return 0
      end
      function CDOTABaseAbility:IsAetherAmplified()
          if GameRules.AbilityKV[self:GetName()] then
              local truefalse = GameRules.AbilityKV[self:GetName()]["IsAetherAmplified"] or 1 ...
  * [architecture / data pipelines] Client->server JSON upload over registered convar commands (GDSOptions lobby pull): A non-obvious client->server RPC channel distinct from CustomGameEvents and net tables. To pull lobby-difficulty options from a web backend (which only the CLIENT can reach), the server registers console commands with `Convars:RegisterCommand('gds_send_part'/'gds_send_options'/'gds_failure', ...)`, fires a game event telling the host client to fetch options for its steamID, and the client then UPLOADS the resulting JSON back to the server by invoking those commands. Because a single convar-command arg has length limits, the payload is sent CHUNKED (gds_send_part appended repeatedly, then gds_send_options to finalize) and double-quotes are escaped as `&qt!` to survive convar parsing. The server authenticates the uploader with `Convars:GetCommandClient():GetPlayerID()` and accepts only from the designated host. Reusable any time the server needs data only a client can obtain. (C:/Users/work/.dota2-workshop-mcp/reflib/items/1844502841/files/scripts/vscripts/lib/optionsmodule.lua:60-212)
      Convars:RegisterCommand('gds_send_part', recieveOptionsPart, 'Client is sending us part of the options', 0)
      Convars:RegisterCommand('gds_send_options', recieveOptions, ...)
      -- client uploads in chunks; server reassembles + unescapes:
      optionsPart = optionsPart..part
      local options = optionsPart:gsub('&qt!', '"')
      storedData = JSON:decode(options)
      -- authenticate uploader:
      local cmdPlayer = Convars:GetCommandClient(); if cmdPlayer:GetPlayerID() ~= reportPlayer then return end
  * [particles / game-mechanics] Element-combination spell crafting: weighted RGB particle blend + stateless projectile dispatch: An Invoker-like 'orb' system that, instead of fixed reagent combos, treats each held element as a scalar POWER value (summed per element) and runs a decision tree over the ratios of fire/wind/ice power to pick one of ~30 distinct spells with stats scaled continuously by those power numbers. Two reusable tricks: (1) the cast/invoke particle's color is computed as a POWER-WEIGHTED BLEND of three RGB vectors -> `(ice_color*ice + fire_color*fire + wind_color*wind) / (ice+fire+wind)` set on a particle control point, giving a unique tint per combination for free; (2) projectiles carry no per-instance payload -- on impact `projectile_hit` branches on `caster.last_used_skill` (a string stamped at cast time) to decide damage/effects, avoiding the need to bind data to each ProjectileManager handle. (C:/Users/work/.dota2-workshop-mcp/reflib/items/1844502841/files/scripts/vscripts/ellement/combination.lua:50-203 + ellement/projectile_hit.lua)
      local ice_color=Vector(0,153,204); local wind_color=Vector(204,0,153); local fire_color=Vector(255,102,0)
      ParticleManager:SetParticleControl(invoke_particle_effect, 2,
        ((ice_color*invocation_power_ice)+(fire_color*invocation_power_fire)+(wind_color*invocation_power_wind))
        /(invocation_power_ice+invocation_power_wind+invocation_power_fire))
      -- decision tree on ratios:
      if fire > (ice+wind)*1.5 then ... elseif ice+fire > 2*wind then ...
      -- impact dispatch by stamped skill name:
      if keys.caster.last_used_skill == "arcana_laser" then ApplyDamage{...DAMAGE_TYPE_PURE...} end
  * [engine workarounds] Decoupled real-HP cap with separate display multiplier (EHP_MULT) including regen rescale: A more complete variant of the KB's 'EHP rescale to bypass HP cap'. Rather than just rescaling, bosses cap their ACTUAL engine MaxHealth at 10,000,000 and store the leftover scale in a per-unit `EHP_MULT` field; every place HP is shown multiplies by EHP_MULT (the custom boss health-bar net event sends `GetHealth()*EHP_MULT` and `GetMaxHealth()*EHP_MULT`). Crucially it also divides base health regen by EHP_MULT so regen *looks* correct at the inflated display scale, and it picks the boss to display by largest `GetMaxHealth()*EHP_MULT` and attaches a world-follow `health_bar_trail` particle to it. The clean separation of 'engine HP' vs 'display HP multiplier vs regen compensation' is the reusable idea, beyond the raw cap-dodge already documented. (C:/Users/work/.dota2-workshop-mcp/reflib/items/1844502841/files/scripts/vscripts/bossmanager.lua:76-94 + panoramabridge.lua:12-50)
      if spawnedUnit.MaxEHP > 10000000 then
        spawnedUnit:SetMaxHealth(10000000); spawnedUnit:SetHealth(10000000)
        local EHP_MULT = self:EHPFix(spawnedUnit.MaxEHP,10000000)   -- = MaxEHP/10000000
        spawnedUnit.EHP_MULT = EHP_MULT
        spawnedUnit:SetBaseHealthRegen(spawnedUnit:GetBaseHealthRegen()/EHP_MULT)
        spawnedUnit:AddNewModifier(spawnedUnit, spawnedUnit, "bossHealthRescale",{})
      else spawnedUnit.EHP_MULT = 1 end
      -- HUD: table_arg.current_life = set_comma_thousand(biggest_ennemy:GetHealth()*biggest_ennemy.EHP_MULT)

## Invasion of zombies FT (524035937)
  * [vscript / game-mode architecture] Self-declaring affix propagation: CanBeAddToMinions() convention for elite-pack inheritance: Every random monster modifier implements a custom method CanBeAddToMinions() returning true/false. When the spawner creates an elite 'pack leader' and rolls one random affix onto it, it then iterates the pack's summoned minions and grants the SAME affix to each one ONLY IF the modifier opts in via CanBeAddToMinions(). This is a clean data-driven 'elite pack' inheritance: the affix itself decides whether it makes sense to share across a whole pack (a stacking aura buff: yes; a unique boss-only mechanic: no). The decision lives on the modifier, not in the spawner switch-statement, so adding new affixes never touches spawn code. This is a reusable convention that the KB's generic 'custom modifiers' coverage does not describe. (C:/Users/work/.dota2-workshop-mcp/reflib/items/524035937/files/scripts/vscripts/invasion_armageddon.lua)
      modifier = unit:AddNewModifier(unit, nil, GetRandomModifierName(), {})
      for n = 1, MINIONS_COUNT do 
          unit = CreateUnitByName("npc_armageddon_zombie", point + RandomVector(300), true, nil, nil, team )
          if modifier:CanBeAddToMinions() then
              unit:AddNewModifier(unit, nil, modifier:GetName(), {})
              unit:CreatureLevelUp(math.floor(MONSTERS_LEVEL) - delta)
              unit.itemDropType = biomTable[ i ]
          end
      end
  * [vscript / difficulty & game-feel] Roguelite 'rare/elite monster affix' system with color-coded units and boss dedup-loop: A Diablo/PoE-style affix system ported to Dota waves: GetRandomModifierName() returns from a pool of ~18 gameplay affixes (reflector, devourer/lifesteal-on-hit, explosive-on-death, infectious DoT-on-hit, regen aura, giant, etc.). Each affix's OnCreated calls SetRenderColor(...) with a distinct RGB so players read a monster's affix at a glance from its body tint (red=reflect, dark-red=lifesteal, orange=explosive, green=infection, etc.). Regular packs get one rolled affix; bosses run a roll-and-dedup loop that grants exactly 3 DISTINCT affixes (HasModifier check + counter break at 3). The whole system is reusable as a generic 'elite mob' framework. KB has 'custom modifiers' but not this combined random-affix-pool + visual-tint-encoding + N-distinct-boss-affix pattern. (C:/Users/work/.dota2-workshop-mcp/reflib/items/524035937/files/scripts/vscripts/invasion_armageddon.lua)
      for j = 0, 10 do
          modifName = GetRandomModifierName()
          if not unit:HasModifier(modifName) then
              unit:AddNewModifier(unit, nil, modifName, {})
              modifCount = modifCount + 1
          end
          if modifCount >= 3 then
              break
          end
      end
      -- and per-affix: self:GetParent():SetRenderColor(255, 69, 0)  -- orange == explosive
  * [vscript / emergent difficulty mechanic] Swarm-synergy aura: monsters get stronger the more of them cluster (self-incrementing decaying stacks): modifier_unity_of_evil is a stacking aura where bonuses (damage/regen/resist/armor/model-scale) all scale with GetStackCount(). It applies a short-lived (0.3s) mark to nearby allies; the mark's OnDestroy looks around itself and IncrementStackCount() on each ally's unity modifier (capped at 5). Because the mark is constantly re-applied while units stay clustered and decays when they separate, stacks naturally rise in dense swarms and fall when isolated. The result is emergent difficulty: a tight blob of zombies becomes far deadlier than the same count spread out, with no central manager tracking density. The 'mark expiry feeds back a stack onto the source aura' loop is a non-obvious way to measure local crowd density purely through modifier lifecycle. Not in KB. (C:/Users/work/.dota2-workshop-mcp/reflib/items/524035937/files/scripts/vscripts/modifiers/monsters/modifier_unity_of_evil.lua)
      function modifier_unity_of_evil_mark:OnDestroy()
          local units = FindUnitsInRadius( ... self.auraRadius, DOTA_UNIT_TARGET_TEAM_FRIENDLY, ... )
          for i = 1, #units do
              local modifier = units[i]:FindModifierByName("modifier_unity_of_evil")
              if modifier and modifier:GetStackCount() < 5 then
                  modifier:IncrementStackCount()
              end
          end
      end
  * [vscript / data pipeline] Biome-tagged loot pipeline: spawn-camp biome stamped on the unit, read on death to pick the drop pool: Spawn camps are named by biome (spawn_moobs_misc_N / _attributes_N / _weapons_N) and the spawner stamps the originating biome onto each created unit (unit.itemDropType = biomTable[i]). On death, the kill handler passes that tag to GetRandomItemNameFrom(tag), which indexes one of four curated item arrays (ATTRIBUTES_ITEMS / WEAPONS_ITEMS / MISC_ITEMS / SECRET_ITEMS). Bosses carry itemDropType='secret' for a high-tier pool. This is a clean 'where it spawned determines what it drops' loot-table pipeline with the routing key carried on the entity instead of branching on unit name. Reusable for any zoned/biome loot design; not covered by KB's generic gold/economy notes. (C:/Users/work/.dota2-workshop-mcp/reflib/items/524035937/files/scripts/vscripts/constant_links.lua)
      function GetRandomItemNameFrom(itemType)
          if itemType == "attributes" then return ATTRIBUTES_ITEMS[RandomInt(1,#ATTRIBUTES_ITEMS)] end
          if itemType == "weapons" then return WEAPONS_ITEMS[RandomInt(1,#WEAPONS_ITEMS)] end
          if itemType == "misc" then return MISC_ITEMS[RandomInt(1,#MISC_ITEMS)] end
          if itemType == "secret" then return SECRET_ITEMS[RandomInt(1,#SECRET_ITEMS)] end
      end
      -- spawner: unit.itemDropType = biomTable[i] ; on death: CreateDrop(GetRandomItemNameFrom(killedEntity.itemDropType), pos)
  * [Panorama / native-HUD] Re-enable native item guides inside the custom shop by removing the 'GuidesDisabled' CSS class: Custom games normally lose the recommended-items / build-guides column in the native shop because the engine adds a 'GuidesDisabled' class to the shop panel. This one-liner injects a GameInfo CustomUIElement, traverses up six GetParent() levels to reach the dota HUD root, FindChildTraverse('shop'), and RemoveClass('GuidesDisabled') to restore the guides UI. The KB covers FindDotaHudElement/root traversal generally, but the specific lever here -- the exact 'GuidesDisabled' class on the native shop being what gates item guides in custom modes, and removing it to bring them back -- is a concrete non-obvious fix worth recording. (C:/Users/work/.dota2-workshop-mcp/reflib/items/524035937/files/panorama/scripts/custom_game/recomshopfix.js)
      var dotaHud = $.GetContextPanel().GetParent().GetParent().GetParent().GetParent().GetParent().GetParent()
      dotaHud.FindChildTraverse("shop").RemoveClass("GuidesDisabled")

## Kill Boss And Win (id 1436504119)
  * [data-pipeline / state-sync] GenTable: diff-based per-player nested-state replication (CustomNetTables alternative) with delete/clear sentinels + player-grouped Lua-client transport: A general-purpose server->client state framework keyed by dotted paths (e.g. 'ModifiedValues.123.damage.2') that is a genuine alternative to CustomNetTables, with mechanics our KB doesn't cover. The server keeps BOTH a full snapshot (tData) and a separate incremental diff tree (tUpdate) per player, debounced at a single 1/30s timer, then ships only the deltas. Deletions and subtree-replacements are encoded INSIDE the diff via sentinel objects: NIL = { _gen_table_remove = 1892374 } marks a key for removal, and a table gets `.__bClear = true` to tell the client to wipe-and-rebuild that subtree (JS fOverlay reconstructs both). Most novel part: a SECOND transport to client-side *Lua* (UpdateLuaClients) that, instead of one event per player, GROUPS all players sharing an identical value into one space-delimited `players` string and fires a single FireGameEvent('basis_gentable_set') — drastically cutting event count vs. per-player sends. Also auto-primes late joiners via a request/response handshake (sv_basis_gentable_request). (C:\Users\work\.dota2-workshop-mcp\reflib\items\1436504119\files\scripts\vscripts\lib\gentable.lua (+ panorama\basis_lib\gentable.js))
      GenTable.NIL = { _gen_table_remove = 1892374 }
      ...
      if bUpdater and xData == nil then
          xTarget[ sKey ] = self.NIL
      else
          xTarget[ sKey ] = table.deepcopy( xData, ... )
          if bUpdater and type( xData ) == 'table' then
              xTarget[ sKey ].__bClear = true
          end
      end
      -- group identical values across players into one event:
      FireGameEvent( 'basis_gentable_set', { players = sPlayers, key = sPath, type = sType, value = xValue })
  * [anti-cheat / networking] Client-nonce 'protected events': authenticating the server->client custom-event channel against spoofing: Distinct from the KB's GetDedicatedServerKeyV3 / HMAC HTTP-backend signing: this secures the in-game server->client GameEvent channel. On load each client generates a random 20-30 char key and sends it once to the server (sv_basis_protected_key_init). Thereafter the server's CustomGameEventManager:SendProtected wraps every payload as {protected_key=key, data=...} using that player's stored key, and the client's SubscribeProtectedEvent only fires the callback if tEvent.protected_key matches its own secret — so a malicious client/tool cannot forge UI events to another player's Panorama. Server side also buffers 'important' events fired before the key handshake completes (tPreinitEvents) and flushes them once the key arrives, and includes a robust EntIndex->PlayerID resolver loop for events that arrive before PlayerResource is ready. (C:\Users\work\.dota2-workshop-mcp\reflib\items\1436504119\files\panorama\basis_lib\protected_events.js (+ scripts\vscripts\lib\protected_events.lua))
      // client generates secret nonce, validates every inbound event:
      if( sKey === tEvent.protected_key ){ fCallback( tEvent.data ); }
      else { /* wrong key -> drop */ }
      -- server echoes the per-player key on every send:
      self:Send_ServerToPlayer( hPlayer, sEvent, { protected_key = sKey, data = tData })
  * [vscript architecture] Global gameplay-event bus + zero-boilerplate modifier 'self events' (OnParentTakeDamage etc.) via one shared modifier-thinker: A single modifier-thinker (m_gameplay_event_tracker) is attached to the GameMode entity and DeclareFunctions()'s every MODIFIER_EVENT_* (OnTakeDamage/OnAttack/OnDeath/OnUnitMoved...), re-broadcasting each onto a central Events bus. This means individual modifiers no longer need their own DeclareFunctions + event boilerplate. modifier_self_events.lua then layers on a 'self events' API: any modifier can simply define methods like OnParentTakeDamage / OnParentDealDamage / OnParentKill, call RegisterSelfEvents(), and a per-unit reverse index (_tSelfModifiers[event][unit]) routes the global bus event to exactly the modifiers on the relevant unit. Each event has a configurable target field ('attacker' vs 'unit' vs 'target') so the same engine event drives both 'I dealt damage' and 'I took damage' callbacks. Events can be globally toggled (SetEnabled) which rebuilds the single thinker. (C:\Users\work\.dota2-workshop-mcp\reflib\items\1436504119\files\scripts\vscripts\lib\gameplay_event_tracker\init.lua (+ m_gameplay_event_tracker.lua, lib\modifier_self_events.lua))
      OnParentDealDamage = { sEvent = 'OnTakeDamage', sTarget = 'attacker' },
      OnParentTakeDamage = { sEvent = 'OnTakeDamage', sTarget = 'unit' },
      ...
      Events:Register( tData.sEvent, function( tEvent )
        local hTarget = tEvent[ tData.sTarget ]
        local qModifiers = tEventUnits[ hTarget ]
        ... hMod[ sCallbackName ]( hMod, tEvent ) ...
  * [matchmaking / team-balance] Party-aware combinatorial team balancer + MMR-delta comeback buffs: A real team-balancing algorithm (KB has nothing on this). BalanceTeams() enumerates EVERY way to split N players into two halves using fNextTeamSet() as a lexicographic combination iterator over team-slot indices, scoring each split with a two-key objective: FIRST minimize the number of pre-made parties that get split across teams (tParties via PlayerResource:GetPartyID), THEN minimize the skill-sum delta. The winning split is applied with SetCustomTeamAssignment + LockCustomGameSetupTeamAssignment during custom game setup. Separately, a backend-MMR-driven rubber-band: GamePregame computes the skill ratio between teams (from game_count/win_rate fetched over HTTP) into a 0..1 nBalanceMultiplier; the weaker team then gets time-scaling free upgrade 'spheres' on an interval AND a gold-gain multiplier (MultiplyGold) that both ramp with DOTA time — a comeback mechanic keyed to real MMR, not generic score. (C:\Users\work\.dota2-workshop-mcp\reflib\items\1436504119\files\scripts\vscripts\kbw\rank.lua)
      local function fNextTeamSet()
        for nSlot = nTeam1Size, 2, -1 do
          if qTeam1[nSlot] < nPlayers - nTeam1Size + nSlot then
            qTeam1[nSlot] = qTeam1[nSlot] + 1
            for nNextSlot = nSlot + 1, nTeam1Size do qTeam1[nNextSlot] = qTeam1[nNextSlot-1] + 1 end
            return false
          end
        end
        return true
      end
      -- objective: fewest split parties, then smallest skill delta
      if nPartySplit < nMinPartySplit or (nPartySplit == nMinPartySplit and nDelta < nMinDelta) then ... qBestTeam1 = table.copy(qTeam1) end
  * [combat math / modifier system] Asymptotic stacking-operation value calculus + declarative summon-stat-inheritance DSL: Two non-obvious reusable systems. (1) A modifier-value calculus that applies stacked sources in a FIXED operation order (SET -> ADD -> MULT -> PCT -> ASYMPTOTE) and includes OPERATION_ASYMPTOTE = function(base,value,next) return value + next - value*next end — the multiplicative diminishing-returns formula so many sources of e.g. damage-reduction/evasion combine like Dota's real reductions and never exceed 100%. value_modifier.lua recomputes the resulting value for every ability level and ships it to clients via GenTable so tooltips match. special_fixes.lua wires real Dota abilities (nyx burrow, lich frost shield, ursa enrage) into this via AddSpecialModifier with OPERATION_ASYMPTOTE. (2) tUnitStats: a declarative DSL that fixes the 'summons don't scale' problem — each summon pattern maps stats to a spec that a recursive fParse resolves, where a value can be a string (ability special value), a table (summed), a function (custom calc like own('pct')=base*ownerSpecial/100, ability(name,val), pct(n)), or a number; on KBW_Spawn the summon is briefly made invulnerable then has HP/damage/armor/attack-time/speed/scale recomputed from the OWNER's ability values, with optional per-player count limits that auto-kill the oldest. (C:\Users\work\.dota2-workshop-mcp\reflib\items\1436504119\files\scripts\vscripts\lib\special_modifier.lua (+ kbw\special_fixes.lua, kbw\value_modifier.lua))
      [OPERATION_ASYMPTOTE] = function( nBase, nValue, nNext )
          return nValue + nNext - nValue * nNext
      end
      ...
      ['npc_dota_wraith_king_skeleton_warrior'] = {
        sAbility = 'skeleton_king_vampiric_aura',
        nHealth = own('own_health'),
        nDamage = {own('own_damage'), ability('special_bonus_unique_wraith_king_skeleton_damage','value')},
      }

## Ability Arena (id 2865676075)
  * [AI/combat (auto-battler ability targeting)] Declarative composable target-selection rule DSL for ability auto-casting: A full auto-battler ability AI built as a filter-chain DSL. Each ability registers ordered `ruleSets`; a rule is a predicate `(target, ctx, remaining) -> bool` that progressively narrows the candidate unit set. Rules compose with `and`/`or`/`not` combinators and include rich primitives: isClosest/isFarthest, isLowest/HighestHealth(Pct), isHighestDamage, hasEnemyInRange(WithConditions), checkModifierStackCount, plus ARENA-RELATIVE GEOMETRY rules (closestOnYAxis / isCloseToBackLine / isCloseToCenterLine) computed via signed distance to a line: `normal:Dot(point - center)`. Abilities declare AI inline: `ai = (select) => select(rules:enemy(), rules:isClosest())`. Crucially, `inferAbilityAI` AUTO-DERIVES sane targeting from the ability's KV (target-team + behavior flags) when no manual rules exist, and `biggestUnitClusters` picks ground-target cast points by clustering predicted unit positions (lead targeting via `origin + forward*idealSpeed*castPoint`). This is far beyond simple FindUnitsInRadius/blackboard AI - it's a reusable, data-driven targeting engine that works across ~250 vanilla abilities. File: scripts/vscripts/ai.lua (rules engine) + per-ability registration in scripts/vscripts/abilities/*.lua. (C:/Users/work/.dota2-workshop-mcp/reflib/items/2865676075/files/scripts/vscripts/ai.lua)
      function rules.closestOnYAxis(self)
          return function(____, target, ctx, remaining)
              local closest = findElementWithSmallestValue(nil, remaining, function(____, target) return signedDistanceTowardsLine(nil, ctx.arena.center, ctx.arena.facing, target:GetAbsOrigin()) end)
              return closest == target
          end
      end
      -- and the auto-inference fallback:
      local ai = abilityAI[ability:GetAbilityName()] or inferAbilityAI(nil, ability)
      -- ability-side declaration:
      ai = function(____, select) return select(nil, rules:enemy(), rules:isClosest()) end
  * [architecture (state replication)] Demand-driven, multi-part state subscription over CustomGameEvents (not net tables) with spectator indirection: A complete reactive client/server state-sync system that does NOT use CustomNetTables. Server side: `defineQueryableState(name, fn, hashKey?)` registers named 'parts'; a single update_think loop polls every defined part each tick, hashes each via its optional `hashKey` function, and pushes ONLY changed parts to each player via `CustomGameEventManager:Send_ServerToPlayer(player, 'stateUpdate', {json})`. Client side: a UI panel calls `subscribeToQuery([partA, partB], handler)`; the client requests only parts not already pending (`requestStateParts`), caches `localState[part]` from incoming `stateUpdate`, and fires the handler ONLY when ALL parts in the query are present (a reactive multi-key JOIN via `break partMissing`). Two standout twists: (1) SPECTATOR/VIEWER INDIRECTION - the server serializes the *viewed* player's state to the *actual* client (`actualPlayer` vs `requestPlayer`/`getInputPlayerId`), so spectating/camera-switching reuses the entire UI unchanged; (2) the same `queryStatePart`+`dispatchRequest` API is reused by BOTS (bots are headless clients). This is a materially different architecture from net-table prime-and-subscribe/column-zip. Files: game.ts state defs (game.lua), client subscribeToQuery (bundle.js), poll/diff loop (game_init.lua). (C:/Users/work/.dota2-workshop-mcp/reflib/items/2865676075/files/panorama/scripts/custom_game/bundle.js)
      function subscribeToQuery(query, handler) {
        stateHandlers.push({ query, handler });
        const notPending = query.filter(part => !pendingRequestedParts.has(part));
        if (notPending.length > 0) { GameEvents.SendCustomGameEventToServer("requestStateParts", { parts: utils_2.encodeToJson([...notPending]) }); ... }
      }
      GameEvents.Subscribe("stateUpdate", event => {
        const update = utils_2.decodeFromJson(event.json);
        localState[update.part] = update.data;
        for (const handler of stateHandlers) {
          partMissing: if (handler.query.includes(update.part)) {
            const parts = [];
            for (const key of handler.query) { const local = localState[key]; if (local != undefined) parts.push(local); else break partMissing; }
            handler.handler(parts);
          }
        }
      });
  * [engine workaround / custom modifiers] Single global modifier as an engine-event bus (auto-registering listeners by reflection, with synthetic events): Instead of every gameplay modifier declaring its own `DeclareFunctions`/`OnTakeDamage`/`OnAttackLanded`/`OnStateChanged` (which the engine evaluates globally and is costly across hundreds of stacked modifiers), this game creates ONE global thinker modifier `ModifierEventFanOut` that declares ALL modifier event functions once. In `OnModifierAdded` it reflects over a newly added `BaseModifier` against a known map of event->methodName and auto-subscribes that modifier to exactly the events it implements; engine events are then re-dispatched (`TriggerEventModifiers`) to the registered listener list (auto-pruning `IsNull()` modifiers each fire). It also injects a SYNTHETIC event the engine doesn't natively expose (`OnHealDone`, keyed by -1) into the same bus. This is a non-obvious centralized event-bus pattern that decouples per-modifier event handling from engine registration and enables custom events. File: scripts/vscripts/modifiers/modifier_event_fan_out.lua. (C:/Users/work/.dota2-workshop-mcp/reflib/items/2865676075/files/scripts/vscripts/modifiers/modifier_event_fan_out.lua)
      function ModifierEventFanOut.prototype.OnModifierAdded(self, event)
          local added = event.added_buff
          if added ~= self and __TS__InstanceOf(added, BaseModifier) then
              for ____, event in ipairs(events) do
                  if added[eventFunctions[event]] then
                      local ____self_events_event_0 = self.events[event]
                      ____self_events_event_0[#____self_events_event_0 + 1] = added
                  end
              end
          end
          self:TriggerEventModifiers(MODIFIER_EVENT_ON_MODIFIER_ADDED, event)
      end
      -- custom event the engine does not provide: local custom = {onHealDone = -1}
  * [data pipeline / engine API] Server-side reconstruction of any hero's full effective stat block at an arbitrary level (no spawn): `getHeroDefinitionAtLevel` computes a hero's complete derived stats (HP, mana, damage, armor, attack speed, regens) at ANY level in pure Lua WITHOUT ever creating the unit - used to render accurate hero-pick previews in the draft UI. It reads base+growth per attribute from npc_heroes.txt, grows them linearly (`base + growth*(level-1)`), and multiplies by Valve's actual live per-attribute derived-stat constants pulled at runtime via the lesser-known engine API `GameRules:GetGameModeEntity():GetCustomAttributeDerivedStatValue(DOTA_ATTRIBUTE_STRENGTH_HP / _HP_REGEN / _DAMAGE / AGILITY_ARMOR / _ATTACK_SPEED / INTELLIGENCE_MANA / _MANA_REGEN)`. It even resolves Universal ('all') heroes' main-stat damage as 0.6*(str+agi+int). This faithfully replicates Dota's attribute->stat formula off-unit, which is non-obvious. File: scripts/vscripts/heroes.lua. (C:/Users/work/.dota2-workshop-mcp/reflib/items/2865676075/files/scripts/vscripts/heroes.lua)
      local gameMode = GameRules:GetGameModeEntity()
      local function get(self, stat) return gameMode:GetCustomAttributeDerivedStatValue(stat) end
      local derived = { strHp = get(nil, DOTA_ATTRIBUTE_STRENGTH_HP), agiArmor = get(nil, DOTA_ATTRIBUTE_AGILITY_ARMOR), agiAttackSpeed = get(nil, DOTA_ATTRIBUTE_AGILITY_ATTACK_SPEED), intMana = get(nil, DOTA_ATTRIBUTE_INTELLIGENCE_MANA), ... }
      local function growAttr(self, attr) return {base = attr.base + attr.growth * (level - 1), growth = attr.growth} end
      -- health = base + derived.strHp * str.base ; attackSpeed = base + derived.agiAttackSpeed * agi.base
  * [data pipeline (KV introspection)] Runtime ability-KV introspection registry: flatten all AbilitySpecial/Values into a queryable metadata table + behavior/enum string parsing: `defineAbility` builds a queryable registry from raw Dota KV at load time: it LoadKeyValues npc_heroes + per-hero ability files + custom + an override layer, then for each ability flattens EVERY AbilityValues and AbilitySpecial entry into a single `values` map (stripping scepter/shard-gated entries, parsing space-separated level arrays, trimming trailing zeros to clean floats), and PARSES Valve's string enums back into the numeric ints the scripting API needs - AbilityBehavior strings -> a normalized behavior class, AbilityUnitDamageType -> 0/1/2, SpellImmunityType -> pierce int, SpellDispellableType -> dispel int. It also validates that every special referenced by declared 'upgrade' operations actually exists in the KV (soft-erroring in tools mode), and recursively auto-registers secondary/related abilities referenced by upgrades. This turns the entire shipped ability KV into typed, introspectable, upgrade-able gameplay data - a reusable data pipeline for any ability-draft/random-ability mode. File: scripts/vscripts/abilities/framework/ability_definition.lua. (C:/Users/work/.dota2-workshop-mcp/reflib/items/2865676075/files/scripts/vscripts/abilities/framework/ability_definition.lua)
      local heroes = LoadKeyValues("scripts/npc/npc_heroes.txt")
      for ____, name in ipairs(__TS__ObjectKeys(heroes)) do
        local heroAbilities = LoadKeyValues(("scripts/npc/heroes/" .. name) .. ".txt")
        if heroAbilities then for ... do vanillaAbilities[abilityName] = abilityDefinition end end
      end
      -- later: flatten specials/values and parse string enums
      local function parseAbilityBehavior(self, ____type) ... if __TS__ArrayIncludes(behaviors, "DOTA_ABILITY_BEHAVIOR_PASSIVE") then return 1 end ... end
      for ... in ipairs(__TS__ObjectValues(kv.AbilitySpecial or ({}))) do if entry.RequiresScepter or entry.RequiresShard then goto __continue84 end ... values[key] = parseValuesFromStringOrNumber(...) end

## Castle Fight (1757281740)
  * [Game-mode mechanic / auto-spawn AoS economy] Castle Fight income economy: progressive income-tax curve + diminishing-returns treasure-box multiplier: A full passive-income economy distinct from anything in the KB. Buildings add a fraction of their gold cost to a per-player 'income' value (multiplier per building TYPE: UnitTrainer 0.020, SiegeTrainer 0.018, Support 0.012, Killing 0.009, Tower 0.008 in income.lua:13-35). Income is then run through TWO stacking non-linear curves before being paid on a 10s timer: (1) a treasure-box multiplier with geometric diminishing returns (first box +25%, each subsequent reduced by 15%: 25/46/64/79/92%), and (2) a piecewise progressive INCOME TAX computed in 25-gold brackets where the marginal tax rate climbs +10% per bracket up to a permanent 80% cap above 200 gold. The whole thing is implemented as pure integer-accumulating loops, and the effective tax rate is exposed to the HUD via GetTaxRateForPlayer (= postTax/preTax). This is a reusable 'economic soft-cap' pattern (reward early investment, throttle runaway leaders) that has nothing to do with Dota's gold system. (C:/Users/work/.dota2-workshop-mcp/reflib/items/1757281740/files/scripts/vscripts/mechanics/income.lua)
      function GameMode:GetPostTaxIncome(income)
        local sum = 0
        local multiplier = 0
        while income > 0 do
          income = income - 25
          local increase = 25
          if income < 0 then increase = income + 25 end
          sum = sum + increase - (increase * multiplier)
          multiplier = math.min(0.8, multiplier + .1)
        end
        return sum
      end
      -- treasure box: first box +25%, each subsequent -15%
      for i=1,numBoxes do sum = sum + reducedRate; reducedRate = reducedRate - reducedRate * reduction end
  * [Combat / engine workaround] Runtime Warcraft-3 attack-type vs armor-type damage matrix via damage filter (+ anti-air secondary-attack hot-swap): Reimplements WC3's categorical damage system on top of Dota's single-axis damage model. Every unit carries a string AttackType and ArmorType (from KV / overridable at runtime, units.lua:363-404). A 2D lookup table loaded from damage_table.kv (GameRules.Damage) gives a multiplier for each AttackType x ArmorType pair; GetAttackFactorAgainstTarget reads it. The actual application is done inside SetDamageFilter (FilterDamage), which intercepts EVERY physical hit, multiplies the post-mitigation damage by the matrix factor, and rewrites filterTable['damage'] in place. The same filter also routes splash attacks (calls SplashAttackUnit and returns false to cancel the original hit) and filters cleave so it can't hit air/buildings. Complementing this, attacks.lua implements a per-target attack hot-swap: when a unit aggros, CheckSecondaryAttackAgainst swaps the unit's AttackCapability/AttackType/damage/BAT/range/projectile to a 'SecondaryAttack' KV block based on whether the target is air/ground/building (e.g. a unit that does big anti-air damage but weak ground damage). This 'categorical damage + per-target stat swap' is a reusable recipe for porting RTS combat rules into Dota. (C:/Users/work/.dota2-workshop-mcp/reflib/items/1757281740/files/scripts/vscripts/order_filters.lua)
      if damagetype == DAMAGE_TYPE_PHYSICAL then
        if attacker:HasSplashAttack() and not inflictor then
          SplashAttackUnit(attacker, victim:GetAbsOrigin()); return false
        end
        local multiplier = attacker:GetAttackFactorAgainstTarget(victim)
        damage = damage * multiplier
        filterTable["damage"] = damage
      end
      -- GetAttackFactorAgainstTarget: return damageTable[attack_type][armor_type] or 1
  * [AI / performance / scheduling] Population-adaptive AI think-rate throttling (load shedding scaled to global unit count): Castle Fight can have hundreds of auto-spawned units each running their own Lua think loop. To keep the server frame budget under control, every unit AI returns its NEXT think delay from GetAggroThinkTime()/GetMoveToGoalThinkTime(), which read a single global counter GameRules.numUnits (incremented/decremented on spawn/death) and return an interval that grows with the live population: 0.3s under 100 units, ramping through 0.4/0.5/0.55/0.6/0.65/0.7/0.75s, 1s at 300, and 2s above. The unit count is maintained centrally (CustomRemoveSelf decrements it and broadcasts num_units_changed) so the throttle is global, not per-unit. This is an explicit, dead-simple 'AI LOD / load-shedding' technique for mass-unit modes (auto-battlers, survival/Enfos, tower defense) that trades reaction latency for tick budget exactly when the field is crowded - not present anywhere in the KB. (C:/Users/work/.dota2-workshop-mcp/reflib/items/1757281740/files/scripts/vscripts/ai/ai_multipliers.lua)
      function GetAggroThinkTime()
        if GameRules.numUnits < 100 then return 0.3
        elseif GameRules.numUnits < 150 then return 0.5
        elseif GameRules.numUnits < 225 then return 0.65
        elseif GameRules.numUnits < 300 then return 1
        else return 2 end
      end
      -- each AI: AttackTarget(self); return GetAggroThinkTime()  /  MoveTowardsGoal(self); return GetMoveToGoalThinkTime()
  * [AI / matchmaking-bots for auto-spawn games] Auto-battler bot 'build-order brain': income-gated building selection + serpentine grid-fill placement: A complete economy-aware bot for an auto-spawn RTS, structured as a data-driven planner rather than micro. ai_values.lua tags each build ability with an interestToConsider gate (the bot will only consider a building once its passive INCOME reaches that threshold, e.g. weapon_lab needs income>=25, heroic_shrine>=60, artillery>=100) plus a baseValue weight; building_values.lua holds the upgrade graph + damage/armor/can-hit-flying metadata. OnThink: (1) prefer upgrading any existing building whose upgrade it can afford, else (2) collect every build ability whose income gate is met and it can afford the special resources (lumber/cheese), pick one, (3) find a slot via GetPlaceToBuild - a deterministic serpentine scan that starts at the base corner nearest the bot and walks column-by-column toward the lane center (resetting y and stepping x each time it crosses y=0), validating each cell with GridNav:CanFindPath + BuildingHelper:ValidPosition, and (4) when idle/blocked, auto-repair the lowest-HP building. This 'threshold-gated tech tree + grid-fill placement + repair fallback' is a reusable template for AI opponents in Castle Fight / Legion-TD / Enfos-style modes; the KB has combat bot AI but no economy/build-order planner. (C:/Users/work/.dota2-workshop-mcp/reflib/items/1757281740/files/scripts/vscripts/ai/bot_ai/bot_ai.lua)
      if currentInterest >= interestToConsider and hasEnoughSpecialResources then
        table.insert(buildings, ability)
      end
      ...
      searchLocation = searchLocation + Vector(0, searchDirectionY * searchInterval, 0)
      if hero.sideToBuild == "SOUTH" and searchLocation.y > 0 then
        searchLocation.y = searchStart.y
        searchLocation = searchLocation + Vector(searchDirectionX * searchInterval, 0, 0)
      end
  * [Lobby / pre-game configuration] Per-setting plurality lobby-vote framework with default-biased tie-breaking: A generic, reusable democratic settings system used to configure draft mode, number of rounds, treasure-box on/off, anti-caging on/off, and bots on/off before the match. Each setting is a per-playerID vote table; GetVoteResult tallies it and GetPluralityVoteOutcome resolves the winner as the plurality option, but with a deterministic tie-break rule: among tied options it returns the DEFAULT value if it is one of the winners, otherwise a random tied option - so a contested vote falls back to the configured default rather than flip-flopping. Votes write live to CustomNetTables (settings/<key>) so the Panorama setup UI reflects the running tally for everyone. Separately it shows two related but distinct quorum schemes: the draw-vote requires net agreement across BOTH teams (westVotes>=0 and eastVotes>=0, with rejection counts that can cancel the vote), while the GG/forfeit vote requires UNANIMITY within a single team and only unlocks after 400s of round time, each guarded by a per-team timeout timer. The KB has voting nowhere; this is a clean drop-in for any lobby/option negotiation. (C:/Users/work/.dota2-workshop-mcp/reflib/items/1757281740/files/scripts/vscripts/mechanics/settings.lua)
      function GetPluralityVoteOutcome(votes, default)
        local winners = {}; local maxVotes = 0
        for vote,numVotes in pairs(votes) do
          if numVotes > maxVotes then winners = {vote}; maxVotes = numVotes
          elseif numVotes == maxVotes then table.insert(winners, vote) end
        end
        for _,winner in pairs(winners) do if winner == default then return winner end end
        return GetRandomTableElement(winners)
      end

## Bless ARAM (id 2841152696)
  * [engine-workaround / anti-rip obfuscation] Runtime Lua obfuscation via GameRules.XDecrypt (selective per-module encryption): Roughly half of the gameplay vscripts (218 of 406) ship as a single encrypted blob: each protected module's file is literally `return (GameRules.XDecrypt("<hex>", ...))` where XDecrypt is a custom NATIVE engine function (not defined anywhere in Lua) that decrypts+loads the real chunk at require() time. The split is deliberate and clever: the bootstrap (addon_game_mode.lua), all the leaf gameplay implementations (individual bless modifiers/abilities), and shared client glue stay PLAINTEXT, while the high-value core infrastructure modules are encrypted — attr_manager, global_attr_manager, damage_recorder, achievement_recorder, the _bless_base classes, queue_executor, global_thinker, player_connection, extendbasenpc/extendmodifier/extendplayer, etc. This means a ripper who copies the addon gets a non-functional shell. The native XDecrypt suggests they ship a small custom engine extension (or abuse an existing engine entry point) to register the decryptor. This is an anti-rip / IP-protection technique entirely absent from the KB. Reusable takeaway: encrypt only the irreplaceable core (economy/attr/save/anti-cheat) and leave content plaintext, so the protection surface is tiny and load cost is bounded. (C:/Users/work/.dota2-workshop-mcp/reflib/items/2841152696/files/scripts/vscripts/global/global_modules/queue_executor.lua)
      return (GameRules.XDecrypt("40D1F5B3F1A15C1E170B1FD709E42C4487E196593950CCE763C3504944862520...", ...))
  * [panorama UI rendering] QR code rendered in Panorama by packing dark modules into batched multi-layer background-images: A full QR-code generator runs inside Panorama (panorama_qrcode.js + the qrcode.js port of Kazuhiko Arase's library) and is used in the player-center and end-game 'settle' panels (likely to send players to the game's store/community page). The novel part is the RENDERING strategy: instead of creating one Panel per QR module (a 25-45 module grid = 600-2000 panels, which blows Panorama's panel budget), it walks each row and packs up to N consecutive dark modules into a SINGLE Panel using comma-separated stacked `background-image` and `background-position` lists (Panorama supports layered backgrounds). The batch size is computed as `Math.min(Math.floor(1024 / (pixImg.length + 1)), size, 70)` to respect Panorama's per-CSS-property string-length limit, dramatically cutting panel count. This 'pack many cells into one panel via N-layer backgrounds' trick is a reusable technique for any dense pixel/grid rendering in Panorama (heatmaps, minimaps, sprite atlases), and QR-in-Panorama is itself not in the KB. (C:/Users/work/.dota2-workshop-mcp/reflib/items/2841152696/files/panorama/lib/panorama_qrcode.js)
      const pixGroupBgCount = Math.min(Math.floor(1024 / (pixImg.length + 1)), size, 70);
      ...
      					pixGroup.style.backgroundImage = bgImgArr.join(",");
      					pixGroup.style.backgroundPosition = bgPosArr.join(",");
  * [architecture / client-server data sync] Per-unit custom-stat sync bus over a modifier's CustomTransmitterData (debounced + sequence-numbered + dirty-batched): Instead of CustomNetTables, this game syncs a hero's ~40 custom stats (the Attr2CalcType set: gjb/gjl/jnzq/hj/mk/xx/... = crit/lifesteal/spell-amp/etc.) to clients through ONE 'god modifier' (sl_modifier_custom_attr) that calls `SetHasCustomTransmitterData(true)` and overrides `AddCustomTransmitterData`/`HandleCustomTransmitterData` — the engine's per-modifier replication channel that auto-delivers a Lua table to exactly the clients that can see that unit. The system is sophisticated: each attribute carries a config flag table {need_calculate, send_to_client[, custom_sync_func]}; `SetAttrValue` marks only the changed attrs dirty into `_cached_need_send_attrs`; `_PushRefresh` coalesces all dirty writes within one frame behind a Timer guard (`_min_interval = StaticFrameTime`, one send per frame max); `AddCustomTransmitterData` lazily fires `CalculateStatBonus(true)` only if a `need_calculate` attr changed, runs queued `custom_sync_func`s, and stamps the payload with an incrementing `transmitter_counts` SEQUENCE NUMBER so the client can detect/order updates. `_GetAttrValue` transparently reads `_client_attr_record` on the client and `_attr_record` on the server, so the same modifier-property getters (GetModifierHealthBonus etc.) work on both sides. The KB covers CustomNetTables sync but NOT using a modifier's custom-transmitter-data as a visibility-scoped, frame-debounced, sequence-numbered attribute bus — a strictly better channel for per-unit data that should follow PVS visibility. (C:/Users/work/.dota2-workshop-mcp/reflib/items/2841152696/files/scripts/vscripts/modifiers/game_modifiers/sl_modifier_custom_attr.lua)
      self:SetHasCustomTransmitterData(true)
      ...
      function sl_modifier_custom_attr.prototype.AddCustomTransmitterData(self)
          if self._cached_need_calculate then ... parent:CalculateStatBonus(true) end
          ...
          local data = {transmitter_counts = self._transmitter_counts}
          for key in pairs(self._cached_need_send_attrs) do data[key] = self._attr_record[key].value end
          self._cached_need_send_attrs = {}
          return data
      end
  * [data pipeline / build tooling] Single 'source of truth' Excel -> KV (Lua) + JSON (client) data pipeline (excelToKv.ts): All balance/config data is authored in spreadsheets and machine-compiled to TWO outputs by a build step (`// this file is auto-generated by excelToKv.ts // <name>.xlsx Sheet1`): (a) Valve KV `.txt` files under scripts/npc/server/ that the Lua server reads (randomevents.txt, customrune.txt, store.txt, settingachievement.txt, goods.txt, trigger_ability_definition.txt), AND (b) the SAME data as JSON modules compiled directly into the Panorama webpack bundle (client_local_setting_pool.js exposes `LocalSettingPool` importing @json/server/randomEvents.json, customRune.json, store.json, settingAchievement.json, goods.json, abilitySpellAmplifyFactor.json). The client therefore renders shop/achievement/rune/event tooltips and prices straight from a baked-in copy WITHOUT round-tripping static config through net tables, while the server reads the KV copy — same xlsx, never out of sync. This is a concrete, reusable data-pipeline pattern (designers edit Excel; a TS codegen emits both engine KV and a client JSON bundle) not present in the KB. Note also the store data carries real-money fields (payCash, firstReward, quotaType), showing an IAP/monetization config model. (C:/Users/work/.dota2-workshop-mcp/reflib/items/2841152696/files/panorama/layout/custom_game/client_local_setting_pool.js)
      /*** ./json/server/randomEvents.json ***/
      module.exports = JSON.parse('{"1001":{"weight":100,"special_values":{"pct":20}},...}');
      // vs scripts/npc/server/randomevents.txt: "// this file is auto-generated by excelToKv.ts"
  * [architecture / projectile dispatch] One global 'projectile dispatcher' ability routing all custom projectile callbacks by tag in extraData: Rather than requiring a real ability instance per projectile owner, the game fires custom projectiles whose `ability` is a single shared dummy ability (ability_global_thinker) and packs all routing info into the projectile's `extraData`. Its `OnProjectileHit_ExtraData` / `OnProjectileThink_ExtraData` switch on an integer `extraData.type` (type 1 = a generic engine-reflect path that reads source_ability_index/source_unit_index/is_custom_reflect and EntIndexToHScript's them back; type 2 = roguelike 'bless' logic resolved by `extraData.bless_unique_name` -> SLModules.Bless:GetBlessByUniqueName(...) -> bless:OnProjectileHit/OnProjectileThink). This turns one ability into a central dispatch table for every projectile in the game, so item/bless/passive procs that need projectiles don't each need their own ability entity, and handlers are plain data objects keyed by a unique name. The KB has 'custom projectile particle'/ProjectileManager but not this 'single shared dispatcher ability + integer type tag + handler-name lookup in extraData' projectile-routing architecture, which is highly reusable for proc-heavy / roguelike games. (C:/Users/work/.dota2-workshop-mcp/reflib/items/2841152696/files/scripts/vscripts/abilities/ability_global_thinker.lua)
      function ability_global_thinker.prototype.OnProjectileHit_ExtraData(self, target, location, extraData)
          local ____type = extraData.type
          if ____type == 1 then ... source_ability = EntIndexToHScript(source_ability_index) ...
          elseif ____type == 2 then
              local bless = SLModules.Bless:GetBlessByUniqueName(extraData.bless_unique_name)
              if bless and bless.OnProjectileHit then return bless:OnProjectileHit(source_unit, target, location, extraData) end
          end
      end

## Enfos Team Survival (301622730)
  * [engine-workaround / combat] Warcraft 3 damage-type x armor-type matrix retrofitted onto Dota via DamageFilter + heal-back / pure-damage correction: Implements the full WC3 6x6 attack-type-vs-armor-type multiplier table on top of Dota's fixed damage pipeline. Attack type and armor type are stored as engine modifiers (modifier_attack_pierce, modifier_armor_heavy, etc) applied via item-based data-driven modifiers. After the engine has already dealt its own physical hit, a CalculateArmor hook corrects the result to match the desired multiplier WITHOUT rewriting damage in-flight: if the WC3 table wants MORE damage than Dota dealt, it deals the extra as a second DAMAGE_TYPE_PURE packet (dealOrHeal==1); if it wants LESS, it Heal()s back the difference on a ~0.001s timer (dealOrHeal==2). The standout trick is the magic-immunity bypass: to make a magic-immune unit still take custom 'magical' damage, it captures caster:GetHealth() pre-hit, then on a 0.002s timer restores that exact HP and re-applies the damage as a fresh DealDamage(DAMAGE_TYPE_MAGICAL) call (with the WC3 magic-armor multiplier ((0.06*armor)/(1+0.06*armor))+1 baked in) - routing custom magic damage around the engine's hard magic-immune block. This is a complete, reusable recipe for arbitrary damage-multiplier tables and for piercing magic immunity that I don't see in the KB (KB has EHP rescale and floating numbers, not a WC3 armor matrix or the snapshot-HP/re-deal magic-immune bypass). (C:/Users/work/.dota2-workshop-mcp/reflib/items/301622730/files/scripts/vscripts/items/armortypes.lua)
      if isMagicImmune and attackType == "modifier_attack_magical" then
      	local health = caster:GetHealth()
      	Timers:CreateTimer(DoUniqueString("magicImmuneHeal"), { endTime = 0.002,
      		callback = function() caster:SetHealth(health) end })
      ...
      if dealOrHeal == 1 then DealDamage(attacker, caster, damage, DAMAGE_TYPE_PURE, 0)
      elseif dealOrHeal == 2 then Timers:CreateTimer(..., function() caster:Heal(damage, caster) end) end
  * [engine-workaround / combat] Custom armor formula: zero out native mitigation via reentrancy-guarded negation, then reimplement % reduction: A permanent hidden modifier that fully replaces Dota's built-in armor->mitigation curve with a custom (WC3-style) one. GetModifierPhysicalArmorBonus returns the unit's own armor negated (armor * -1) so the engine's native physical mitigation cancels to zero, while GetModifierIncomingPhysicalDamage_Percentage re-applies the desired reduction with a custom formula (and a separate diminishing branch for negative armor: ((2-(0.94^abs(min(armor,-20))))*100)-100). The non-obvious enabler is a self.checkArmor reentrancy guard: calling GetPhysicalArmorValue() inside the armor-bonus hook would normally recurse forever, so it sets a flag, reads the real armor, clears the flag, and returns 0 on the re-entrant call. This 'negate native, reapply custom, guard the recursive read' pattern is a clean reusable way to swap out any engine stat curve and is not in the KB. (C:/Users/work/.dota2-workshop-mcp/reflib/items/301622730/files/scripts/vscripts/abilities/modifier_custom_armor_formula.lua)
      function modifier_custom_armor_formula:GetModifierPhysicalArmorBonus()
      	if (self.checkArmor) then return 0
      	else
      		self.checkArmor = true
      		local armor = self:GetParent():GetPhysicalArmorValue(false)
      		self.checkArmor = false
      		return armor * -1
      	end
      end
  * [architecture / game-feel] Anti-overflow creep governor: cap alive enemies and force-cull excess to the goal as both a perf throttle and a gameplay penalty: Because this is a mirror-survival where each team's uncleared creeps accumulate, the game runs a self-balancing safeguard: when a team's alive-creep count crosses 200, CreepControl() warns the team (sound + custom message), waits 10s, re-checks, and if still over 200 it shuffles the eligible (countOnDeath) creeps and force-kills (with an illusion-death VFX/SFX) exactly enough of them to bring the count down to 190 - simultaneously leaking 1 life per culled unit so it doubles as a gameplay penalty for not killing fast enough. The pattern (track a live-entity count incrementally as units spawn/die, trip a threshold, shuffle-and-cull back to a low-water mark) is a reusable performance/grief governor for any wave/spawn-heavy mode; KB has wave spawners but not a self-throttling overflow culler tied to a life penalty. (C:/Users/work/.dota2-workshop-mcp/reflib/items/301622730/files/scripts/vscripts/enfos.lua)
      if Enfos.RADIANT_CREEPCOUNT >= 200 and Enfos.RadCreepCheck == false then CreepControl(2) end
      ...
      local creepNumber = -190
      if team == DOTA_TEAM_GOODGUYS then creepNumber = creepNumber + Enfos.RADIANT_CREEPCOUNT end
      for i = 1, creepNumber do ... units[i]:ForceKill(true) ... GameRules.Enfos:ModifyLife(team, 1, 1) end
  * [novel game-mode mechanic / UX] Pre-game lobby UI as a settings-vote ballot: read dropdowns/checkboxes during CUSTOM_GAME_SETUP and average votes into GameRules: Instead of a separate in-game vote screen, the custom team-select panel embeds a ballot (difficulty radio buttons, an extra-bounty dropdown, share-bounty / all-random / no-item-sharing checkboxes). When Game.GetState() reaches DOTA_GAMERULES_STATE_HERO_SELECTION (>=3), the HOST client (gated on player_has_host_privileges) auto-fires SendVotes() exactly once (transitionHappened guard), scraping each control's state - including parsing a dropdown id substring for the bounty value (selectedText.substring(6)) - and ships it via player_voted_difficulty. Server-side UpdateVotes tallies every game setting by AVERAGING the numeric votes across players and rounding to nearest (difficulty_level/#votes, floor(x+0.5)) to derive GameRules.DIFFICULTY/ExtraBounty/SharedBounty/AllRandom/ItemSharing before launch. The full 'lobby panel -> per-setting averaged vote -> GameRules config' pipeline (reading native team-select state + host-only auto-submit on state transition) is more than the generic 'picker' UI in the KB. (C:/Users/work/.dota2-workshop-mcp/reflib/items/301622730/files/panorama/scripts/custom_game/team_select.js)
      if (Game.GetState() >= 3) {
        if (transitionHappened == false && Game.GetLocalPlayerInfo().player_has_host_privileges) { SendVotes() };
      }
      ...
      var selectedText = bountySelected.GetSelected().id; extraBounty = selectedText.substring(6);
  * [native-HUD / UX] Shop-NPC multi-unit selection preservation via the query-unit event (don't lose your army when opening a unit-shop): For a unit that acts as a shop (npc_trader_guild_shop), clicking it would normally clear your existing multi-unit (army) selection. This subscribes to dota_player_update_query_unit (the right-click/QUERY event, which fires for the hovered/queried unit rather than the committed selection) and, when the queried unit is the shop, opens the custom shop panel BUT immediately re-issues GameUI.SelectUnit() across the previously-cached selection group (captured separately from dota_player_update_selected_unit), restoring multi-select with the additive flag toggled after the first unit. Net effect: players interact with a world shop entity without losing control of their selected army - a reusable selection-state-preservation pattern using query-vs-selection event distinction that isn't covered by the KB's existing selection/drag-drop notes. (C:/Users/work/.dota2-workshop-mcp/reflib/items/301622730/files/panorama/scripts/custom_game/trader.js)
      GameEvents.Subscribe("dota_player_update_query_unit", UnitQuery);
      ...
      if (Entities.GetUnitName(query) == "npc_trader_guild_shop") {
        ... var starter = false; var newselect = PrevSelect;
        for (i = 0; i < newselect.length; i++) { GameUI.SelectUnit(newselect[i],starter); if (starter == false) starter = true; }
      }

## Omni Party (id 307510729)
  * [game-mode-mechanics / minigame-framework] Polymorphic minigame-collection framework: uniform lifecycle contract + shuffle-bag rotation + per-game camera override, driven by one polling MainThink: A reusable framework for a 'party game' / minigame-rotation custom game that is structurally different from the KB's generic state machine + wave/round spawners. Every minigame is a class implementing the SAME duck-typed interface and is registered in one list: Intro() (sets help text + camera distance, called during the countdown so the tutorial shows while units are frozen), InitMinigame() (spawns units, called exactly MINIGAME_START_DELAY before go so units freeze in place), MinigameThink() (called once/sec; returning nil signals 'this game is over' and transitions to POST), Destroy() (cleanup), plus optional OnUnitDeath/OnPlayerChat which the core conditionally forwards only if the current game defines them (self._Minigame.OnUnitDeath ~= nil). The orchestrator is a 4-state machine (NONE->INTRO->ONGOING->POST) polled by a single 1.0s timer. Game selection uses a non-repeating 'shuffle bag': repeat RandomInt until an unplayed index is found, tracked in _MinigamePlayed, ending the whole match when all are played or MINIGAMES_TO_PLAY is hit. Each game can raise the global camera distance just for itself via OmniParty._CameraDistance set inside Intro(), then applied with SetCameraDistanceOverride. This 'collection of self-contained minigames behind one interface + rotation + per-game camera/intro' pattern is not in our KB and is directly reusable for any party/arcade-style mode. (C:/Users/work/.dota2-workshop-mcp/reflib/items/307510729/files/scripts/vscripts/omniparty.lua)
      if self._Minigame:MinigameThink() == nil then
      	self._MinigameState = MINIGAME_STATE_POST
      	SetMarker("minigame_finished")
      end
      -- ...
      repeat
      	self._MinigameIndex = RandomInt(1, MINIGAME_COUNT)
      until not self._MinigamePlayed[self._MinigameIndex]
      self._MinigamePlayed[self._MinigameIndex] = true
      -- forwarding is conditional on the current game implementing the hook:
      if self._Minigame and self._Minigame.OnUnitDeath then
      	self._Minigame:OnUnitDeath(keys)
      end
  * [architecture / scoring] Tie-aware rank-to-points scoring engine with a swappable equality predicate (Mario-Party placement scoring): A general 'turn ordering/placement into points' engine with correct tie handling, not present in the KB's economy/gold systems. Three entry points share one design: AutoScore(id) awards points incrementally as players finish/die (first death -> 1 point, etc., via _NextScore), AutoScoreReverse() flips so the FIRST finisher gets the MOST (counts down from GetPlayerCount), and AutoScoreFromArray(score, reverse) sorts an arbitrary metric and awards placement points. The clever, reusable core is that ties are handled by a pluggable closure self._ScoreEqualFunction: in live death-order mode it returns true when two deaths land within 0.1s of game time (so simultaneous deaths share a rank), while in array mode it returns true when adjacent sorted values are equal. Tied players get the same points and a _PreviousID list lets every earlier tied member also get bumped. Both per-minigame score and cumulative score are updated together, and Scoreboard:ShowRanks recomputes dense ranks (rank only increments when value differs). This is a self-contained, reusable placement-scoring module. (C:/Users/work/.dota2-workshop-mcp/reflib/items/307510729/files/scripts/vscripts/omniparty.lua)
      local last = 0
      self._ScoreEqualFunction = function()
      	local time = GameRules:GetGameTime()
      	local equal = false
      	if time - last < 0.1 then equal = true end
      	last = time
      	return equal
      end
      -- array mode swaps in adjacency comparison:
      self._ScoreEqualFunction = function(index)
      	if index > 1 then
      		if sorted[index].val == sorted[index - 1].val then return true end
      	end
      	return false
      end
  * [physics / game-feel] Decoupled rolling-prop physics: invisible physics dummy as the gameplay body + a prop_dynamic spun from velocity, with a per-frame anti-double-damage 'squashed' set: A specific, reusable technique for a believably rolling boulder/snowball that the KB's generic 'custom physics SAP+CCD' line does not cover. The gameplay object is an invisible npc_dummy running the physics sim (Physics:Unit + SetGroundBehavior(PHYSICS_GROUND_LOCK) + friction/max-velocity), while the VISIBLE object is a separate prop_dynamic that is never simulated. Every physics frame, the prop's spin is computed directly from the dummy's velocity: vAngles = velocity * 360 / (2*pi*r_roll*30), converted to a QAngle and composed onto current angles with RotateOrientation, so it appears to roll without slipping. A deliberate 'roll radius' offset (scale*(MODEL_RADIUS-80)) plus a +Vector(0,0,r_roll) reposition keeps the ball half-submerged so the lock-to-ground looks natural. Damage runs on its own interval timer and uses a per-ball _Squashed[entindex] table reset/marked each tick so a unit standing under the ball is only damaged once per pass (and a pusher can mark themselves squashed to avoid self-kill). Reusable for any rolling/momentum hazard. (C:/Users/work/.dota2-workshop-mcp/reflib/items/307510729/files/scripts/vscripts/minigames/snowwar.lua)
      Snowball:OnPhysicsFrame(function(unit)
      	local vAngles = Snowball:GetPhysicsVelocity() * 360 / (2 * 3.1415926 * r_roll * 30)
      	vAngles = QAngle(vAngles.x, 0, -1 * vAngles.y)
      	local angles = RotateOrientation(vAngles, SnowballModel:GetAngles())
      	SnowballModel:SetAngles(angles.x, angles.y, angles.z)
      	SnowballModel:SetAbsOrigin(Snowball:GetAbsOrigin() + Vector(0, 0, r_roll))
      end)
      -- double-hit guard:
      if Snowball._Squashed[index] == nil then ApplyDamage{...} end
      Snowball._Squashed[index] = true
  * [data-pipeline / hazard-choreography] Data-driven bullet-hell choreography: nested velocity/interval matrices with synchronized random 'series' selection across grouped spawners: A pure-data hazard-pattern engine for coordinated projectile waves, distinct from the KB's wave/round spawners (which spawn enemies on a cadence). Hazards are declared entirely as data: groups of spawn-lanes, each lane carrying a velocity matrix and a matching interval matrix (velocity[series][step], interval[series][step]); a 0 velocity entry encodes a deliberate 'skip/pause' beat. At runtime a single shared per-group timer-state walks step n through the chosen series s; when a series finishes it advances a flag and only re-rolls a new random series (s = RandomInt(1, max_s)) once ALL lanes in the group have completed their current series (flag == count[k]), keeping multiple lanes choreographed together rather than drifting out of sync. This lets designers author Geometry-Wars/Crossy-Road-style timed patterns as tables with no code, and the same loop drives lane counts from 1 to many. Reusable for any timed obstacle/projectile choreography. (C:/Users/work/.dota2-workshop-mcp/reflib/items/307510729/files/scripts/vscripts/minigames/snowball.lua)
      if n > max_n then
      	if flag == count[k] then
      		s = RandomInt(1, max_s)
      		flag = 1
      	else
      		flag = flag + 1
      	end
      	max_n = _max_n[i][s]
      	n = 1
      end
      if v.velocity[s][n] ~= 0 then
      	self:CreateSnowball(SNOWBALL_SIZE, v.start, v.velocity[s][n] * (v.dest - v.start):Normalized(), (v.dest - v.start):Length())
      end
      return v.interval[s][n]
  * [engine-pattern / timing] Named global time-markers (SetMarker/GetMarker) as a lightweight 'has N seconds elapsed since event X' primitive instead of timers: A tiny but genuinely different timing primitive used pervasively across the codebase and not in our KB (which covers Timers/think-loops and track-progress scalars). Instead of creating a callback timer for every 'after X seconds' check, the game stamps a named timestamp into a global table on an event (SetMarker('flamestrike_increment'), SetMarker('minigame_finished')) and later polls GetMarker(name) which returns elapsed game-time since the stamp (with a small MARKER_PRECISION fudge and a default of 0 for unset names). This turns difficulty ramps, respawn windows, cooldowns and the POST-game delay into cheap inline comparisons inside the once-per-second MinigameThink (e.g. 'if GetMarker("flamestrike_increment") >= INCREMENT_TIME then ... SetMarker(...) end'), avoiding timer churn and making timing state inspectable/global. Reusable anywhere you want stopwatch-style 'time since event' checks driven by an existing think loop. (C:/Users/work/.dota2-workshop-mcp/reflib/items/307510729/files/scripts/vscripts/utilities.lua)
      MARKER_PRECISION = 0.01
      function SetMarker(name)
      	GlobalTimeMarker[name] = GameRules:GetGameTime()
      end
      function GetMarker(name)
      	if GlobalTimeMarker[name] == nil then return 0 end
      	return GameRules:GetGameTime() - GlobalTimeMarker[name] + MARKER_PRECISION
      end

## Escape the Undying Dead (id 630768961)
  * [vscript architecture / engine workaround] Flag-based decoupled death: 'isSafe' boolean + intrinsic self-kill thinker: Instead of every hazard dealing damage, this game decouples 'what hurts you' from 'the kill'. Every hazard (enemy proximity, terrain triggers) just flips a per-hero boolean field: kill_radius_lua's intrinsic modifier sets target.isSafe=false on any hero it finds in radius; safety triggers (OnStartSafety/OnEndSafety in triggers.lua) set ent.isSafe=true when stepping ON the legal path and false when stepping off (only while z<140, i.e. off the raised path). Then a SINGLE intrinsic modifier_self_immolation runs StartIntervalThink on every hero and does 'if not caster.isSafe then caster:Kill()'. This means one centralized kill loop handles ALL death sources (lava, grass, getting touched, walking off path) uniformly, no per-source ApplyDamage. The DamageFilter even zeroes out self-damage when isSafe, so the flag is the single source of truth. Reusable for any maze/parkour/escape/floor-is-lava mode where 'touching anything bad = instant death' and you want hazards to be trivially cheap (set a bool) rather than each running damage logic. (C:/Users/work/.dota2-workshop-mcp/reflib/items/630768961/files/scripts/vscripts/abilities.lua)
      function modifier_self_immolation:OnIntervalThink()
        if IsServer() then
          local caster = self:GetCaster()
          if caster:IsAlive() then
            if not caster.isSafe then
              caster:SetAbsOrigin(caster:GetAbsOrigin() + Vector(0, 0, 10))
              caster:Kill(self:GetAbility(), caster)
            end
          end
        end
      end
      -- and the hazard side (kill_radius modifier OnIntervalThink):
      --   for _,target in pairs(targets) do target.isSafe = false end
  * [co-op game-mode mechanic] Co-op proximity revive: dead player drops a beacon 'X', any teammate who walks into radius revives them at a biased midpoint: A genuinely novel cooperative rescue mechanic. On death, HeroKilled saves hero.deadHeroPos and spawns a phased dummy carrying a per-player colored Kunkka 'X-marks-the-spot' beacon particle (BeaconPart indexed by player color id), storing the particle index on the hero. A global ReviveThinker loops every 0.1s over all living heroes x all dead heroes; if a LIVING hero comes within alivehero.reviveRadius of a dead hero's saved corpse position, HeroRevived fires. The revive position is NOT the death spot or the rescuer's spot but AveragePosBias(rescuer, deathPos, 0.66) so the revived player pops out 2/3 toward the rescuer (i.e. safely onto the path, away from whatever killed them). reviveRadius is itself derived per-hero from a non-linear rescale of model radius (pow(r,0.5)*7 normalization) so big and small heroes get fair pickup ranges. Walking-off-path deaths also nudge deadHeroPos backward along the corpse's forward vector so the X lands on reachable ground. Reusable verbatim for any co-op 'rescue your downed teammate by reaching them' design. (C:/Users/work/.dota2-workshop-mcp/reflib/items/630768961/files/scripts/vscripts/events.lua)
      function EscapeTest:ReviveThinker()
        for _, alivehero in pairs(Players) do
          if alivehero:IsAlive() then
            for _, deadhero in pairs(Players) do
              if deadhero.deadHeroPos then
                local reviveRadius = alivehero.reviveRadius
                if deadhero.largerXMod then reviveRadius = math.min(reviveRadius * 1.5, REVIVE_RAD_MAX) end
                if CalcDist2D(alivehero:GetAbsOrigin(), deadhero.deadHeroPos) < reviveRadius then
                  EscapeTest:HeroRevived(deadhero, alivehero)
                end
              end
            end
          end
        end
      end
      -- HeroRevived: local respawnLoc = AveragePosBias(alivehero:GetAbsOrigin(), xLocation, 0.66)
  * [data pipeline / backend] Firebase Realtime DB used directly as a self-pruning speedrun leaderboard (lexicographic time-key + DELETE-slowest cap + anti-bug guard): Goes well beyond a generic 'HTTP backend with server key'. The leaderboard IS a Firebase Realtime Database hit straight from CreateHTTPRequestScriptVM with GET/PUT/DELETE on '<url>/<dedicatedServerKey>/<key>.json'. Three reusable tricks: (1) the record KEY is string.format('%05d', totaltime)..'_'..matchId, so Firebase's lexicographic key ordering sorts the table by run time for free (zero-padding makes string order == numeric order). (2) The DB is SELF-PRUNING: it keeps only maxEntries; on game end it computes slowestId (GetTableKeyFromValue by totaltime) and fires a DELETE on that node only when over the cap AND all timesplits are non-zero, so the cloud table stays bounded without any server-side rules/cron. (3) Anti-cheat 'bugged score' guard: a run is only submitted if NONE of its per-level timesplits are 0 (a 0 split means a checkpoint trigger was skipped/glitched) AND not cheats AND not patreonUsed. The whole thing needs no custom server code at all -- just a Firebase project URL. (C:/Users/work/.dota2-workshop-mcp/reflib/items/630768961/files/scripts/vscripts/webapi.lua)
      local name = string.format("%05d", gamescore.totaltime) .. "_" .. tostring(gamescore.matchId)
      local request = CreateHTTPRequestScriptVM("PUT", leaderboardURL .. name .. ".json")
      request:SetHTTPRequestRawPostBody("application/json", json.encode(gamescore))
      -- self-prune:
      local deleteData = numEntries > maxEntries
      for _,entry in pairs(leaderboard) do for _,time in pairs(entry.timesplits) do if time == 0 then deleteData = false end end end
      if (deleteData and slowestId) then CreateHTTPRequestScriptVM("DELETE", leaderboardURL .. slowestId .. ".json"):Send(...) end
  * [monetization / fairness architecture] Paid-entitlement (Patreon) perk system keyed by SteamID that auto-DQs the run from the competitive leaderboard: A reusable pattern for monetizing a custom game WITHOUT pay-to-win on the leaderboard. A second Firebase DB (patreonURL) maps SteamID -> tier level, summed across multiple groups (a player's tier = sum of all their entries, so a 'winners' group can stack on a 'patrons' group). Loaded once into WebApi.patreons. An in-game item_patreon_chest reads PlayerResource:GetSteamID -> looks up the tier -> grants that many escalating reward items (cheese-roll, larger revive-X, wind lace, phoenix ash self-revive, phase) by descending tier index. The crucial fairness hook: the instant a player consumes ANY patron perk, it sets _G.patreonUsed = true, and FinalizeGameScoreAndSend refuses to submit the run (isLegitGame = not (cheats or bugged or patreonUsed)). So supporters get cosmetic/QoL power but their runs are excluded from the public speedrun board. Clean separation of 'support the dev' vs 'competitive integrity'. (C:/Users/work/.dota2-workshop-mcp/reflib/items/630768961/files/scripts/vscripts/patreon_items/item_patreon_chest.lua)
      if WebApi.patreons[steamID] then
        patreonLevel = WebApi.patreons[steamID]
        patreonLevel = math.min(patreonLevel, 5)
        if patreonLevel > 0 then _G.patreonUsed = true end -- run no longer counts on leaderboard
      end
      while patreonLevel >= 0 do
        caster:AddItemByName(itemList[patreonLevel])
        patreonLevel = patreonLevel - 1
      end
      -- webapi.lua: local isLegitGame = isTesting and true or not (cheats or bugged or patreonUsed)
  * [vscript architecture] Data-driven level/entity registry: column-aliased tuple tables + dispatch-by-name into thinker methods: An entire 6-level escape campaign is defined as plain Lua data, not code. Each entity is a positional tuple inside EntList[level] (e.g. {2, ENT_PUDGE, 0, 'pudge_loc1', 'PudgeThinker'}); the tuple SLOTS are given named integer-constant aliases (ENT_UNTIM=1, ENT_TYPEN=2, ENT_INDEX=3, ENT_SPAWN=4, ENT_RFUNC=5, plus per-type column aliases like PAT_VECNM/GAT_ORIEN/TIN_ANGL1) so reads look like entvals[ENT_SPAWN] instead of magic indices -- a poor-man's struct with zero allocation overhead. SpawnEntities iterates the level's tuples, creates the item or unit, writes the live entity index back into slot ENT_INDEX (so CleanLevel can later RemoveSelf the exact spawned handles), then DISPATCHES the per-entity behavior by string: EscapeTest[entvals[ENT_RFUNC]](EscapeTest, unit, entvals). Parallel tables FuncList[level] (named functions to run) and PartList[level] (particles to attach to dummies) extend the same pattern. New content = edit data tables, not write spawn code. Reusable for any wave/level/scenario-driven mode that wants designers editing tables instead of touching logic. (C:/Users/work/.dota2-workshop-mcp/reflib/items/630768961/files/scripts/vscripts/events.lua)
      for i,entvals in pairs(EntList[level]) do
        local entname = Ents[entvals[ENT_TYPEN]]
        local pos = Entities:FindByName(nil, entvals[ENT_SPAWN]):GetAbsOrigin()
        if entvals[ENT_UNTIM] == 2 then
          local unit = CreateUnitByName(entname, pos, true, nil, nil, DOTA_TEAM_ZOMBIES)
          EntList[level][i][ENT_INDEX] = unit:GetEntityIndex()      -- write live handle back into the tuple
          if entvals[ENT_RFUNC] then
            EscapeTest[entvals[ENT_RFUNC]](EscapeTest, unit, entvals) -- dispatch thinker by string name
          end
        end
      end
