# Hijacking & Extending Dota’s Native HUD

This reference covers a single, high-leverage tactic used across shipping Dota 2 custom games: instead of disabling the stock HUD and rebuilding everything in custom Panorama, you reach **into Valve's own shipping HUD panels** and re-skin, re-bind, and augment them. The same approach lets you read engine-computed values (real ping, real keybinds) that are never exposed to custom games through any documented API.

Everything here is distilled from decompiled, shipping Workshop games. Each technique names its source game. **None of these panels are part of the documented Panorama API** — they are internal Valve panel ids that can be renamed or restructured in any Dota patch. Read the **Stability / Pitfalls** section at the end before relying on any of it.

---

## 1. Finding the native HUD root

Every custom Panorama panel is mounted somewhere *below* the root `Hud` panel. To reach native HUD elements you walk up `GetParent()` to the root, then `FindChildTraverse(id)` down to the element you want by its Valve-assigned id.

### Walk to the root (Angel Arena Black Star)

The canonical helper (`arena_util.js`) walks up until `GetParent()` returns `null`:

```js
// Angel Arena Black Star — arena_util.js
function GetDotaHud() {
    var p = $.GetContextPanel();
    while (true) {
        var parent = p.GetParent();
        if (parent == null) return p;   // reached the root
        else p = parent;
    }
}
var hud = GetDotaHud();

function FindDotaHudElement(id) {
    return hud.FindChildTraverse(id);
}
```

`FindChildTraverse` is a deep (recursive) search by id, so you do not need to know the exact nesting — only the leaf id. This `GetDotaHud()` + `FindDotaHudElement()` pair is the workhorse for every other technique in this document.

### Walk to a named panel (Petri Reborn)

Petri Reborn's `shop.js` does the same thing but stops at the panel literally named `"Hud"` instead of going all the way to `null`:

```js
// Petri Reborn — shop.js, Hack()
var parent = $.GetContextPanel().GetParent();
while (parent.id != "Hud") parent = parent.GetParent();
// `parent` is now the root Hud panel
var radar = parent.FindChildTraverse("RadarButton");
```

### GameUI.Utils.FindDotaHudElement (IMBA)

Some larger projects (Dota IMBA) install a project-wide helper on `GameUI.Utils` and call `GameUI.Utils.FindDotaHudElement("center_block")` everywhere. It is the same root-traversal idea wrapped in a global so any panel script can use it without re-implementing `GetDotaHud()`:

```js
// Dota IMBA — util.js
const center_block = GameUI.Utils.FindDotaHudElement("center_block");
if (center_block) {
    const unitname = center_block.FindChildTraverse("UnitNameLabel");
    if (unitname) unitname.html = true;     // enable rich-text on the native unit-name label
}
```

### Useful native ids seen in the corpus

These ids are referenced by the shipping games studied here. Treat them as a starting map, not a guarantee:

```
Hud, HUDElements, CustomUIRoot
minimap_block, HUDSkinMinimap
ShopButton (child: GoldLabel, BuybackHeader), shop, QuickBuyRows, stash, quickbuy
topbar, combat_events, RoshanTimerContainer
PortraitContainer, PortraitBacker, PortraitBackerColor, UnitNameLabel
abilities (children Ability0..N -> AbilityButton), center_block, center_with_stats, lower_hud
inventory_tpscroll_container, inventory_neutral_level_up, InventoryContainer (.InventoryItem)
Buff0..Buff29 (child: StackCount), buffs, debuffs, AghsStatusContainer
RadarButton (children: RadarIcon, CooldownCover)
StatBranch, level_stats_frame (child: LevelUpTab), xp (children: LevelBackground, CircularXPProgress, XPProgress)
stats_tooltip_region, DOTAHUDDamageArmorTooltip
ChatLinesPanel, ChatLinesWrapper, ChatEmoticonButton
HUDElements > NetGraph (RightColumn_1 > NetGraph_FPS, RightColumn_2 > NetGraph_PING)
Tooltips (children: DOTAAbilityTooltip, DOTAHUDAghsStatusTooltip, DOTAHUDInnateTooltip, DOTAHUDInnateStatusTooltip)
```

---

## 2. Repurposing built-in controls

Once you can reach a native button, you can re-skin it and **swap its click handler** so a stock Dota control drives your custom game.

### Hijacking the Radar / Scan button (Petri Reborn)

Petri Reborn's `Hack()` grabs the native scan (`RadarButton`), overrides its icon, hides its cooldown cover, and rebinds `onactivate` to cast a custom ability on the local hero. This turns a shipping Dota button into a custom-game button at zero UI cost:

```js
// Petri Reborn — shop.js, Hack()
var radar = parent.FindChildTraverse("RadarButton");

radar.FindChildTraverse("RadarIcon").style.backgroundImage =
    'url("s2r://panorama/images/hud/reborn/icon_scan_on_psd.vtex");';
radar.FindChildTraverse("CooldownCover").visible = false;

radar.FindChildTraverse("RadarIcon").SetPanelEvent("onactivate", function () {
    var queryUnit = Players.GetPlayerHeroEntityIndex(Players.GetLocalPlayer());
    for (var i = 0; i < 23; ++i) {
        var ability = Entities.GetAbility(queryUnit, i);
        if (ability == -1) continue;
        if (Abilities.GetAbilityName(ability) == "petri_exploration_tower_explore_world") {
            Abilities.ExecuteAbility(ability, queryUnit, false);
            return;
        }
        $.DispatchEvent('DropInputFocus', radar);
    }
});

// And give the repurposed button a matching native tooltip:
radar.SetPanelEvent('onmouseover', function () {
    var queryUnit = Players.GetPlayerHeroEntityIndex(Players.GetLocalPlayer());
    if (Entities.GetTeamNumber(queryUnit) == 3) {
        $.DispatchEvent('DOTAShowAbilityTooltip', radar, "petri_exploration_tower_explore_world");
    }
});
radar.SetPanelEvent('onmouseout', function () {
    $.DispatchEvent('DOTAHideAbilityTooltip');
    $.DispatchEvent('DOTAHideTitleTextTooltip');
});
```

### The ClearPanelEvent → SetPanelEvent dance (Angel Arena Black Star)

