# Novel techniques (batch 3) — 23 findings

## Dota 2 Duel 1v1 (id 890449266)
  * [engine-workaround] Runtime-grafted fountain silence aura (anti-fountain-camp) via self-healing think loop: Fountains are engine-owned (ent_dota_fountain) entities you cannot edit in KV, so this mod grafts a custom datadriven ability onto every fountain AT RUNTIME to enforce a 1v1 anti-spawn-camp / anti-fountain-hug rule. A GlobalThink (every 1s) re-scans all ent_dota_fountain, and for any that has lost the ability it re-adds 'fountain_silence_aura' and re-sets its level — making it self-healing across the fountain rebuild/reset that happens at game-state transitions, which is exactly why a one-time setup would silently fail. The ability itself is an AURA+PASSIVE ability_datadriven whose aura applies an unpurgeable MODIFIER_STATE_SILENCED to enemies within 750 range. This is a reusable primitive for 'attach behavior to an entity Valve won't let you define in script' (fountains, shops, etc.) plus the pattern of defending runtime-grafted abilities with a recurring think check. Technique not in KB (KB only has generic Valve fountain/EndCooldown API snippets, no fountain-graft or self-healing-graft pattern). (C:\Users\work\.dota2-workshop-mcp\reflib\items\890449266\files\scripts\vscripts\addon_game_mode.lua)
      local fountains = Entities:FindAllByClassname("ent_dota_fountain");
      	for k, v in pairs(fountains) do
      		if (v) then
      		if (not v:HasAbility("fountain_silence_aura")) then FixFountain(v) end;
      		end
      	end
      ... 
      function FixFountain(npc)
      	if (npc) then
      		npc:AddAbility("fountain_silence_aura");
      		local silence = npc:GetAbilityByIndex(0);
      		if (silence) then
      			silence:SetLevel(1);
      		end
      	end
      end
  * [scripting-idiom] Reuse modifier_phoenix_supernova_hiding as a disconnect 'stasis/hide' primitive: Disconnect handling for a kill-limit arena: on player_disconnect the abandoned hero is force-respawned and given Phoenix's built-in egg-hiding modifier (modifier_phoenix_supernova_hiding), which removes the unit from the world (hidden + untargetable) so the remaining player cannot farm a free kill toward the kill-limit win condition off an AFK hero; on player_reconnected the same modifier is re-applied with duration=0.00 to clear it instantly and bring the hero back. This is a non-obvious repurposing of an existing hero ability's internal modifier as a general-purpose 'put a unit in stasis / hide it' building block, plus the duration=0.00 trick to instantly strip a no-duration modifier. Not in KB. (C:\Users\work\.dota2-workshop-mcp\reflib\items\890449266\files\scripts\vscripts\addon_game_mode.lua)
      function CDotaDuel:OnDisconnect(keys)
      	local hero = PlayerResource:GetPlayer(keys.PlayerID):GetAssignedHero()
      	hero:RespawnHero(false,false)
      	hero:AddNewModifier(hero, nil, "modifier_phoenix_supernova_hiding", nil)
      end
      
      function CDotaDuel:OnReconnect(keys)
      	local hero = PlayerResource:GetPlayer(keys.PlayerID):GetAssignedHero()
      	hero:AddNewModifier(hero, nil, "modifier_phoenix_supernova_hiding", {duration = 0.00})
      end
  * [architecture] Arena round-reset: zero all ability + item cooldowns on dota_team_kill_credit: Duel 'fresh round' idiom driven by the dota_team_kill_credit event (fires once per scoring kill, distinct from entity_killed): on every kill it walks all heroes and calls EndCooldown() on each non-passive ability slot 0-15 and on each item slot 0-5, so both duelists re-engage with everything off cooldown next round. The reusable insight is the event choice (dota_team_kill_credit as the canonical 'a kill was scored' hook for round-based arenas) combined with resetting items as well as abilities. KB documents EndCooldown only as a Valve API call / item refund; it does not cover this kill-credit-driven full-arsenal round-reset pattern. (C:\Users\work\.dota2-workshop-mcp\reflib\items\890449266\files\scripts\vscripts\addon_game_mode.lua)
      function CDotaDuel:OnTeamKillCredit(keys)
      	local spawnedUnit = HeroList:GetAllHeroes()
      		...
      				for i=0,15 do
      				local ability = v:GetAbilityByIndex(i)
      					if ability and ability:IsPassive() ~= true then
      						ability:EndCooldown()
      					end
      				end
      				for i = 0, 5 do
      					v:GetItemInSlot(i):EndCooldown() 
      				end

## Dark Moon All Pick (id 860855167)
  (nothing novel)

