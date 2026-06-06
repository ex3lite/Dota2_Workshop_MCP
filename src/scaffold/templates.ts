// Pure string/template builders for scaffolding. No file IO here.

export type AbilityBehavior = "no_target" | "point" | "unit_target" | "passive" | "channeled";

export interface BehaviorPreset {
  flags: string;
  /** Extra KV fields appended to the ability block. */
  extraKv: Record<string, string>;
}

export const BEHAVIOR_PRESETS: Record<AbilityBehavior, BehaviorPreset> = {
  no_target: { flags: "DOTA_ABILITY_BEHAVIOR_NO_TARGET", extraKv: {} },
  point: { flags: "DOTA_ABILITY_BEHAVIOR_POINT | DOTA_ABILITY_BEHAVIOR_AOE", extraKv: {} },
  unit_target: {
    flags: "DOTA_ABILITY_BEHAVIOR_UNIT_TARGET",
    extraKv: { AbilityUnitTargetTeam: "DOTA_UNIT_TARGET_TEAM_ENEMY", AbilityUnitTargetType: "DOTA_UNIT_TARGET_HERO | DOTA_UNIT_TARGET_BASIC" },
  },
  passive: { flags: "DOTA_ABILITY_BEHAVIOR_PASSIVE", extraKv: {} },
  channeled: { flags: "DOTA_ABILITY_BEHAVIOR_CHANNELLED | DOTA_ABILITY_BEHAVIOR_POINT", extraKv: {} },
};

/** Relative import path from a script at <scriptDir>/<name>.ts back to lib/dota_ts_adapter. */
function libImport(scriptDir: string): string {
  const depth = scriptDir.split("/").filter(Boolean).length;
  return "../".repeat(depth) + "lib/dota_ts_adapter";
}

// ---------------------------------------------------------------------------
// TypeScript ability (typescript-to-lua + dota_ts_adapter)
// ---------------------------------------------------------------------------
export function tsAbility(name: string, behavior: AbilityBehavior, scriptDir: string): string {
  const lib = libImport(scriptDir);
  const header = `import { BaseAbility, registerAbility } from "${lib}";\n\n@registerAbility()\nexport class ${name} extends BaseAbility {`;

  let body: string;
  switch (behavior) {
    case "passive":
      body = `
    // Passive abilities expose their effect through an intrinsic modifier.
    GetIntrinsicModifierName(): string {
        return "modifier_${name}";
    }`;
      break;
    case "unit_target":
      body = `
    OnSpellStart(): void {
        const caster = this.GetCaster();
        const target = this.GetCursorTarget();
        if (!target) return;

        const damage = this.GetSpecialValueFor("damage");
        ApplyDamage({
            victim: target,
            attacker: caster,
            damage,
            damage_type: DamageTypes.MAGICAL,
            ability: this,
        });
    }`;
      break;
    case "point":
      body = `
    OnSpellStart(): void {
        const caster = this.GetCaster();
        const point = this.GetCursorPosition();
        const radius = this.GetSpecialValueFor("radius");
        const damage = this.GetSpecialValueFor("damage");

        const enemies = FindUnitsInRadius(
            caster.GetTeamNumber(),
            point,
            undefined,
            radius,
            UnitTargetTeam.ENEMY,
            UnitTargetType.HERO | UnitTargetType.BASIC,
            UnitTargetFlags.NONE,
            FindOrder.ANY,
            false,
        );

        for (const enemy of enemies) {
            ApplyDamage({
                victim: enemy,
                attacker: caster,
                damage,
                damage_type: DamageTypes.MAGICAL,
                ability: this,
            });
        }
    }`;
      break;
    case "channeled":
      body = `
    OnSpellStart(): void {
        // Channel begins. Use OnChannelThink / OnChannelFinish for effects.
    }

    OnChannelThink(interval: number): void {
        // Called every server tick while channeling.
    }

    OnChannelFinish(interrupted: boolean): void {
        if (interrupted) return;
        const caster = this.GetCaster();
        // Apply the channeled effect here.
    }`;
      break;
    case "no_target":
    default:
      body = `
    OnSpellStart(): void {
        const caster = this.GetCaster();
        const duration = this.GetSpecialValueFor("duration");
        caster.AddNewModifier(caster, this, "modifier_${name}", { duration });
    }`;
      break;
  }

  return `${header}${body}\n}\n`;
}