Native buttons already have `onactivate`/`onmouseover`/`onmouseout` handlers wired by Valve. **Just calling `SetPanelEvent` does not always replace them cleanly** — the safe pattern is to `ClearPanelEvent` first, then set yours. Angel Arena does exactly this to make the stock Shop button and Talent (StatBranch / LevelUpTab) controls drive its own handlers:

```js
// Angel Arena Black Star — custom_hud.js, HookPanoramaPanels()
var shopbtn = FindDotaHudElement('ShopButton');
shopbtn.FindChildTraverse('BuybackHeader').visible = false;
shopbtn.ClearPanelEvent('onactivate');
shopbtn.ClearPanelEvent('onmouseover');
shopbtn.ClearPanelEvent('onmouseout');
shopbtn.SetPanelEvent('onactivate', function () {
    if (GameUI.IsAltDown()) {
        GameEvents.SendCustomGameEventToServer('custom_chat_send_message', {
            GoldUnit: Players.GetLocalPlayerPortraitUnit()
        });
    } else {
        CustomHooks.panorama_shop_open_close.call();
    }
});

var StatsLevelUpTab = FindDotaHudElement('level_stats_frame').FindChildTraverse('LevelUpTab');
StatsLevelUpTab.ClearPanelEvent('onmouseover');
StatsLevelUpTab.ClearPanelEvent('onmouseout');
StatsLevelUpTab.ClearPanelEvent('onactivate');
StatsLevelUpTab.SetPanelEvent('onactivate', function () {
    CustomHooks.custom_talents_toggle_tree.call();
});
```

### Hiding native panels you don't want

Both games just flip `visible` / `enabled` / `style.visibility` on native elements:

```js
// Angel Arena Black Star — custom_hud.js, HookPanoramaPanels()
FindDotaHudElement('QuickBuyRows').visible = false;
FindDotaHudElement('shop').visible = false;
FindDotaHudElement('HUDSkinMinimap').visible = false;
FindDotaHudElement('combat_events').visible = false;
FindDotaHudElement('topbar').visible = false;

// Petri Reborn — shop.js, Hack()
parent.FindChildTraverse("AghsStatusContainer").visible = false;
parent.FindChildTraverse("inventory_tpscroll_container").visible = false;
parent.FindChildTraverse("RoshanTimerContainer").visible = false;
// StatBranch: belt-and-suspenders to keep it dead
var sb = parent.FindChildTraverse("StatBranch");
sb.style.visibility = "collapse;";
sb.enabled = false;
sb.hittest = false;
sb.hittestchildren = false;
```

### Restyling the native buff bar (Petri Reborn)

`Buff0`..`Buff29` are the stock buff/debuff icon slots; their `StackCount` child is the number label. Petri loops them to resize and re-font the native icons:

```js
// Petri Reborn — shop.js, Hack()
for (var i = 0; i < 30; i++) {
    var buff = parent.FindChildTraverse("Buff" + i);
    if (buff != null) {
        buff.style.width = "50px";
        buff.style.height = "50px";
        var label = buff.FindChildTraverse("StackCount");
        label.style.fontSize = "16px";
        label.style.fontFamily = "Arial";
        label.style.textAlign = "center";
        label.style.width = "70%";
        label.style.height = "70%";
    }
}
```

### Re-running on a delay so it survives HUD rebuilds

The native HUD rebuilds parts of itself (e.g. `level_stats_frame` resets its `CanLevelStats` class every frame; the abilities row gets recreated). All these games re-apply their changes on a self-rescheduling timer rather than once at load:

```js
// Petri Reborn — shop.js: re-decorate chat icons every 0.1s forever
var hide = function () {
    /* ... mutate native panels ... */
    $.Schedule(0.1, function () { hide(); });
};
hide();

// Angel Arena Black Star — custom_hud.js
function AutoUpdatePanoramaHUD() {
    $.Schedule(0.2, AutoUpdatePanoramaHUD);
    UpdatePanoramaHUD();
}
```

Inside `UpdatePanoramaHUD`, Angel Arena only re-hooks the ability buttons when the child count changes, to avoid re-binding every tick:

```js
// Angel Arena Black Star — custom_hud.js
var abilities = FindDotaHudElement('abilities');
if (HookedAbilityPanelsCount !== abilities.GetChildCount()) {
    HookedAbilityPanelsCount = abilities.GetChildCount();
    _.each(abilities.Children(), function (child, index) {
        var btn = child.FindChildTraverse('AbilityButton');
        btn.SetPanelEvent('onactivate', function () {
            if (GameUI.IsAltDown()) { /* ...alt-click broadcast... */ }
        });
    });
}
```

### Pinning custom overlays to live native anchors

Because the native HUD scales with resolution, you cannot hardcode positions. Angel Arena reads the live geometry of native panels every frame and positions custom panels relative to them:

```js
// Angel Arena Black Star — custom_hud.js, UpdatePanoramaHUD()
var sw = Game.GetScreenWidth(), sh = Game.GetScreenHeight();

// size a custom minimap holder to match the native minimap_block exactly
var minimap = FindDotaHudElement('minimap_block');
$('#DynamicMinimapRoot').style.height = (minimap.contentheight / sh * 100) + '%';
$('#DynamicMinimapRoot').style.width  = (minimap.contentwidth  / sw * 100) + '%';

// anchor a custom modifier list onto the live portrait
var pcs = FindDotaHudElement('PortraitContainer').GetPositionWithinWindow();
if (pcs != null && !isNaN(pcs.x) && !isNaN(pcs.y)) {
    $('#CustomModifiersList').style.position =
        (pcs.x / sw * 100) + '% ' + (pcs.y / sh * 100) + '% 0';
}
```

`GetPositionWithinWindow()` returns `{x, y}` in pixels; `actuallayoutwidth/height`, `contentwidth/height` give measured dimensions. Convert to `%` against `Game.GetScreenWidth()/GetScreenHeight()` so it tracks at any resolution.

---

## 3. Reusing the HeroSelection / GameSetup slots for arbitrary UI

`CustomUIElement type="..."` in `custom_ui_manifest.xml` lets you inject a layout into a *named lifecycle slot*. **Battle of Characters** repurposes the `HeroSelection` slot — which normally hosts a hero-pick screen — to render an in-arena duel-lobby / voting UI instead:

```xml
<!-- Battle of Characters — custom_ui_manifest.xml -->
<root>
    <script>
        GameUI.SetDefaultUIEnabled( DotaDefaultUIElement_t.DOTA_DEFAULT_UI_SHOP_SUGGESTEDITEMS, false );
    </script>
    <Panel>
        <CustomUIElement type="Hud"           layoutfile="file://{resources}/layout/custom_game/overthrow_item_notification.xml" />
        <CustomUIElement type="GameSetup"     layoutfile="file://{resources}/layout/custom_game/team_select.xml" />
        <CustomUIElement type="EndScreen"     layoutfile="file://{resources}/layout/custom_game/multiteam_end_screen.xml" />
        <CustomUIElement type="HeroSelection" layoutfile="file://{resources}/layout/custom_game/solo_duel.xml" />
    </Panel>
</root>
```

Host-only controls inside that layout are gated client-side by reading the local player's host flag and toggling a class; votes/locks round-trip to the server:

```js
// Battle of Characters — solo_duel host gating
var playerInfo = Game.GetLocalPlayerInfo();   // or Game.GetPlayerInfo(Players.GetLocalPlayer())
$.GetContextPanel().SetHasClass("player_has_host_privileges", playerInfo.player_has_host_privileges);
GameEvents.SendCustomGameEventToServer("host_lock_option", {});
```

```css
/* Host-only buttons hidden unless the root has the gate class */
.HostOnlyButton { visibility: collapse; }
.player_has_host_privileges .HostOnlyButton { visibility: visible; }
```

---

## 4. Injecting into native ability / Aghanim's / innate tooltips

The most powerful and most fragile technique. **OVERTHROW 3.0**'s `tooltip_extender.js` does not build custom tooltips — it listens for the engine's own tooltip events, reaches into the live tooltip DOM under `FindDotaHudElement("Tooltips")`, inserts extra panels, then forces a re-layout.

### Listen for the engine's own tooltip events

```js
// OVERTHROW 3.0 — tooltip_extender.js
function RegisterDefaultTooltip(event_name, points, force_local_hero) {
    $.RegisterForUnhandledEvent(event_name, (...args) => {
        const panel = args[points[0]];
        let ability_name = args[points[1]];
        const unit_entity_id = args[points[2]];
        const item_slot = args[points[3]];
        if (item_slot != undefined && unit_entity_id != undefined) {
            const item = Entities.GetItemInSlot(unit_entity_id, item_slot);
            ability_name = Abilities.GetAbilityName(item);
        }
        if (!ability_name) return;
        OnAbilityTooltip(event_name, panel, ability_name, force_local_hero, ...args);
    });
}

RegisterDefaultTooltip("DOTAShowAbilityTooltip", [0, 1]);
RegisterDefaultTooltip("DOTAShowAbilityTooltipForEntityIndex", [0, 1]);
RegisterDefaultTooltip("DOTAShowAbilityTooltipForHero", [0, 1]);
RegisterDefaultTooltip("DOTAShowAbilityShopItemTooltip", [0, 1], true);
RegisterDefaultTooltip("DOTAShowDroppedItemTooltip", [0, 3], true);
RegisterDefaultTooltip("DOTAShowAbilityInventoryItemTooltip", [0, undefined, 1, 2]);
$.RegisterForUnhandledEvent("DOTAHUDShowAghsStatusTooltip", OnAghsTooltip);
RegisterNonPregenTooltip("DOTAShowInnateTooltip", OnInnateTooltip, "Innate");
```

### Reach into the live tooltip and add panels

```js
// OVERTHROW 3.0 — tooltip_extender.js, InitStaticTooltipExtender()
const tooltip_manager = FindDotaHudElement("Tooltips");
const ability_tooltip = tooltip_manager.FindChildTraverse("DOTAAbilityTooltip");
const default_scepter = ability_tooltip.FindChildTraverse("ScepterUpgradeDescription");
const default_shard   = ability_tooltip.FindChildTraverse("ShardUpgradeDescription");

// Insert a custom DOTAAghsDescription panel right after the native one:
const core_details = ability_tooltip.FindChildTraverse("AbilityCoreDetails");
const container = $.CreatePanel("DOTAAghsDescription", core_details, "CustomAghsDescription_Scepter");
core_details.MoveChildAfter(container, default_scepter);
default_scepter.visible = false;
```

### The `te_lock` re-dispatch trick

After you make the tooltip taller, the engine still thinks it's the old size. The load-bearing trick: **re-dispatch the same tooltip event** so the engine re-lays-out the now-bigger tooltip, using a one-shot `panel.te_lock` flag so the re-dispatch doesn't recurse forever:

```js
// OVERTHROW 3.0 — tooltip_extender.js, UpdateTooltip()
function UpdateTooltip(event_name, panel, ability_name, force_local_hero, ...event_args) {
    if (panel.te_lock) {            // this call is OUR re-dispatch — consume it and stop
        panel.te_lock = false;
        return;
    }
    /* ... mutate the tooltip's children ... */
    panel.te_lock = true;
    if (panel.BHasHoverStyle()) $.DispatchEvent(event_name, ...event_args);   // force relayout
}
```

For the Aghanim's status tooltip the same flow re-fires `DOTAHUDShowAghsStatusTooltip`, then fixes the side-effect of a taller tooltip clipping off-screen by measuring against `Game.GetScreenHeight()` and applying a negative `marginTop`:

```js
// OVERTHROW 3.0 — tooltip_extender.js, OnAghsTooltip()
panel.te_lock = true;
$.DispatchEvent("DOTAHUDShowAghsStatusTooltip", panel, -1, hero_id);
$.Schedule(0, () => {
    const pos = aghs_tooltips.GetPositionWithinWindow();
    const bottom_space = Game.GetScreenHeight() - aghs_tooltips.actuallayoutheight - pos.y;
    const extra_space = (100) - bottom_space;
    if (extra_space > 0) aghs_tooltips.style.marginTop = `-${extra_space}px`;
});
```

### Injecting custom numbers into the damage/armor tooltip (Angel Arena Black Star)