## Tree Tag (304291612)
  * [engine-workaround / movement] Off-mesh terrain traversal via pathing-fly + tiered decaying slow stack ("cliff climbing"): Lets a normally ground-locked unit cross blocked cliffs/terrain in a controlled, punishing way. A per-tick OnIntervalThink (modifier_fake_flying_lua) toggles MODIFIER_STATE_FLYING_FOR_PATHING_PURPOSES_ONLY so the unit can step onto GridNav:IsBlocked cells, records vLastGoodPosition each frame, and SetAbsOrigin's the unit back if it ends a tick on a blocked cell (rubber-band). What is genuinely new vs the KB's generic rubber-banding: when the engine reports the unit is standing on blocked ground, fakefly() in abilities_treant.lua applies THREE overlapping timed movespeed penalties of decreasing magnitude/increasing duration (tt_climbing -200 for 1.1s, tt_climbing_med -50 for 3.0s, tt_climbing_long -25 for 5.0s). The result is a re-applied-while-climbing stack that crawls the unit across the cliff and leaves a fading 'just climbed' tax afterward, instead of a hard wall or instant teleport. A reusable recipe for soft, exploit-resistant 'shortcut over impassable terrain' movement. (C:/Users/work/.dota2-workshop-mcp/reflib/items/304291612/files/scripts/vscripts/abilities_treant.lua)
      if treefound then
      	getStackItem(keys.caster):ApplyDataDrivenModifier(unit, unit, "tt_treespeed", {duration="0.1"})
      elseif standingonblockedPos then
      	getStackItem(keys.caster):ApplyDataDrivenModifier(unit, unit, "tt_climbing", {duration="1.1"})
      	getStackItem(keys.caster):ApplyDataDrivenModifier(unit, unit, "tt_climbing_med", {duration="3.0"})
      	getStackItem(keys.caster):ApplyDataDrivenModifier(unit, unit, "tt_climbing_long", {duration="5.0"})
      end
  * [level-design / asymmetric-terrain] Live tree grid as asymmetric terrain (one team walks trees, the other must chop & gets self-slowed): The whole tag chase is built on giving the two teams opposite relationships to the map's living trees, using GridNav:GetAllTreesAroundPoint + tree:IsStanding as a per-frame terrain query. Treant (hider) team: when standing in trees they get tt_treespeed (+40 MS AND MODIFIER_STATE_NOT_ON_MINIMAP_FOR_ENEMIES) so the forest is fast, walkable cover. Timbersaw (hunter) team: the same per-tick check instead calls tree:CutDownRegrowAfter(8, team) on nearby standing trees and self-applies a stacking tt_chop_tree_slow (-8 MS, MODIFIER_ATTRIBUTE_MULTIPLE) so cutting a path through the forest is slow and noisy. Trees regrow (SetTreeRegrowTime), so the maze is dynamic and self-healing. This is a reusable pattern for asymmetric maze/stealth maps where destructible foliage IS the level geometry, not decoration. (C:/Users/work/.dota2-workshop-mcp/reflib/items/304291612/files/scripts/vscripts/abilities_timber.lua)
      for _,tree in pairs(GridNav:GetAllTreesAroundPoint(position, 125, true) )  do
      	if tree:IsStanding() then
      		tree:CutDownRegrowAfter(8, unit:GetTeamNumber())
      		treefound = true
      		getStackItem(keys.caster):ApplyDataDrivenModifier(unit, unit, "tt_chop_tree_slow", {duration="0.5"})
      	end
      end
  * [architecture / economy] Proximity economy-interference aura (anti-clustering build spacing via mutual debuffs): A spatial twist on income mechanics that the KB's economy/income-tax section does not cover: gold income is balanced by how spread-out your buildings are. Each gold mine's per-tick payout function (passivegold) pays exponential gold 2^(level-1), then scans 600u and applies a slowmine debuff to every OTHER mine of the same team owned by a different player, which cuts that mine's gold in half (gold=floor(gold*0.5+0.5) when slowmine/scannedmine present). Conversely an isolated builder gets fastmine (+20% gold) and lone_wolf (+60 MS) via speedifnobuildings, which only fires when NO friendly building is within 500u. Net effect: a self-balancing 'don't cram all your farms together / don't huddle with teammates' economy entirely driven by FindAllByClassnameWithin proximity checks. Timbersaw's flare (debuffeco) reuses the same scannedmine debuff to remotely halve enemy mine income. Reusable for builder/RTS economies that want emergent base-spreading without hard placement rules. (C:/Users/work/.dota2-workshop-mcp/reflib/items/304291612/files/scripts/vscripts/custom_abilities.lua)
      local goldMineLevel = string.gsub(keys.caster:GetUnitName(), "(npc_treetag_building_mine_)", "")
      local gold = 2 ^ (goldMineLevel - 1);
      if keys.caster:HasModifier("slowmine") or keys.caster:HasModifier("scannedmine") then
      	gold = math.floor(gold*0.5+0.5)
      end
      ... -- then for each nearby same-team mine owned by a DIFFERENT player:
      local item = CreateItem( "item_apply_stack_debuffs", unit, unit )
      item:ApplyDataDrivenModifier(unit, unit, "slowmine", {duration = "1.5"})
  * [architecture / builder-economy] Owner-hero as the resource bank for disposable controlled creep-buildings: An RTS-builder pattern layered on Dota's hero economy: every placed structure (mine/turret/wall/well) and worker (spirit) is a npc_dota_creep created with SetOwner(caster:GetPlayerOwner():GetAssignedHero()) + SetControllableByPlayer, but it owns no resources of its own. Instead, structure ability costs are validated and spent against the OWNER HERO's mana (interruptifnotech: if hero mana < ability ManaCost, Interrupt the building's cast and EndCooldown; otherwise hero:SpendMana), structure gold costs are refunded to the owner hero on demolish (suicide/suicidefarm: ModifyGold on GetAssignedHero), and a worker's mana is clamped to the owner hero's mana (ownermana). This cleanly turns one persistent hero into the player's wallet/manapool while the actual gameplay units are cheap, throwaway creeps you can mass-place and sacrifice. Reusable scaffold for tower-defense / builder modes that want a single accountable economy entity behind many controllable units. (C:/Users/work/.dota2-workshop-mcp/reflib/items/304291612/files/scripts/vscripts/custom_abilities.lua)
      if keys.caster:GetPlayerOwner():GetAssignedHero():GetMana() < manaprice then
      	keys.caster:Interrupt()
      	keys.caster:InterruptChannel()
      	keys.ability:EndCooldown()
      	sendError(keys.caster:GetPlayerOwnerID(), "Not enough mana on hero")
      else
      	keys.caster:GetPlayerOwner():GetAssignedHero():SpendMana(manaprice, nil)
      end

## Bash Wars (298940751)
  (nothing novel)

## Survival TD (id 484192952)
  * [panorama / placement UI] Client-side tower placement validity via per-corner screen-entity raycast (no server round-trip): The placement ghost validates buildability entirely on the Panorama client every 0.01s. For the 4 grid corners around the snapped cursor cell it converts each corner world pos -> screen pos with Game.WorldToScreenX/Y, then GameUI.FindScreenEntities(corner) at that pixel returns whatever entity sits under it; each found entity's AbsOrigin is run through a grid-overlap test and the matching corner's ghost square particle is independently tinted red (occupied) or green (free). This gives Warcraft-3-style 'partial cell blocked' feedback with zero EngineEvent/round-trip to the server. Reusable for any grid-build/placement UI to compute occupancy purely client-side. Key calls: GameUI.FindScreenEntities, Game.WorldToScreenX/Y, Game.ScreenXYToWorld, Entities.IsHero filter, per-corner SetParticleControl color. (C:/Users/work/.dota2-workshop-mcp/reflib/items/484192952/files/panorama/scripts/custom_game/custom_cursor_action.js)
      for (var ent of GameUI.FindScreenEntities(corner)) {
        /* Skip hero entities, only the builder is a hero in this tower defense */
        if (Entities.IsHero(ent.entityIndex)) continue;
        var AbsOrigin = Entities.GetAbsOrigin(ent.entityIndex);
        collided = PositionCollides(AbsOrigin, gameCorner);
        if (collided) break;
      }
  * [particles / placement ghost] Particle building-ghost driven by a server-side EF_NODRAW dummy unit (arbitrary model preview + range circle): To preview an arbitrary unit's MODEL as a cursor-follow ghost (Panorama can't instantiate units), the server keeps one cached EF_NODRAW dummy per tower type (GetOrCreateDummy) with modifier_out_of_world applied, and on 'build phase' sends only that dummy's entIndex + ModelScale + AttackRange to the client. The client then renders particles/ui_mouseactions/ghost_model.vpcf bound to that entindex via SetParticleControlEnt(..., PATTACH_ABSORIGIN_FOLLOW, 'follow_origin', ...) so the dummy's model shows as a tintable ghost, plus radius_indicator_tower.vpcf sized to AttackRange as a live range circle, all repositioned each tick from GetCursorPosition. If the tower has a hero 'Portrait' it swaps the dummy to that hero so override-building models still preview. Reusable recipe for cursor model previews of non-instantiable client units. (C:/Users/work/.dota2-workshop-mcp/reflib/items/484192952/files/panorama/scripts/custom_game/custom_cursor_action.js)
      modelParticle = Particles.CreateParticle("particles/ui_mouseactions/ghost_model.vpcf", ParticleAttachment_t.PATTACH_ABSORIGIN, player);
      Particles.SetParticleControlEnt(modelParticle, 1, EntIndex, ParticleAttachment_t.PATTACH_ABSORIGIN_FOLLOW, "follow_origin", Entities.GetAbsOrigin(EntIndex), true);
      Particles.SetParticleControl(modelParticle, 4, [ModelScale,0,0]); // Scale
  * [engine workaround / tower lifecycle] Build/upgrade progress faked as a health-bar lerp + bootstrapped manual attack system: A newly placed tower is spawned at 1 HP and stunned/disarmed/unselectable via the data-driven 'hidden_tower_states' ability; a 0.03s timer lerps SetHealth from 1 -> MaxHealth over BuildTime so the normal unit health bar visibly fills as the construction timer, and completion is detected simply by health >= MaxHealth (then SetControllableByPlayer + fire tower_built). The same ability bootstraps a hand-rolled attack acquisition: it disables auto-attack (MODIFIER_PROPERTY_DISABLE_AUTOATTACK), sets SetIdleAcquire(false) and AcquisitionRange 0, then a 0.1s OnIntervalThink (attacks.lua AutoAcquire) only issues DOTA_UNIT_ORDER_ATTACK_TARGET when the unit IsIdle and a target passes the ground/air capability test - giving full control over target selection while reusing the engine's health bar as a free progress UI. (C:/Users/work/.dota2-workshop-mcp/reflib/items/484192952/files/scripts/vscripts/abilities/build_tower.lua)
      local healthPertick = (MaxHealth - currentHealth) / (buildTime / timerTimeout)
      Timers:CreateTimer(function()
        currentHealth = currentHealth + healthPertick
        unit:SetHealth(currentHealth)
        if (currentHealth < MaxHealth) then return timerTimeout end
        if eventHandler ~= nil then eventHandler() end
      end)
  * [architecture / tech-tree] In-place tier upgrade by unit-replacement using '_level_N' name-string arithmetic (shared on server + client): Tower upgrades are done by destroying the old unit and creating the next tier, where the next unit's name is derived purely by string math on a '_name_level_N' convention (level 1 -> append '_level_2', level>1 -> increment trailing digit) - implemented identically in upgrade_tower.lua (server) and custom_action_bar_ability.js (client, to show the upgrade's gold cost from the net-table Towers map before casting). The old unit's 'Platform' prop entity reference is carried to the new unit, abilities are re-leveled by index, and the old unit is parked at z=-512 + destroyed after the 0.1s think tick. Separately, a global 'tier' tech-gate is the builder hero's level/XP: upgrade_tier just AddExperience + ability SetLevel, and the build menu greys towers whose RequiresLevel > hero level. A single Lua class is aliased across all per-tower ability defs (upgrade_tower_archer = upgrade_tower, ...). (C:/Users/work/.dota2-workshop-mcp/reflib/items/484192952/files/scripts/vscripts/abilities/upgrade_tower.lua)
      function upgrade_tower:GetUpgradedUnitName()
          local UnitName = self:GetCaster():GetUnitName()
          local level = self:GetUpgradeLevel()
          if level > 1 then
              UnitName = string.sub(UnitName, 0, -2) .. (level + 1)
          else
              UnitName = UnitName .. '_level_' .. (level + 1)
          end
          return UnitName
      end