// ---------------------------------------------------------------------------
// Raw Lua ability (BaseClass "ability_lua")
// ---------------------------------------------------------------------------
export function luaAbility(name: string, behavior: AbilityBehavior): string {
  if (behavior === "passive") {
    return `${name} = class({})

function ${name}:GetIntrinsicModifierName()
    return "modifier_${name}"
end
`;
  }
  const spellStart =
    behavior === "unit_target"
      ? `    local caster = self:GetCaster()
    local target = self:GetCursorTarget()
    if not target then return end

    local damage = self:GetSpecialValueFor("damage")
    ApplyDamage({
        victim = target,
        attacker = caster,
        damage = damage,
        damage_type = DAMAGE_TYPE_MAGICAL,
        ability = self,
    })`
      : behavior === "point"
        ? `    local caster = self:GetCaster()
    local point = self:GetCursorPosition()
    local radius = self:GetSpecialValueFor("radius")
    -- TODO: find units in radius and apply effect`
        : `    local caster = self:GetCaster()
    local duration = self:GetSpecialValueFor("duration")
    caster:AddNewModifier(caster, self, "modifier_${name}", { duration = duration })`;

  return `${name} = class({})

function ${name}:OnSpellStart()
${spellStart}
end
`;
}

// ---------------------------------------------------------------------------
// TypeScript modifier
// ---------------------------------------------------------------------------
export function tsModifier(name: string, scriptDir: string): string {
  const lib = libImport(scriptDir);
  return `import { BaseModifier, registerModifier } from "${lib}";

@registerModifier()
export class ${name} extends BaseModifier {
    IsHidden(): boolean {
        return false;
    }

    IsPurgable(): boolean {
        return true;
    }

    DeclareFunctions(): ModifierFunction[] {
        return [ModifierFunction.MOVESPEED_BONUS_PERCENTAGE];
    }

    GetModifierMoveSpeedBonus_Percentage(): number {
        return this.GetAbility()?.GetSpecialValueFor("movespeed_pct") ?? 0;
    }

    OnCreated(params: object): void {
        if (!IsServer()) return;
        // this.StartIntervalThink(1.0);
    }

    // OnIntervalThink(): void {}
}
`;
}

export function luaModifier(name: string, fileName: string): string {
  return `${name} = class({})

LinkLuaModifier("${name}", "${fileName}", LUA_MODIFIER_MOTION_NONE)

function ${name}:IsHidden() return false end
function ${name}:IsPurgable() return true end

function ${name}:DeclareFunctions()
    return { MODIFIER_PROPERTY_MOVESPEED_BONUS_PERCENTAGE }
end

function ${name}:GetModifierMoveSpeedBonus_Percentage()
    return self:GetAbility():GetSpecialValueFor("movespeed_pct")
end

function ${name}:OnCreated(params)
    if not IsServer() then return end
end
`;
}

// ---------------------------------------------------------------------------
// TypeScript item
// ---------------------------------------------------------------------------
export function tsItem(name: string, scriptDir: string): string {
  const lib = libImport(scriptDir);
  return `import { BaseItem, registerAbility } from "${lib}";

@registerAbility()
export class ${name} extends BaseItem {
    OnSpellStart(): void {
        const caster = this.GetCaster();
        // Item effect. Remember to spend a charge / set cooldown as needed.
    }
}
`;
}

// ---------------------------------------------------------------------------
// Panorama panel (template layout: content/panorama + src/panorama TS)
// ---------------------------------------------------------------------------
export function panoramaXml(panel: string, cssRel: string, jsRel: string): string {
  return `<root>
    <styles>
        <include src="s2r://panorama/styles/dotastyles.vcss_c" />
        <include src="file://{resources}/styles/custom_game/${cssRel}" />
    </styles>
    <scripts>
        <include src="file://{resources}/scripts/custom_game/${jsRel}" />
    </scripts>

    <Panel hittest="false">
        <Label id="${panel}Title" text="${panel}" class="${panel}-title" />
    </Panel>
</root>
`;
}

export function panoramaCss(panel: string): string {
  return `.${panel}-title {
    color: #ffffff;
    font-size: 32px;
    horizontal-align: center;
    vertical-align: top;
    margin-top: 64px;
}
`;
}

export function panoramaTs(panel: string): string {
  return `// Panorama panel script for "${panel}" (compiles to content/panorama/scripts/custom_game).

(function () {
    $.Msg("[${panel}] panel loaded");

    // Example: react to a custom game event sent from vscripts.
    // GameEvents.Subscribe("example_event", (data) => { $.Msg(data); });
})();
`;
}