A lighter variant: dispatch the native event to *show* Valve's damage/armor tooltip, then `SetDialogVariable` on the live `DOTAHUDDamageArmorTooltip` panel to overwrite the numbers with your custom BAT / attack-speed / stat-gain values:

```js
// Angel Arena Black Star — custom_hud.js
var stats_region = FindDotaHudElement('stats_tooltip_region');
stats_region.SetPanelEvent('onmouseover', function () {
    $.DispatchEvent('DOTAHUDShowDamageArmorTooltip', stats_region);
    var t = FindDotaHudElement('DOTAHUDDamageArmorTooltip');
    if (t != null) {
        t.SetDialogVariable('seconds_per_attack', '(' + secondsPerAttack.toFixed(2) + 's)');
        t.SetDialogVariableInt('base_attack_speed', Math.round(attackSpeedTooltip));
        t.SetDialogVariable('agility_armor', idealArmor.toFixed(1));
        t.SetDialogVariable('strength_per_level', strGain.toFixed(1));
    }
});
stats_region.SetPanelEvent('onmouseout', function () {
    $.DispatchEvent('DOTAHUDHideDamageArmorTooltip');
});
```

### Adding a tooltip to a custom DOTAAbilityImage (Angel Arena Black Star)

When you create your own ability icon you can still summon Valve's native title/text tooltip via the dispatch events:

```js
// Angel Arena Black Star — custom_hud.js
var panel = $.CreatePanel('DOTAAbilityImage', CustomModifiersList, buffName);
panel.abilityname = Buffs.GetTexture(unit, buffSerial);
panel.SetPanelEvent('onmouseover', function () {
    $.DispatchEvent('DOTAShowTitleTextTooltip', panel,
        $.Localize('DOTA_Tooltip_' + buffName),
        $.Localize('hud_modifier_click_to_remove'));
});
panel.SetPanelEvent('onmouseout', function () {
    $.DispatchEvent('DOTAHideTitleTextTooltip', panel);
});
```

---

## 5. The native red error popup (`dota_hud_error_message`)

You don't need to build any UI to surface a server-driven message in the **same red action-error banner** Dota uses for "can't cast there." Just fire the engine's client-side event `dota_hud_error_message` with `reason: 80` (the reason code that maps to a free-form `message` string) and `splitscreenplayer: 0`.

**OVERTHROW 3.0** — `display_custom_error.js`:

```js
// OVERTHROW 3.0 — display_custom_error.js
function DisplayCustomError(event) {
    if (event.enable == 0) return;
    GameEvents.SendEventClientSide("dota_hud_error_message", {
        splitscreenplayer: 0,
        reason: 80,
        message: event.message,
    });
}
```

With `##key##` token interpolation over a localized template:

```js
// OVERTHROW 3.0 — display_custom_error.js
function DisplayCustomErrorWithValue(event) {
    let base_message = $.Localize(event.message);
    Object.entries(event.values).forEach(([key, value]) => {
        base_message = base_message.replace(`##${key}##`, $.Localize(value));
    });
    GameEvents.SendEventClientSide("dota_hud_error_message", {
        splitscreenplayer: 0,
        reason: 80,
        message: base_message,
    });
}
```

Server side, push the message down with a custom game event; the client subscribes and re-emits the native event. `reason: 80` is the relevant free-form code here — other reason codes map to specific hardcoded engine strings, so use 80 when you want your own text.

---

## 6. Drag-drop inventory + right-click context menus

**Battle of Characters** replaces the default inventory entirely and wires up Panorama's native drag-and-drop contract plus `DOTAContextMenuScript` right-click menus. This is the full `inventory_item.js`, condensed.

### Native drag-and-drop callback contract

A draggable slot registers the five `Drag*` events. On `DragStart` you spawn a temporary `DOTAItemImage` as the drag visual and stash state in `panel.data()`:

```js
// Battle of Characters — inventory_item.js
(function () {
    $.RegisterEventHandler('DragEnter', $.GetContextPanel(), OnDragEnter);
    $.RegisterEventHandler('DragDrop',  $.GetContextPanel(), OnDragDrop);
    $.RegisterEventHandler('DragLeave', $.GetContextPanel(), OnDragLeave);
    $.RegisterEventHandler('DragStart', $.GetContextPanel(), OnDragStart);
    $.RegisterEventHandler('DragEnd',   $.GetContextPanel(), OnDragEnd);
})();
// NOTE: the panel also needs draggable="true" in XML, or panel.SetDraggable(true).

function OnDragStart(panelId, dragCallbacks) {
    if (m_Item == -1) return true;
    var displayPanel = $.CreatePanel("DOTAItemImage", $.GetContextPanel(), "dragImage");
    displayPanel.itemname = Abilities.GetAbilityName(m_Item);
    displayPanel.contextEntityIndex = m_Item;
    displayPanel.data().m_DragItem = m_Item;
    displayPanel.data().m_DragCompleted = false;
    dragCallbacks.displayPanel = displayPanel;   // engine drags this around
    dragCallbacks.offsetX = 0;
    dragCallbacks.offsetY = 0;
    $.GetContextPanel().AddClass("dragging_from");
    return true;
}
```

A drop on **another slot** issues a real `DOTA_UNIT_ORDER_MOVE_ITEM` order to swap; a drop on **empty world** triggers `Game.DropItemAtCursor`:

```js
// Battle of Characters — inventory_item.js
function OnDragDrop(panelId, draggedPanel) {
    var draggedItem = draggedPanel.data().m_DragItem;
    if (draggedItem === null) return true;
    draggedPanel.data().m_DragCompleted = true;     // a slot caught it -> don't drop on world
    if (draggedItem == m_Item) return true;         // dropped on itself
    var moveItemOrder = {
        OrderType: dotaunitorder_t.DOTA_UNIT_ORDER_MOVE_ITEM,
        TargetIndex: m_ItemSlot,
        AbilityIndex: draggedItem
    };
    Game.PrepareUnitOrders(moveItemOrder);
    return true;
}

function OnDragEnd(panelId, draggedPanel) {
    if (!draggedPanel.data().m_DragCompleted) {
        Game.DropItemAtCursor(m_QueryUnit, m_Item);  // dropped on the world
    }
    draggedPanel.DeleteAsync(0);                       // kill the temp drag visual
    $.GetContextPanel().RemoveClass("dragging_from");
    return true;
}