## Ancient Wars (Castle Fight port) — id 305030070
  * [engine-workaround / HUD] Hero attribute pools repurposed as native-HUD RTS resource counters: Instead of building custom resource UI, the game stores three custom RTS economies directly in the hero's three native Dota attributes so the stock attribute HUD renders them for free with zero Panorama work: Intellect = 'Energy' (consumed/refunded per build/upgrade), Strength = 'Tech' (research/tech level), and Agility = 'Income'. Every build/upgrade/refund path keeps an authoritative _G.PLAYER_TECH[playerID] table in sync and mirrors it into SetBaseStrength; energy is read/written via GetIntellect/SetBaseIntellect; income is pushed via SetBaseAgility(0)+ModifyAgility(income). Non-obvious because it overloads engine systems (the stat panel + tooltips) that have nothing to do with combat stats, getting a polished resource display and replication for free. Reusable for any RTS/economy mode that wants 1-3 extra spendable resources without custom HUD. (C:\Users\work\.dota2-workshop-mcp\reflib\items\305030070\files\scripts\vscripts\builder.lua)
      local NewIntel = HeroIntellect - energy_cost
      _G.PLAYER_TECH[playerID] = _G.PLAYER_TECH[playerID] - tech_cost
      hero:SetBaseIntellect(NewIntel)
      hero:ModifyGold(-gold_cost, false, 0)
      hero:SetBaseStrength(_G.PLAYER_TECH[playerID])   -- and on construction complete: hero:SetBaseAgility(0); hero:ModifyAgility(_G.PLAYER_INCOME[...])
  * [game-feel / engine-workaround] Unit mana pool + mana-regen used as a free native progress/cooldown bar: The building's own mana pool is driven 0..100 to render a native circular progress bar with no custom UI — used two ways. (1) Auto-spawn cooldown: a think loop increments .tick by the build rate and calls SetMana(tick/spawn_rate*100), so the mana ring visually fills toward each unit spawn. (2) Build/research/train channel timing: a 'fake mana channel bar' is faked by zeroing mana and setting SetBaseManaRegen(GetMaxMana()/channel_time) so mana fills exactly over the channel duration. Distinct from net-table track-progress (no client code at all — the engine draws it). Reusable for any cooldown/build/charge indicator on units. (C:\Users\work\.dota2-workshop-mcp\reflib\items\305030070\files\scripts\vscripts\construction.lua)
      global.building[k].tick = global.building[k].tick + (global.GLOBAL_BUILD_RATE/1)
      scale = global.building[k].tick/global.building[k].spawn_rate*100
      global.building[k].self:SetMana(scale)
      -- channel variant (mechanics/queue): caster:SetMana(0); caster:SetBaseManaRegen(caster:GetMaxMana()/channel_time)
  * [architecture / UI] Production queue stored in a building's 6 item-inventory slots: The unit-training queue is implemented entirely through the building's native 6-slot item inventory rather than a custom data structure + UI. Each queued train/research order is an item named item_<train_ability>; enqueue does CreateItem+AddItem (cap 6), dequeue removes the item and refunds, and the queue is advanced by scanning slots 0..5, string-stripping the 'item_' prefix to find the paired ability, and channeling it (with EndChannel firing OnChannelSucceeded to spawn). ReorderItems SwapItems-compacts the slots so the inventory bar IS the visible queue with native drag/cancel. Clever, specific reuse of the item bar as an ordered RTS build queue; reusable for any queue-style production UI. (C:\Users\work\.dota2-workshop-mcp\reflib\items\305030070\files\scripts\vscripts\buildings\queue.lua)
      local item_name = "item_"..ability_name
      local item = CreateItem(item_name, caster, caster)
      caster:AddItem(item)
      -- AdvanceQueue: train_ability_name = string.gsub(item_name, "item_", ""); ability_to_channel = caster:FindAbilityByName(train_ability_name); ability_to_channel:SetChanneling(true)
  * [panorama / RTS controls] Client-side selection-group rewriting (box-select skips buildings) with re-entrancy guard: A Panorama script intercepts dota_player_update_selected_unit and, when a drag-select mixes buildings and units (IsMixedBuildingSelectionGroup), programmatically rebuilds the selection to contain only non-building units via GameUI.SelectUnit — implementing the RTS convention that box-select prioritizes army over structures. The non-obvious part is the global `skip` flag: each programmatic GameUI.SelectUnit re-fires the selection-changed event, so the handler sets skip=true before every call to suppress the recursive update storm, then re-emits the corrected selection to the server on a $.Schedule debounce. Reusable pattern for any custom selection-filtering / control-group behavior in Panorama. (C:\Users\work\.dota2-workshop-mcp\reflib\items\305030070\files\panorama\scripts\unit_selection.js)
      if (selectedEntities.length > 1 && IsMixedBuildingSelectionGroup(selectedEntities) ){
        skip = true;
        GameUI.SelectUnit(FirstNonBuildingEntityFromSelection(selectedEntities), false); // Overrides the selection group
        for (var i = 0; i < selectedEntities.length; i++) {
          skip = true; // Makes it skip an update
          if (!IsCustomBuilding(selectedEntities[i])){ GameUI.SelectUnit(selectedEntities[i], true); }
        }
      }