function OnDragEnter(a, draggedPanel) {
    var draggedItem = draggedPanel.data().m_DragItem;
    if (draggedItem === null || draggedItem == m_Item) return true;
    $.GetContextPanel().AddClass("potential_drop_target");   // highlight
    return true;
}
function OnDragLeave(panelId, draggedPanel) {
    $.GetContextPanel().RemoveClass("potential_drop_target");
    return true;
}
```

### Right-click → `DOTAContextMenuScript` with capability-gated classes

On right-click, create a `DOTAContextMenuScript`, query item capabilities, toggle a CSS class per capability, and load the menu layout into the menu's contents panel. The CSS hides buttons whose class is absent:

```js
// Battle of Characters — inventory_item.js, RightClickItem()
var bSlotInStash  = IsInStash();
var bControllable = Entities.IsControllableByPlayer(m_QueryUnit, Game.GetLocalPlayerID());
var bSellable     = Items.IsSellable(m_Item) && Items.CanBeSoldByLocalPlayer(m_Item);
var bDisassemble  = Items.IsDisassemblable(m_Item) && bControllable && !bSlotInStash;
var bAlertable    = Items.IsAlertableItem(m_Item);
var bShowInShop   = Items.IsPurchasable(m_Item);
var bDropFromStash= bSlotInStash && bControllable;

var contextMenu = $.CreatePanel("DOTAContextMenuScript", $.GetContextPanel(), "");
contextMenu.AddClass("ContextMenu_NoArrow");
contextMenu.AddClass("ContextMenu_NoBorder");
contextMenu.GetContentsPanel().data().Item = m_Item;
contextMenu.GetContentsPanel().SetHasClass("bSellable",     bSellable);
contextMenu.GetContentsPanel().SetHasClass("bDisassemble",  bDisassemble);
contextMenu.GetContentsPanel().SetHasClass("bShowInShop",   bShowInShop);
contextMenu.GetContentsPanel().SetHasClass("bDropFromStash",bDropFromStash);
contextMenu.GetContentsPanel().SetHasClass("bAlertable",    bAlertable);
contextMenu.GetContentsPanel().BLoadLayout(
    "file://{resources}/layout/custom_game/inventory_context_menu.xml", false, false);
```

The menu layout (`inventory_context_menu.xml`):

```xml
<!-- Battle of Characters — inventory_context_menu.xml -->
<root>
    <styles>
        <include src="s2r://panorama/styles/dotastyles.vcss_c" />
        <include src="s2r://panorama/styles/custom_game/inventory.vcss_c" />
    </styles>
    <scripts>
        <include src="s2r://panorama/scripts/custom_game/inventory_context_menu.vjs_c" />
    </scripts>
    <Panel class="ItemMenu">
        <Button class="ItemMenuButton" id="ShowInShop" onmouseactivate="OnShowInShop()"><Label text="Show In Shop" /></Button>
        <Button class="ItemMenuButton" id="Sell"          onactivate="OnSell()"><Label text="Sell" /></Button>
        <Button class="ItemMenuButton" id="Disassemble"   onactivate="OnDisassemble()"><Label text="Disassemble" /></Button>
        <Button class="ItemMenuButton" id="DropFromStash" onactivate="OnDropFromStash()"><Label text="Drop From Stash" /></Button>
        <Button class="ItemMenuButton" id="Alert"         onactivate="OnAlert()"><Label text="Alert" /></Button>
        <Button class="ItemMenuButton" id="MoveToStash"   onactivate="OnMoveToStash()"><Label text="Move To Stash" /></Button>
    </Panel>
</root>
```

The menu script calls the documented `Items.*` actions and dismisses via `DismissAllContextMenus`:

```js
// Battle of Characters — inventory_context_menu.js
function DismissMenu() { $.DispatchEvent("DismissAllContextMenus"); }
function OnSell()          { Items.LocalPlayerSellItem($.GetContextPanel().data().Item); DismissMenu(); }
function OnDisassemble()   { Items.LocalPlayerDisassembleItem($.GetContextPanel().data().Item); DismissMenu(); }
function OnDropFromStash() { Items.LocalPlayerDropItemFromStash($.GetContextPanel().data().Item); DismissMenu(); }
function OnMoveToStash()   { Items.LocalPlayerMoveItemToStash($.GetContextPanel().data().Item); DismissMenu(); }
function OnAlert()         { Items.LocalPlayerItemAlertAllies($.GetContextPanel().data().Item); DismissMenu(); }
function OnShowInShop() {
    var itemName = Abilities.GetAbilityName($.GetContextPanel().data().Item);
    GameEvents.SendEventClientSide("dota_link_clicked",
        { "link": ("dota.item." + itemName), "shop": 0, "recipe": 0 });
    DismissMenu();
}
```

Corresponding CSS gate (each button hidden unless its capability class is present on the menu root):

```css
.ItemMenu #Sell          { visibility: collapse; }
.ItemMenu.bSellable #Sell           { visibility: visible; }
.ItemMenu #Disassemble   { visibility: collapse; }
.ItemMenu.bDisassemble #Disassemble { visibility: visible; }
/* ...same pattern for bShowInShop, bDropFromStash, bAlertable... */
```

---

## 7. Custom right-click context menus on arbitrary panels

When you don't need item capabilities, **Petri Reborn** gives a clean recipe for a native-looking right-click menu on any panel (here, vote-kick on scoreboard rows): create the engine's `ContextMenuScript`, **wipe Valve's default contents**, and `BLoadLayout` your own menu in. Per-row data rides on a panel attribute:

```js
// Petri Reborn — simple_scoreboard_updater.js, ShowContextMenu()
function ShowContextMenu() {
    var playerID = $.GetContextPanel().GetAttributeInt("player_id", -1);
    if (GameUI.CustomUIConfig().IsAllowedToKick(playerID) == true) {
        var contextMenu = $.CreatePanel("ContextMenuScript", $.GetContextPanel(), "");
        contextMenu.SetAcceptsFocus(false);

        var menu = contextMenu.GetContentsPanel().GetParent();
        $.DispatchEvent('DropInputFocus', menu);
        menu.RemoveAndDeleteChildren();              // wipe Valve's default menu

        var content = $.CreatePanel("Panel", menu, "");
        content.SetAcceptsFocus(false);
        content.SetAttributeInt("PlayerID", playerID);   // pass row data via attribute
        content.BLoadLayout("file://{resources}/layout/custom_game/scoreboard/scoreboard_context_menu.xml", false, false);
        content.AddClass("show_menu");

        $.DispatchEvent('DropInputFocus', contextMenu);
        $.DispatchEvent('DropInputFocus', content);
    }
}
```

Wire it to a row with `oncontextmenu="ShowContextMenu()"` in the row XML and store `player_id` on the row panel. The server side actually removes the player (e.g. `SendToServerConsole('kick ' .. name)`); the menu only fires a custom event when auth (`IsAllowedToKick`) passes.

`oncontextmenu` is also how Petri's shop buys items on right-click:

```js
// Petri Reborn — shop.js, CreateItem()
item.SetPanelEvent('oncontextmenu', function () {
    GameEvents.SendCustomGameEventToServer("petri_buy_item", { itemname: itemname, /* ... */ });
});
```

---

## 8. Reading the player's REAL keybinds (throwaway `<DOTAHotkey>` panel)

`DOTAHotkey` is normally a *display* widget that renders the key glyph for a named Dota action. The trick (originally from ark120202, shipped by both **Petri Reborn** and **Angel Arena Black Star**): spawn one with `keybind:<name>`, read the resolved key text out of its generated child label, delete it, then register a custom command bound to **that exact key**. Your custom hotkey now matches each player's own rebinds.

```js
// Petri Reborn — hotkey_tracker.js
var contextPanel = $.GetContextPanel();

function GetKeyBind(name) {
    $.CreatePanelWithProperties('DOTAHotkey', contextPanel, "", { keybind: name });
    var keyElement = contextPanel.GetChild(contextPanel.GetChildCount() - 1);
    keyElement.DeleteAsync(0);                       // throw the probe away
    return keyElement.GetChild(0).text;             // the resolved key glyph
}

function RegisterKeyBindHandler(name, callback) {
    Game.AddCommand('petro_' + name, function () { callback(); }, '', 0);
}

function RegisterKeyBind(name, callback) {
    RegisterKeyBindHandler(name, callback);
    var key = GetKeyBind(name);
    if (key !== '') Game.CreateCustomKeyBind(key, 'petro_' + name);
}

GameUI.CustomUIConfig().RegisterKeyBind = RegisterKeyBind;   // expose globally
```

Angel Arena's version is functionally identical but uses `BCreateChildren` to spawn the probe and a **multiplexing** handler so several subscribers can share one key:

```js
// Angel Arena Black Star — hotkey_tracker.js
Game.Events = {};
function GetKeyBind(name) {
    contextPanel.BCreateChildren('<DOTAHotkey keybind="' + name + '" />');
    var keyElement = contextPanel.GetChild(contextPanel.GetChildCount() - 1);
    keyElement.DeleteAsync(0);
    return keyElement.GetChild(0).text;
}
function RegisterKeyBindHandler(name) {
    Game.Events[name] = {};
    Game.AddCommand(GetCommandName(name), function () {
        for (var key in Game.Events[name]) Game.Events[name][key]();   // fan out to all subscribers
    }, '', 0);
}
function RegisterKeyBind(name, callback) {
    if (Game.Events[name] == null) {
        RegisterKeyBindHandler(name);
        var key = GetKeyBind(name);
        if (key !== '') Game.CreateCustomKeyBind(key, GetCommandName(name));
    }
    Game.Events[name][callback.name] = callback;
}
GameUI.CustomUIConfig().RegisterKeyBind = RegisterKeyBind;
```

Usage, from Petri's shop (matches `ShopToggle` / `PurchaseQuickbuy` to the player's own keys):

```js
// Petri Reborn — shop.js
GameUI.CustomUIConfig().RegisterKeyBind('ShopToggle', ToggleShop);
GameUI.CustomUIConfig().RegisterKeyBind('PurchaseQuickbuy', function () {
    if (selectedItemName != "") GameEvents.SendCustomGameEventToServer("petri_buy_item", { /* ... */ });
});
```

This `render-a-DOTAHotkey-to-discover-the-bound-key` is the only reliable way to read a player's live keybind from Panorama.

---

## 9. Reading the player's REAL ping (scraping the NetGraph label)

There is no API to read measured ping/FPS in a custom game. **training polygon**'s `ping_reader.js` walks up to the built-in NetGraph widget and reads its already-rendered `NetGraph_PING` text label, then forwards it to the server every 5s. (`NetGraph_FPS` is the FPS readout, on the other column.)

```js
// training polygon — ping_reader.js
let Hud = $.GetContextPanel().GetParent().GetParent().GetParent();
let ping_panel    = Hud.FindChild('HUDElements').FindChild('NetGraph');
let ping_right_col = ping_panel.FindChild('RightColumn_2');
let ping_label    = ping_right_col.FindChild('NetGraph_PING');
let fps_label     = ping_panel.FindChild('RightColumn_1').FindChild('NetGraph_FPS');

function startCountingPing() {
    if (Game.IsInToolsMode()) {     // NetGraph doesn't render the same way in the editor
        return;
    }
    let pingFromUI = ping_label.text;
    GameEvents.SendCustomGameEventToServer("store_ping", { "ping": pingFromUI });
    $.Schedule(5, startCountingPing);
}
startCountingPing();
```

Notes from the source: this uses `FindChild` (direct child by name) at each level, not `FindChildTraverse`, so the path must match exactly. The `Game.IsInToolsMode()` guard is important — the NetGraph isn't populated the same way under the editor. The server-side `ping_reader:SetPing()` just caches the string for leaderboard display; the authors specifically abandoned a `Time() - sentTimestamp` round-trip approach in favor of trusting the HUD value.

---

## 10. Alt-click a native buff/debuff icon to broadcast it (OVERTHROW 3.0)

`ping_modifiers_fix.js` bolts a brand-new interaction onto Valve's default buff bar. It walks the live `buffs`/`debuffs` containers, attaches `onactivate` to each modifier icon, and on Alt+click resolves *which* buff was clicked by indexing into the portrait unit's visible (non-hidden) modifier list:

```js
// OVERTHROW 3.0 — ping_modifiers_fix.js
function GetBuffBySerialNumber(entity_id, check_debuffs, n_serial) {
    let counter = 0;
    for (let i = 0; i < Entities.GetNumBuffs(entity_id); i++) {
        let mod_id = Entities.GetBuff(entity_id, i);
        if (mod_id == -1 || Buffs.IsHidden(entity_id, mod_id)) continue;   // skip hidden
        if (Buffs.IsDebuff(entity_id, mod_id)) { if (!check_debuffs) continue; }
        else if (check_debuffs) continue;
        if (counter == n_serial) return mod_id;     // panel index n -> modifier serial
        counter++;
    }
}