## Titanbreaker RPG (735435188)
  * [AI/combat] Autocast-as-rotation: per-hero scripted combat AI that pilots the player's OWN hero: Repurposes Dota's native per-ability autocast TOGGLE as an opt-in 'rotation bot' for the human player (MMO/ARPG action-bar feel). A single permanent hidden modifier (modifier_auto_casts) listens to DOTA_UNIT_ORDER_CAST_TOGGLE_AUTO orders to build a live set of autocast-enabled abilities, then runs a 0.05s OnIntervalThink (turned off entirely when zero abilities are toggled, for perf). Each tick it dispatches to a per-hero handler via a name->method table (e.g. npc_dota_hero_juggernaut -> GetNextAbilityForJuggernautAutoCasts) that returns the next ability to cast based on a resource/combo state machine (e.g. Juggernaut's yin/yang builder-spender deciding Q-Q-E vs Q-W-W combos, with modifier-remaining-time checks to refresh buffs before they expire). It issues the cast via ExecuteOrderFromTable wrapped in a SetIsOrderFromAutoCast(true/false) re-entrancy guard so its own synthetic orders don't recursively cancel the rotation. Includes several reusable production heuristics: a 'cantBeCastedWhileRunning' blacklist of self-damaging spells that would suicide a kiting hero; a 'mustAutoAttackAfterAutoCast' set for heroes whose spells need weaving with autoattacks (calls MoveToTargetToAttack after each cast); auto-detecting cast-while-moving safety from ability behavior flags (DONT_CANCEL_MOVEMENT / IMMEDIATE); silence/stun/channel/invisibility gating (it even Stop()s a queued cast if the hero just turned invisible, to preserve the invis); a 2500-unit target leash; and summons that auto-toggle all their own autocast abilities on creation and mirror the OWNER's last autocast target every tick by reaching into the owner's modifier_auto_casts. This is a complete, generic framework for 'one-button play' / accessibility autopilot, not a single boss AI. (scripts/vscripts/modifiers/modifier_auto_casts.lua)
      local abilityToAutoCast = self:GetNextAbilityForAutoCast(self.parent, lastAutoCastTarget)
      	if(abilityToAutoCast == nil) then
          	self:TryAutoAttackAfterAutoCast(lastAutoCastTarget)
          else
          	self:PerformAutoCastOfAbility(abilityToAutoCast, lastAutoCastTarget)
          end
      ...
          self.cantBeCastedWhileRunning = { -- abilities that 'Eventually will kill player because tries constantly spam q w e combos even when player running away'
              ["deadly1"] = true, ["deadly2"] = true, ["deadly3"] = true, ...
      ...
          self:SetIsOrderFromAutoCast(true)
          ExecuteOrderFromTable({ UnitIndex = caster:entindex(), OrderType = DOTA_UNIT_ORDER_CAST_TARGET, AbilityIndex = abilityToAutoCast:GetEntityIndex(), Queue = false, TargetIndex = target:entindex() })
          self:SetIsOrderFromAutoCast(false)
  * [game-design/combat] 7-school elemental damage system with multi-element hits and a 'fusion color wheel' transmuter: A full custom damage-school layer (Fire/Holy/Chaos/Nature/Frost/Arcane/Shadow) sitting on top of Dota's physical/magical/pure, expressed entirely as boolean flags on the central DamageUnit event table (event.firedmg, event.shadowdmg, ...). Crucially a single damage instance can carry MULTIPLE element flags simultaneously (CountElementalDamageTypes sums them, e.g. an ice-storm that is both Frost AND Arcane), and downstream bonuses/resistances roll per-element so mixed hits get double benefit. Items/talents/buffs perform element CONVERSION as a normal data step (e.g. modifier_dark turns Arcane into Shadow; modifier_icelotus swaps Frost<->Arcane and grants a crit roll 'everytime this takes effect'; firestone turns Holy into Fire). The standout is modifier_fusion, a deterministic 'color wheel': red(fire) yellow(holy) lightgreen(chaos) darkgreen(nature) blue(frost) pink(arcane) purple(shadow) arranged in a ring, where every element flag on the hit is REPLACED by its two ring-neighbors (fire -> holy+shadow, holy -> fire+chaos, etc.), so a single-element ability fans out into a multi-school strike that benefits from every adjacent resistance-shred. Combined with this, the engine splits bonuses into explicit additive buckets (elemental_bonus, ability_bonus computed additively) vs multiplicative buckets, with a kept-around game_mechanics_backup_pre_additive.lua showing the deliberate migration from all-multiplicative to additive+multiplicative damage math for ARPG tuning. Reusable as a damage-typing/affinity framework far richer than vanilla. (scripts/vscripts/game_mechanics.lua)
      if caster:HasModifier("modifier_fusion") then
          --color wheel: red(fire) yellow(holy) lightgreen(chaos) darkgreen(nature) blue(frost) pink(arcane) purple(shadow)
          --example: fire holy -> shadow holy fire chaos
          if hasFire then getsHoly = true; getsShadow = true end
          if hasHoly then getsFire = true; getsChaos = true end
          if hasChaos then getsHoly = true; getsNature = true end
          if hasNature then getsChaos = true; getsFrost = true end
          if hasFrost then getsNature = true; getsArcane = true end
          if hasArcane then getsFrost = true; getsShadow = true end
          if hasShadow then getsArcane = true; getsFire = true end
  * [RPG/inventory] Procedural item-affix engine: stat-string -> named-modifier whose STACK COUNT stores the magnitude: A Diablo/PoE-style generated-loot system where each equipped item carries up to 3 randomly-rolled stat-type codes plus magnitudes (stored in the inventory array). On equip, items.lua walks every slot and dispatches each human-readable stat string through a big lookup ('% Cooldown Reduction' -> modifier_mythic_cd, ' Fire Damage' -> modifier_mythic_firedmgd, ' Rune Power: FAH' -> modifier_runeword_fah, ...). The clever reusable trick: instead of one modifier per item with custom properties, EVERY affix maps to a single shared named modifier and the affix's numeric magnitude is accumulated into that modifier's STACK COUNT (GetModifierStackCount + SetModifierStackCount), so all sources of e.g. +spell-resistance from any number of items collapse into one stacking modifier, with per-affix hard caps applied at the stack level (spell-res capped at 35, resist-shred at 10). Affixes with no modifier fall through to a second path that writes onto a hero[attributeCode] field resolved from a generated-item data table. The roller (GetGeneratedItemRandomStatTypes) is also reusable: slot- and quality-restricted stat pools, exclusion of duplicate stats already on the item, rarity-gated stat COUNT (40% one-stat / 80% two-stat / else three-stat), a chance for rings/amulets to roll from a separate 'path bonus' index range, and weighted re-rolling of elemental affixes. A clean recipe for runtime ARPG item generation entirely inside Dota's KV/inventory model. (scripts/vscripts/items.lua)
      if amount and amount > 0 and buff ~= "" then
          local sum = hero:GetModifierStackCount(buff, nil)
          herocontrol:FindAbilityByName("savechar"):ApplyDataDrivenModifier(herocontrol, hero, buff, {Duration = -1})
          local total_stats = amount+sum
          if total_stats > 35 and buff == "modifier_mythic_spellres" then total_stats = 35 end
          if total_stats > 10 and buff == "modifier_mythic_minusspellres" then total_stats = 10 end
          hero:SetModifierStackCount(buff, herocontrol:GetAbilityByIndex(1), total_stats)
      end
      if buff == "" then --new effects that dont use a buff use this system
          local attributeCode = GetAttributeCodeByAttributeName(stat)
          if attributeCode then hero[attributeCode] = (hero[attributeCode] or 0) + amount end
      end
  * [RPG/combat] WoW-style class-resource overlay (energy/rage/combo-points) built by hijacking the mana pool + a parallel combo-point counter: A class-resource framework that overloads the hero's native mana bar to act as Energy/Rage for non-mana classes (IsManaHero gate), driven by a centralized event-DSL. GetMaxEnergy/GetEnergyBonusFactor/AddEnergy compute a per-hero resource cap and generation-rate by summing dozens of additive item/talent/modifier contributions, with declarative event flags controlling behavior: event.energypercent (treat amount as % of max), event.classfactor (halve for a given resourcesystem id), event.deathknight (double under a modifier), event.degeneration (drain), event.cap (per-cast clamp), and a multiplicative 'modifier_mythic_resource' stack-count scaler. Layered on top is an independent combo-point system (AddComboPoints/SubComboPoints/MaxComboPoints): points live on hero.ComboPoints with per-hero maxima (Dazzle 4 vs default 3), are mirrored onto a modifier_combopoint stack count for the HUD, and finishers spend them. Builder-spender combat is then gated through ConsumeComboPoints/ConsumeSouls inside DamageUnit, with scaling_factor multipliers like event.feralcombopointbased (damage = base * hero.FeralFinisher) so a single finisher's damage scales with accumulated points/souls. Together this is a reusable 'class fantasy resource' kit (rogue energy, warrior rage, warlock souls, druid combo points) implemented without a new resource bar by reusing mana + stack-count-backed counters. (scripts/vscripts/ragesystem.lua)
      function AddComboPoints( event )
        local hero = event.caster or event.attacker
        hero.ComboPoints = (hero.ComboPoints or 0) + event.amount
        local maxCP = 3
        if hero:GetName() == "npc_dota_hero_dazzle" then maxCP = 4 end
        if hero.ComboPoints > maxCP then hero.ComboPoints = maxCP end
        hero:SetModifierStackCount("modifier_combopoint", event.ability, hero.ComboPoints)
        AddCPEffect(event)
      end
      ...
      if hero:HasModifier("modifier_mythic_resource") then
        energygain = energygain * (1 + hero:GetModifierStackCount("modifier_mythic_resource", nil) / 100)
      end

## Dota 2 Horde Mode UPDATED (2087457643)
  * [cosmetics / particles / data-driven ability VFX] Cosmetic-driven ability re-skinning (equipped wearable rewrites a custom ability's icon, particles, and weapon model): An in-game 'armory' lets players equip real Dota Immortal/Arcana wearables onto custom heroes, and the equip event ALSO re-skins the hero's custom Lua ability to match. Three KV maps drive it: sAbilityNameToIcon (ability -> wearable-name -> ability-icon texture), sIconToEffectPath (icon key -> ordered list of vpcf/sound paths), and CustomTextureAbility (ability -> {model, custom, default}). On equip, Battlepass:CheckAbilityIcon writes the chosen texture into the 'player_table' net-table keyed by ability name (so Panorama repaints the ability button via 'update_cosmetic_icon'), then calls a per-ability hook ability:CosmeticChanged(). Each custom ability overrides GetAbilityTextureName() -> GetCustomTexture() for the server-side icon, and CosmeticChanged() reads the net-table and repoints its own self.pSpear/self.pImpact particle paths from sIconToEffectPath. Net effect: one cosmetic purchase changes a fully-custom Lua ability's projectile/impact particles, ability icon, AND attached weapon model in lockstep. This icon/particle/model triple-binding to equipped cosmetics is not a pattern in the KB. (C:\Users\work\.dota2-workshop-mcp\reflib\items\2087457643\files\scripts\vscripts\internal\battlepass\armory_cosmetics.lua (data tables) + scripts\vscripts\internal\battlepass.lua (CheckAbilityIcon, lines 358-378) + scripts\vscripts\heroes\hero_mars\mars_horde_spear.lua (consumer, lines 39-51))
      function mars_horde_spear:CosmeticChanged()
          local CustomEffects = CustomNetTables:GetTableValue("player_table", self:GetAbilityName())
          if CustomEffects and CustomEffects.texture then
              self.pSpear = sIconToEffectPath[CustomEffects.texture][1]
              self.pImpact = sIconToEffectPath[CustomEffects.texture][2]
          end
      end
  * [endless/roguelite scaling, map-trigger integration] Endless-mode difficulty escalation by infusing random abilities into enemy creeps over time (Hammer-trigger driven): An endless 'Bonus Round Skills' system that scales enemy power not by raising stats but by granting creeps random extra abilities, escalating by elapsed minute. A 1s repeating timer indexes timelist.kv by floor(elapsedSeconds/60) to update four global knobs (count of normal skills, ultra skills, and the level to set each). Creeps are upgraded via a Hammer map trigger: the map's trigger_dota OnTrigger output calls the global trigger_Upgrade(trigger), which reads trigger.activator and (guarding with unit.bHasBeenBoosted so each creep is boosted once) pulls random ability keys from KV pools ('UltraSkills', plus merged 'nhuSkills'+'heroSkills' via a custom two-array random picker), AddAbility's them, clamps SetLevel to each ability's max, and auto-toggles/auto-casts toggleable ones. Reusable pattern: time-bucketed KV difficulty table + walk-through-zone map trigger that mutates the enemy's ability loadout, rather than HP/damage multipliers. (C:\Users\work\.dota2-workshop-mcp\reflib\items\2087457643\files\scripts\vscripts\hoardbrs\init.lua)
      function trigger_Upgrade(trigger)
          local unit = trigger.activator
          if unit.bHasBeenBoosted then return end
          unit.bHasBeenBoosted = true
          BonusRoundSkills:ApplyAbilities(unit, skillSet)
      end
  * [co-op anti-grief / order & modifier filters] Anti-grief layer: disable-help-aware order/modifier filtering for displacement spells + automatic item-hogging drop: Two distinct co-op anti-grief mechanisms. (1) Displacement/control griefing prevention that respects Dota's native 'disable help' setting for CUSTOM abilities: an OrderFilter blocks targeted casts (and AoE casts like Furion sprout via a radius scan) of a curated vHelpDisabledAbilityList against allies who set IsDisableHelpSetForPlayerID, sending a native 'dota_hud_error_target_has_disable_help'; a complementary OnModifierGained catches modifiers in vHelpDisabledModifierList (Tiny Toss, Earth Spirit grip/petrify) applied to a protected ally and refunds the caster by calling ability:EndCooldown() + ability:RefundManaCost() then Destroy()ing the modifier - undoing griefy displacement after the fact. (2) Item-hogging auto-drop: SetAntiItemHogging tags an item with a per-playerID PreviousOwners counter incremented every second it sits in a player's inventory; after 120 ticks DropHoggedItem force-drops it to a central stash position with teleport VFX/sound, preventing shared-loot hoarding. (C:\Users\work\.dota2-workshop-mcp\reflib\items\2087457643\files\scripts\vscripts\internal\anti_grief.lua)
      if vHelpDisabledModifierList[sName] and hMod:GetCaster() then
          ...
          if PlayerResource:IsDisableHelpSetForPlayerID(hParent:GetPlayerOwnerID(), hCaster:GetPlayerOwnerID()) then
              if hMod:GetAbility() then
                  hMod:GetAbility():EndCooldown()
                  hMod:GetAbility():RefundManaCost()
              end
              ...
              hMod:Destroy()
          end
      end
  * [shared-loot logistics / game-feel] Uncollected loot auto-teleports to the base stash after an ownership timeout (LaunchLoot-as-teleport): Boss-loot logistics so co-op drops are never lost or stranded on a defense map. Items are launched to the world with LaunchLoot; a 25s timer then checks hItem:GetOwner() - if still unclaimed, it re-LaunchLoots the SAME physical item with a one-tick duration (1/144) to instantly relocate it to the fountain stash position, with neutral-item teleport particle + 'NeutralItem.TeleportToStash' sound. The trick of using LaunchLoot with a near-zero flight time as a teleport for an already-spawned dropped item (rather than destroying/recreating) is non-obvious, and pairs with the anti-grief item-hogging drop to form a coherent 'unclaimed/hogged loot funnels back to base' system. Drop count also uses RollPseudoRandom seeded on the fort entity for a bonus drop. (C:\Users\work\.dota2-workshop-mcp\reflib\items\2087457643\files\scripts\vscripts\bosses\revive_boss.lua (DropRewards, lines 72-114))
      Timers:CreateTimer(25, function()
          if hItem:GetOwner() then return end
          local vFinalPosition = vFountainPosition+RandomVector(flDistance)
          ... EmitGlobalSound("NeutralItem.TeleportToStash")
          hItem:LaunchLoot(false, 0, 1/144, vFinalPosition, nil)
      end)