const modifiers_info = {
    buffs:   { container: FindDotaHudElement("buffs"),   counter: 0 },
    debuffs: { container: FindDotaHudElement("debuffs"), counter: 0 },
};

function RegisterModifiersPanels() {
    const register = (type, is_debuff) => {
        const container = modifiers_info[type].container;
        for (let x = modifiers_info[type].counter; x < container.Children().length; x++) {
            const mod_panel = container.GetChild(x);
            mod_panel.GetChild(0).SetPanelEvent("onactivate", () => {
                if (!GameUI.IsAltDown()) return;
                /* ...rate-limit (SPAM_COUNT_LIMIT / SPAM_COOLDOWN / ANTI_SPAM_DELAY)... */
                const portrait_unit = Players.GetLocalPlayerPortraitUnit(LOCAL_PLAYER_ID);
                const modifier_idx = GetBuffBySerialNumber(portrait_unit, is_debuff, x);
                if (modifier_idx == undefined) return;
                const modifier_name = Buffs.GetName(portrait_unit, modifier_idx);
                const loc_token = `DOTA_Tooltip_${modifier_name}`;
                if (loc_token == $.Localize(loc_token)) return;     // bail if no loc string
                GameEvents.SendToServerEnsured("PingModifeirs:ping",
                    { target_entity: portrait_unit, modifier_name: modifier_name });
            });
            modifiers_info[type].counter++;
        }
    };
    register("buffs", false);
    register("debuffs", true);
    $.Schedule(1, RegisterModifiersPanels);    // re-hook newly added icons
}
RegisterModifiersPanels();
```

The hand-rolled rate limiter (constants `ANTI_SPAM_DELAY = 0.5`, `SPAM_COUNT_LIMIT = 1`, `SPAM_COOLDOWN = 2`) keeps players from flooding chat. Re-running on a 1s schedule re-hooks icons added after first load.

---

## 11. Twitch / BTTV emotes via remote `<img>` in HTML labels

A non-obvious Panorama capability: a `Label` with `html = true` will **fetch and render remote `https://` images**, not just `file://` assets. **Crumbling Island Arena** (`kappa.js`) and **Angel Arena Black Star** (`customchat.js` / `chat_smiles.js`) both exploit this to render live Twitch/BetterTTV emotes in custom chat.

```js
// Crumbling Island Arena — kappa.js
var template    = "https://static-cdn.jtvnw.net/emoticons/v1/{image_id}/1.0";
var bttvTemplate = "https://cdn.betterttv.net/emote/{image_id}/1x";

function ProcessEmote(input, template, emote, id) {
    var url = template.replace("{image_id}", id);
    return input.replace(new RegExp("\\b" + emote + "\\b", "g"), "<img src='" + url + "'/>");
}

function InsertEmotes(input, wasTopPlayer, wheel) {
    input = EscapeHtml(input);                       // escape user text FIRST
    if (wasTopPlayer)                                // "golden Kappa" easter egg
        input = input.replace(new RegExp("\\bKappa\\b", "g"),
            "<img src='file://{images}/custom_game/golden_kappa.png'/>");
    for (var emote in emotes)    input = ProcessEmote(input, template, emote, emotes[emote]);
    for (var emote in bttvEmotes) input = ProcessEmote(input, bttvTemplate, emote, bttvEmotes[emote]);
    if (wheel)
        input = "<img src='file://{images}/control_icons/chat_wheel_icon.png' class='ChatWheelIcon'/>" + input;
    return input;
}

// In game_hud.js the rendered string is pushed into a label:
//   label.html = true;
//   label.SetDialogVariable("message", InsertEmotes(message, wasTopPlayer, wheel));
```

The emote tables are shipped as data (`{ "Kappa": 25, "PogChamp": 88, "DendiFace": 58135, ... }`). Angel Arena builds one big word-boundary regex from the keys for a single-pass replace:

```js
// Angel Arena Black Star — customchat.js / chat_smiles.js
var twitchUrlMask = 'https://static-cdn.jtvnw.net/emoticons/v1/{id}/1.0';
var twitchRegExp = new RegExp('\\b(' + Object.keys(twitchSmileMap).map(_.escapeRegExp).join('|') + ')\\b', 'g');
function AddSmiles(s) {
    return s.replace(twitchRegExp, function (m) {
        return "<img src='" + twitchUrlMask.replace('{id}', twitchSmileMap[m]) + "'/>";
    });
}
```

Always HTML-escape the raw player text *before* substituting `<img>` tags (see `EscapeHtml` above) so a player can't inject markup.

### Reverse-flow chat with `scaleY(-1)` (Angel Arena Black Star)

A second trick from the same custom chat: to make newest lines appear at the bottom without a truly reversed list, the container flows `down`, every line gets `transform: scaleY(-1)`, and each new line is inserted with `MoveChildBefore` so old lines push off the top. A schedule fades them:

```js
// Angel Arena Black Star — customchat.js
msgBox.style.transform = 'scaleY(-1)';
msgBox.html = true;
if (lastLine) rootPanel.MoveChildBefore(msgBox, lastLine);
$.Schedule(7.5, function () { msgBox.AddClass('Expired'); });
```

It also redirects *native* pause/unpause chat lines into the custom panel by regex-matching localized `DOTA_Chat_*` strings on the real `ChatLinesPanel` children:

```js
// Angel Arena Black Star — custom_hud.js, UpdatePanoramaHUD()
var ChatLinesPanel = FindDotaHudElement('ChatLinesPanel');
var phrases = [$.Localize('DOTA_Chat_Paused'), $.Localize('DOTA_Chat_Unpaused'), /* ... */];
var regexp = new RegExp('^(' + _.escapeRegExp(phrases.map(p => p.replace(/%s\d/g, '.*')).join('|')) + ')$');
for (var i = 0; i < ChatLinesPanel.GetChildCount(); i++) {
    var child = ChatLinesPanel.GetChild(i);
    if (child.text && child.text.match(regexp)) RedirectMessage(child);
}
```

---

## 12. The avatar-pile layout trick (Dota Run)

A compact way to pack many hero portraits into a bounded width without a scrollbar: as each new avatar is added, advance an x-offset by an increment that **shrinks geometrically** (`offsetInc *= 0.9`). The first few faces fan out generously, later ones compress. **Dota Run**'s `voting.js` uses it for its vote tally:

```js
// Dota Run — voting.js, ReceiveVote()
function ReceiveVote(data) {
    var idName = GetLengthID(data.voted);
    var count = data.vote_count;
    var countHolder = $("#" + data.voted + "Count");
    var offsetInc = difficultyOffsets[idName];   // e.g. 13
    var offset = difficultyCounts[idName];        // e.g. 22

    for (var i = 0; i < count; i++) {
        offset += offsetInc;
        offsetInc *= 0.9;        // each step adds less -> faces pile tighter and tighter
    }
    var heroFace = $.CreatePanel("Panel", countHolder, "countPanel");
    heroFace.AddClass(hero);                       // reuse hero-portrait CSS class
    heroFace.style.position = offset + "px 0 0 0";
}
```

It also derives the hero-face CSS class by stripping the `npc_dota_hero_` prefix off the unit name, so it can reuse existing hero-portrait classes:

```js
// Dota Run — voting.js
var string_diff = "npc_dota_hero_";
var hero = data.unit_name.substring(string_diff.length);   // "npc_dota_hero_lina" -> "lina"
```

---

## Stability / Pitfalls

Everything in sections 1–12 reaches into **undocumented internal Valve panels and events**. Valve does not version, document, or promise stability for any of these ids. Plan accordingly.

- **Panel ids are not API.** `RadarButton`, `minimap_block`, `Buff0..29`, `NetGraph_PING`, `DOTAAbilityTooltip`, `AbilityCoreDetails`, `ScepterUpgradeDescription`, `stats_tooltip_region`, `level_stats_frame`, etc. can be renamed, re-nested, or removed in any patch. When a major HUD revamp ships (it has, repeatedly), these break silently. Code defensively: every `FindChildTraverse`/`FindChild` result can be `null`. The shipping games guard heavily (`if (panel != null)`, `if (!t) return`, retry-on-`$.Schedule`).

- **`FindChild` is exact; `FindChildTraverse` is recursive.** `ping_reader.js` uses `FindChild` at each level, so a single renamed intermediate breaks the whole path. Prefer `FindChildTraverse(leafId)` where the leaf id is reasonably unique — it survives intermediate re-nesting better.

- **The HUD rebuilds itself.** The abilities row, buff icons, `level_stats_frame` (which resets `CanLevelStats` every frame), and tooltip panels are recreated by the engine. Apply your hooks on a self-rescheduling `$.Schedule(...)` loop and re-attach when child counts change (Angel Arena gates on `abilities.GetChildCount()`; OVERTHROW re-hooks buff icons every 1s). One-shot setup at load *will* drift out of sync.

- **`SetPanelEvent` may not override a native handler.** Use the **`ClearPanelEvent('onactivate'/'onmouseover'/'onmouseout')` then `SetPanelEvent`** sequence (Angel Arena) before assuming your handler wins.

- **Tooltip injection is the most fragile thing here.** The `te_lock` re-dispatch + negative-`marginTop` clamp (OVERTHROW) depends on exact event arg ordering (`RegisterDotaTooltip([0,1])` etc.), exact child ids (`AbilityCoreDetails`, `ScepterUpgradeDescription`), and the re-dispatch not recursing. A change to the tooltip layout or to event signatures breaks it. Wrap mutations in `IsValid()` checks (`if (!extender.IsValid()) return;`) because the tooltip can be torn down mid-update.

- **`dota_hud_error_message` reason codes are internal.** `reason: 80` maps to a free-form `message` today; other reason codes map to hardcoded engine strings. The numeric mapping is not documented and could shift.

- **Reading the `<DOTAHotkey>` glyph is timing/locale-sensitive.** The probe must be created, read, and deleted on the same tick; the returned `.text` is a display glyph (may be empty if unbound — both games guard `if (key !== '')`). It reflects only what `DOTAHotkey` knows how to render.

- **Scraping `NetGraph_PING` only works at runtime.** Guard with `Game.IsInToolsMode()` (the editor doesn't populate the NetGraph the same way). The value is a rendered string ("23"), not a number — parse it yourself, and it only updates while the NetGraph is active.

- **Remote `<img>` emotes hit the public internet.** `html = true` labels fetching `static-cdn.jtvnw.net` / `cdn.betterttv.net` depend on those CDNs staying up and on the client's network. Always `EscapeHtml()` user text before inserting `<img>` tags to avoid markup injection. Emote id tables go stale as Twitch/BTTV change ids.

- **`DOTAContextMenuScript` vs `ContextMenuScript`.** Battle of Characters uses `DOTAContextMenuScript` (Dota-styled, supports `GetContentsPanel()` directly); Petri uses the lower-level `ContextMenuScript` and reaches `GetContentsPanel().GetParent()` to wipe Valve's default contents. They behave differently — pick the one whose default chrome you want, and always dismiss with `$.DispatchEvent('DismissAllContextMenus')` / `DropInputFocus`.

- **Native drag-drop needs the XML flag.** The five `Drag*` handlers do nothing unless the panel is `draggable="true"` in XML (or `panel.SetDraggable(true)`). The temp `DOTAItemImage` drag visual must be deleted in `OnDragEnd` (`DeleteAsync(0)`) or you leak panels.

- **Test against the live client, not just the editor.** Several of these (NetGraph, hotkey glyphs, native tooltip layout) differ between tools mode and a real match. Re-verify after every Dota gameplay/UI patch — assume these techniques are broken until proven working on the current build.
