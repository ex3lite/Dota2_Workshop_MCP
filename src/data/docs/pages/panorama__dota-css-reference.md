# Dota 2 Panorama CSS Reference

Panorama CSS is Valve's CSS3-*subset* dialect for the Source 2 UI engine used by Dota 2 custom games. It looks like web CSS but is a separate engine with its own layout model (flow, not block/flex), its own sizing units (`fit-children`, `fill-parent-flow`), and Dota-specific compositing properties (`wash-color`, `blur`, `pre-transform-scale2d`, `brightness`, etc.). This document is the styling reference; it also covers just enough XML layout and the Panorama JS (`$`/panel) API to make the CSS usable, and where relevant the Lua server side that drives UI state.

The canonical machine source for property names/descriptions is the in-game console command `dump_panorama_css_properties` (run Dota with `-condebug`; use `dump_panorama_css_properties markdown` for markdown). Several properties exist in the engine but are self-documented as `<Needs a description>` (`flow-children`, `horizontal-align`, `vertical-align`, `align`, `margin*`, `padding*`, `font`, the `animation*` family); their semantics below come from the Valve Layout wiki and shipping CSS, not the engine self-doc.

> Accuracy note: every property and JS method below was checked against the `dump_panorama_css_properties` dump and against shipping CSS / the verified `panorama-types` API. A few properties that look like they should exist but do **not** in Panorama are called out explicitly (`tint`, `img-shadow`, `image-rendering`, `display`, `float`, `grid`, `linear-gradient()`).

## File model: how CSS attaches to UI

A Panorama screen is a `.xml` layout file. CSS files (`.css`) are referenced from the layout's `<styles>` block; scripts from `<scripts>`. There is no `<link>` and no `@import` in markup.

```xml
<root>
    <styles>
        <include src="file://{resources}/styles/custom_game/example.css" />
        <include src="file://{resources}/styles/custom_game/buttons.css" />
    </styles>
    <scripts>
        <include src="file://{resources}/scripts/custom_game/ExampleUI.js" />
    </scripts>

    <Panel hittest="false" style="width: 100%; height: 100%;">
        <Panel id="HeroPortraits" />
    </Panel>
</root>
```

- Files live under `content/dota_addons/<addon>/panorama/{layout,styles,scripts}/...`. `{resources}` resolves to the panorama root.
- Multiple `<include>` are allowed; later includes win on ties (last-wins cascade).
- Inline styles via the `style="..."` attribute on any panel; per-panel from JS via `panel.style.width = "50%"`.
- Custom HUD screens are typically declared in `custom_ui_manifest.xml` (which lists the layout files Panorama should load) and/or created at runtime from JS. Lua influences the HUD via `GameRules:GetGameModeEntity():SetCustomGameForceHero(...)` and similar, but the per-panel content driven by these CSS rules is created/managed from Panorama JS, not Lua.

## Selectors, classes, and the cascade

```css
#DefaultValveButtonID { horizontal-align: center; }      /* by id attribute            */
.DefaultValveButtonClass { width: 270px; }               /* by class (space-separated) */
Label { color: white; }                                  /* by panel TYPE              */
.DefaultValveButtonClass Label { text-align: center; }   /* descendant combinator      */
.ExampleButton2Class:hover Label { color: white; }        /* pseudo-class + descendant  */
.Contents > Label { font-size: 18px; }                   /* direct child '>'           */
.A.B { color: red; }                                     /* panel has BOTH classes     */
```

- Element/type selectors use the panel type name: `Panel`, `Label`, `Button`, `TextButton`, `Image`, `DOTAHeroImage`, `DOTAAbilityImage`, `DOTAItemImage`, `ProgressBar`, `DOTAScenePanel`, etc.
- Classes are toggled from JS: `panel.AddClass("x")`, `RemoveClass`, `ToggleClass("x")`, `SetHasClass("x", bool)`, `BHasClass("x")`. A panel may carry many classes (`class="ButtonBevel ESCMenuButton"`).
- Universal `*` exists but is flagged slow; avoid it.
- **Cascade is effectively last-wins** in source/include order; pseudo-class rules override base rules while active (this is what `transition` animates between). `!important` exists but is discouraged.

### Pseudo-classes (Panorama-specific set)

```css
.Btn:hover { brightness: 2; }              /* pointer over panel                       */
.Btn:active { brightness: 3; }             /* being pressed / activated                */
.Field:focus { border-color: #6cf; }        /* has keyboard focus                       */
.Group:descendantfocus { wash-color: #ffffff11; } /* a descendant has focus            */
.Tab:selected { color: white; }            /* toggle/radio selected state              */
.Btn:disabled { saturation: 0; }           /* disabled                                 */
.Btn:activationdisabled { opacity: 0.5; }   /* not activatable, may still be focusable   */
#Screen:layoutloading { opacity: 0; }      /* layout still loading                     */
#Screen:layoutfailed { background-color: #400; } /* layout failed to load              */
```

- The Panorama pseudo-class is spelled `:descendantfocus` (one word, no hyphen). There is no `:descendant-focus`, `:enabled`, or `:checked`.
- Pseudo-classes chain with classes/ids/descendants: `.ButtonBevel:hover`, `#ESCResumeButton:hover`, `.ExampleButton2Class:active Label`.

## Layout: the flow model (NOT flexbox)

There is **no `display` property and no `display:flex`**. Layout is "flow": a parent declares a flow direction and children stack in that direction.

### `flow-children`

```css
#HeroPortraits { flow-children: down; }   /* stack top -> bottom        */
.Contents      { flow-children: right; }  /* stack left -> right         */
#Manual        { flow-children: none; }   /* manual positioning via x/y/z + align */
#Grid          { flow-children: right-wrap; } /* flow right, wrap to new row    */
#ColGrid       { flow-children: down-wrap; }  /* flow down, wrap to new column  */
```

### Sizing units (`width` / `height`)

```css
.A { width: 100px; }                 /* fixed px                                   */
.B { width: 100%; }                  /* percent of parent                          */
.C { width: fit-children; }          /* DEFAULT: shrink-wrap to children            */
.D { width: fill-parent-flow( 1.0 ); } /* fill remaining parent space along flow axis */
.E { height: height-percentage( 100% ); } /* size as % of the OTHER dimension (aspect) */
```

- `fit-children` is the **default** — panels shrink-wrap their content unless told otherwise. This is the single biggest surprise coming from web CSS (where block elements fill width).
- `fill-parent-flow( weight )`: if three children all use `fill-parent-flow(1.0)` in a 300px-wide flowing-right parent, each becomes 100px. Only meaningful inside a flowing parent on the flow axis; the engine warns if used off-axis.
- `width-percentage()` / `height-percentage()` enforce an aspect ratio by sizing one axis as a percent of the other; the other axis must not also be a `*-percentage`.
- `min-width` / `max-width` / `min-height` / `max-height` take px or %: `min-width: 192px; min-height: 36px;`.

### Alignment and box spacing

```css
#Btn { horizontal-align: center; vertical-align: bottom; }
#Btn { align: center bottom; }        /* shorthand: <horizontal> <vertical>          */
.Card { margin: 0px 20px; padding: 4px 10px; } /* shorthand or per-side margin-top etc. */
```

- `horizontal-align`: `left` (default) | `center` | `right`.
- `vertical-align`: `top` (default) | `center` | `bottom`. Note: shipping CSS frequently uses `middle` as an alias for center (`vertical-align: middle;`), and it is accepted.
- `margin`/`padding` use standard box behavior and per-side props (`margin-top`, `padding-left`, ...).

### Off-flow positioning

```css
.HealthContainer { x: 90px; y: 50px; }                 /* per-axis (each sets the triple) */
#Overlay { position: 3% 20px 0px; }                    /* position: <x> <y> <z>            */
#Overlay { flow-children: none; }                      /* required to take a panel out of flow */
```

- `position` is a **3-tuple `x y z`**, not `position: absolute; top/left`. It must NOT be in a flowing layout (parent should be `flow-children: none`, or the panel otherwise removed from flow).
- `z-index` controls **paint/hit-test order** within a parent (default `0`, any float). It is separate from `z` (depth used for perspective). `z-index` does not change rendering perspective, only ordering.

### Overflow and visibility

```css
.A { overflow: squish; }          /* DEFAULT: squish children to fit               */
.B { overflow: clip; }            /* keep child size, clip                         */
.C { overflow: squish scroll; }   /* X squish, Y scroll (adds scrollbar)           */
.D { overflow: noclip; }          /* keep child size, allow overflow (shipping use) */
.Hidden { visibility: collapse; } /* invisible AND removed from layout (siblings reflow) */
.Faded { opacity: 0.4; }          /* 0.0-1.0 multiplier over panel + children       */
```

- The `dump_panorama_css_properties` dump enumerates exactly three `overflow` values: `squish` (default), `clip`, `scroll`. Two values = horizontal then vertical.
- `noclip` is **not** listed in the dump, but it is accepted by the parser and appears in shipping CSS (`overflow: noclip;` in the official button examples). Treat it as "keep child size, do not clip" and use it knowingly.
- **There is no `display:none`.** Hide-and-reflow with `visibility: collapse`; `visible` (default) keeps it in layout. `visibility` accepts only `visible` and `collapse`.

## Dota-specific compositing and visual properties

These run at composition over the panel **and all its children** (filter-like). They are first-class properties, not a `filter:` shorthand.

```css
.Tinted    { wash-color: #39b0d325; }     /* blend color over panel+children; alpha = intensity */
.Blurred   { blur: gaussian( 2.5 ); }     /* gaussian( stddev ) | gaussian( hStd, vStd, passes ) */
.Gray      { saturation: 0.4; }           /* 1.0 = none, 0.0 = grayscale, >1 oversaturate        */
.Bright    { brightness: 1.5; }           /* brightness multiplier (hover uses 2, active 3)      */
.HighC     { contrast: 1.5; }             /* contrast multiplier                                 */
.Shifted   { hue-rotation: 180deg; }      /* degrees, default 0                                  */
.Mult      { -s2-mix-blend-mode: multiply; } /* normal(alpha)|multiply|screen|... (see web docs) */
.IconMask  { texture-sampling: alpha-only; } /* normal | alpha-only (spread alpha across RGB)    */
```

- The blend-mode property is spelled **`-s2-mix-blend-mode`** (Source 2 vendor prefix), not the web `mix-blend-mode`. Its values follow the web `mix-blend-mode` set, except Panorama's `normal` uses alpha blending.
- `blur`: good stddev values ~0-10; more than one pass is bad for perf. All of the above are animatable and commonly appear in `transition-property`.

### Transforms

```css
.Slide  { transform: translate3d( -100px, -100px, 0px ); }
.Spin   { transform: rotateZ( -32deg ) rotateX( 30deg ) translate3d( 125px, 520px, 230px ); }
.Reset  { transform: none; }
.Nudge  { transform: translateY(1px); }
.Origin { transform-origin: 50% 50%; }          /* default 50% 50%                         */
.PopIn  { pre-transform-scale2d: 0.8; }          /* 2D scale BEFORE 3D, perspective-free     */
.PreRot { pre-transform-rotate2d: 45deg; }       /* 2D rotate BEFORE 3D, perspective-free    */
#Stage  { perspective: 1000; perspective-origin: 50% 50%; } /* depth space for children       */
```

- Transform ops in the dump are lowercase: `translate3d`, `translatex/y/z`, `scale3d`, `rotate3d`, `rotatex/y/z`. CamelCase forms (`rotateZ`, `translateY`) are also accepted (shipping CSS uses them); ops apply left-to-right.
- `pre-transform-scale2d` / `pre-transform-rotate2d` are **Panorama-unique**: applied to the quad before the 3D transforms, no perspective, panel stays centered. `1.0` = none; `pre-transform-scale2d: 0.4, 0.6` scales X/Y independently. These are the go-to for pop-in/pulse effects.
- `perspective` default 1000 means children at +1000px z are at the viewer's eye, -1000px just out of view faded to nothing.

### Shadows, borders, radius

```css
.Outer  { box-shadow: #ffffff80 4px 4px 8px 0px; }            /* color hOff vOff blur spread */
.Filled { box-shadow: fill #ffffff80 4px 4px 8px 0px; }        /* 'fill' = behind whole box   */
.Inner  { box-shadow: inset #333333b0 0px 0px 8px 12px; }      /* 'inset' = inner shadow/glow */
.Ship   { box-shadow: black -4px -4px 8px 8px; }               /* shipping example (spread)   */
.Txt    { text-shadow: 2px 2px 8px 3.0 #333333b0; }            /* hOff vOff blur STRENGTH color */
.Txt2   { text-shadow: 0px 0px 6px 1 #000000; }                /* note extra strength float    */
.Border { border: 2px solid #111111FF; }                       /* styles: solid | none        */
.Sides  { border-top-color: #555; border-left-color: #494949; border-bottom-color: #333; }
.Round  { border-radius: 6px; }
.Ellip  { border-radius: 50% / 50%; }                          /* h / v, circle/ellipse        */
.Each   { border-radius: 2px 3px 4px 2px / 2px 3px 3px 2px; }
```

- `box-shadow` adds `fill` (draw behind the whole box, not clipped to outside the border) and `inset` keywords vs web. Order: `[inset] [fill] color hOffset vOffset blur spread`.
- `text-shadow` has an **extra strength float** between blur and color vs web: `hOff vOff blur strength color`.
- `border-radius` clips both background AND foreground content; per-corner props (`border-top-left-radius`, ...) take 1-2 values (h, v).

### Backgrounds and images

```css
.Solid { background-color: #FFFFFFFF; }
.Grad  { background-color: gradient(linear, 0% 0%, 0% 100%, from(#373d45), to(#4d5860)); }
.Layer { background-color: #0d1c22ff, gradient( radial, 50% 50%, 0% 0%, 80% 80%, from(#00ff00ff), to(#0000ffff) ); }
.None  { background-color: none; }
.Img {
  background-image: url('s2r://panorama/images/textures/glassbutton_darkmoon_psd.vtex');
  background-size: 100%;            /* px | % | contains | auto(default)              */
  background-position: 50% 50%;     /* keyword/% h, keyword/% v; default 0% 0%         */
  background-repeat: no-repeat;     /* repeat(default)|space|round|no-repeat|repeat-x/-y */
}
.Combo {
  background-image: url("file://{images}/default.tga"), url("file://{movies}/Background1080p.webm");
}
.Local { background-image: url('file://{images}/custom_game/interface/esc_bg_psd.png'); }
```

- `background-image` is a **comma-separated list of images or movies**; `none` to skip. Use compiled `.vtex` via `s2r://` for shared/Dota assets and raw `.png`/`.tga`/`.jpg`/`.webm` via `file://{images}`/`file://{movies}`.
- `background-size`: the dump documents the keyword as **`contains`** (sizes the image to fit within the panel) and `auto` (preserves original size/aspect, the default); there is no web `cover`. The shipping button example uses `background-size: contain;`, which the parser also accepts, but prefer `contains` per the dump. Two values are width then height.
- `background-position`: percentages position that point of the image over that point of the panel; px places relative to the keyword. Forms like `center top`, `right bottom`, `left 10px top 40px` are valid.

### Masks, clip, and image content

```css
.Mask    { opacity-mask: url("file://{images}/upper_row_mask.tga") 0.5; } /* second float = mask opacity */
.ScrollM { opacity-mask-scroll-up: url("..."); opacity-mask-scroll-down: url("..."); }
.ClipR   { clip: rect( 10%, 90%, 90%, 10% ); }            /* top, right, bottom, left   */
.ClipA   { clip: radial( 50% 50%, 0deg, 90deg ); }        /* center, startAngle, width   */
```

- `clip` is a render-time clip with no layout impact; safe to transition/animate. It accepts `rect( top, right, bottom, left )` and `radial( center, startAngle, sweepWidth )`.
- `opacity-mask` uses an image's alpha to fade content (doesn't cross-fade when changed). The scroll variants (`opacity-mask-scroll-up` / `opacity-mask-scroll-down`) swap based on `overflow:scroll` state — used for fade edges on scroll regions.
- **There is no CSS `tint`, `img-shadow`, or `image-rendering` property in Panorama** (these are common but false expectations from web CSS / other frameworks):
  - To tint a panel or an image, use `wash-color` (blends a color over the panel + children) or the `-s2-mix-blend-mode: multiply` trick.
  - `<Image>` / `DOTAImage` scaling is controlled by the XML `scaling` attribute on the panel (e.g. `scaling="stretch-to-fit-preserve-aspect"`, `"stretch-to-fit-x-preserve-aspect"`, `"stretch-to-cover-preserve-aspect"`), not a CSS `image-rendering` property.
  - For a drop shadow under an image, put the image in a parent panel and use `box-shadow` on the parent, or use a pre-shadowed texture.

### CSS-driven audio

```css
.Btn:active { sound: 'ui_generic_button_click'; } /* plays when selector starts applying */
.Panel      { sound: "whoosh_in"; sound-out: "whoosh_out"; } /* sound-out when selector removed */
```

`sound` plays a registered soundevent when the selector starts applying; `sound-out` plays when the selector stops applying.

## Color and gradients

- Hex with **alpha as the last byte**: `#rrggbb`, `#rrggbbaa` (e.g. `#39b0d325`, `#aaaaaa77`). Also `rgb()`/`rgba()` and named colors (`black`, `white`, `grey`/`gray`, `transparent`, `none`).
- `gradient()` is **old-Webkit-style** (`from()/to()/color-stop()`), not modern `linear-gradient()`. It is a *value* usable for `background-color`, `color` (text fill), and border colors.

```css
/* Linear: gradient( linear, hStart% vStart%, hEnd% vEnd%, from(c), [color-stop(f,c),] to(c) ) */
.V { background-color: gradient(linear, 0% 0%, 0% 100%, from(#fbfbfbff), color-stop(0.3, #ebebebff), to(#c0c0c0c0)); }
.H { background-color: gradient(linear, 0% 0%, 100% 0%, from(#373d45), to(#4d5860)); }

/* Radial: gradient( radial, hCenter% vCenter%, hInner% vInner%, hRadius% vRadius%, from(c), to(c) ) */
.R { background-color: gradient(radial, 50% 50%, 0% 0%, 80% 80%, from(#00ff00ff), to(#0000ffff)); }

/* Gradient as TEXT fill (shipping): */
.ESCMenuButton Label { color: gradient(linear, 0% 0%, 0% 100%, from(#eaeaea), to(#ababab)); }
```

`from(...)` = 0%, `to(...)` = 100%, intermediate stops via `color-stop( fraction0to1, color )`.

## Text (`<Label>`)

```css
.ESCMenuButton Label {
  color: #ffffff;                 /* hex or gradient()                                  */
  font-family: defaultFont;       /* Dota built-in; or "Arial", "Comic Sans MS"          */
  font-size: 18px;                /* target height; px in practice                       */
  font-style: normal;             /* normal | italic                                    */
  font-weight: bold;              /* light | thin | normal | medium | bold | black       */
  text-align: center;             /* left(default) | right | center                     */
  text-transform: uppercase;      /* none | uppercase | lowercase                       */
  text-decoration: none;          /* none | underline | line-through                    */
  letter-spacing: 2px;            /* normal | px                                        */
  line-height: 20px;              /* px; auto-derived from font-size if unset           */
  text-overflow: ellipsis;        /* clip | ellipsis(DEFAULT) | shrink                  */
  white-space: nowrap;            /* normal(wrap) | nowrap                              */
  text-shadow: 2px 2px 0px 1 #000000; /* see shadows note (extra strength float)        */
}
```

- `text-overflow` accepts exactly three values per the dump: `clip`, `ellipsis` (the Panorama default), and `shrink` (scales the text down to fit). There is no `noclip` value for `text-overflow`. Web's default is `clip`; Panorama's is `ellipsis`, so long labels silently show "..." unless you set `clip` / `shrink` / `white-space: nowrap`.
- `font-weight` accepts the named set `light | thin | normal | medium | bold | black` (not numeric `400`/`700`).

## Transitions

```css
.DefaultValveButtonClass {
  background-color: gradient(linear, 0% 0%, 0% 100%, from(#373d45), to(#4d5860));
  transition-property: background-color;
  transition-duration: 0.05s;
  transition-timing-function: linear;
}
.DefaultValveButtonClass:hover {
  background-color: gradient(linear, 0% 0%, 0% 100%, from(#4c5561), to(#6c7d88));
}

/* Multi-property, mapped 1:1 by position */
#PopupESCMenu {
  transition-property: opacity, transform, pre-transform-scale2d, wash-color;
  transition-duration: 0.4s;          /* one value applies to all, or comma-list 1:1 */
  transition-delay: 0s;
  transition-timing-function: ease-in-out;
}

/* Shorthand: property duration timing delay, comma-separated */
.X { transition: position 2.0s ease-in-out 0.0s, perspective-origin 1.2s ease-in-out 0.8s; }
```

- Valid timing functions: `ease`, `ease-in`, `ease-out`, `ease-in-out`, `linear`, `cubic-bezier( a, b, c, d )`.
- Transitions fire when a `:hover`/`:active`/class change alters a transitionable property (background-color, color, transform, pre-transform-scale2d, opacity, wash-color, box-shadow, blur, brightness, border, ...).

## Animations (@keyframes)

`@keyframes` + the `animation*` family exist (the engine dump leaves them `<Needs a description>`; they follow web semantics).

```css
@keyframes Pulse {
    0%   { pre-transform-scale2d: 1.0; }
    50%  { pre-transform-scale2d: 1.1; }
    100% { pre-transform-scale2d: 1.0; }
}
#Thing {
    animation-name: Pulse;
    animation-duration: 1.0s;
    animation-timing-function: ease-in-out;
    animation-iteration-count: infinite;   /* number or infinite                       */
    animation-direction: alternate;        /* normal|reverse|alternate|alternate-reverse */
    animation-delay: 0s;
    /* shorthand: animation: Pulse 1.0s ease-in-out infinite alternate; */
}
```

Animatable properties are the same compositing/transform/color set as transitions.

## Asset URL schemes

```
file://{resources}/...   panorama root (CSS/JS includes, layouts)
file://{images}/...      addon panorama/images/ (raw .png/.tga/.jpg)
file://{movies}/...      webm/movie backgrounds
s2r://...                Source 2 compiled resource (.vtex textures, shared Dota images)
```

```css
/* compiled Dota texture (shared) */
.Icon { background-image: url('s2r://panorama/images/control_icons/dota_logo_white_png.vtex'); }
/* raw local image */
.Bg   { background-image: url('file://{images}/custom_game/interface/esc_bg_psd.png'); }
```

**Hero/ability/item images** follow a naming convention: `s2r://panorama/images/heroes/<hero>_png.vtex` (e.g. `npc_dota_hero_juggernaut_png.vtex`). From JS, set them with `SetImage` (see below).

- **`src` attribute / `SetImage()` vs CSS `background-image`**: an `<Image src="...">` (or `panel.SetImage(...)`) loads the image as the panel's *content* (and respects the panel's `scaling` attribute). CSS `background-image` paints behind content and obeys `background-size`/`background-position`/`background-repeat`. Use `src`/`SetImage` for a sized foreground image; `background-image` for decorative/tiled fills.

## Tooltip and context-menu placement (CSS properties, not pseudo-classes)

Set on the panel that owns the tooltip/menu:

```css
#Source {
  tooltip-position: bottom;             /* order of sides to try; default: right left bottom top */
  tooltip-arrow-position: 50% 50%;      /* arrow placement, default 50% 50%                       */
  tooltip-body-position: 0% 0%;         /* body alignment (0=left/top,50=center,100=right/bottom)  */
  context-menu-position: left bottom;   /* same family for context menus                          */
  context-menu-arrow-position: 50% 50%;
  context-menu-body-position: 0% 0%;
}
```

## Driving CSS state from Panorama JS

The CSS is static; you change classes/inline styles at runtime via the JS API (TypeScript shown; `panorama-types` provides typings). Method signatures below match the typed API.

```typescript
class PlayerPortrait {
  panel: Panel;
  heroImage: ImagePanel;
  hpBar: Panel;

  constructor(parent: Panel, heroName: string) {
    // Create a panel: $.CreatePanel(type, parent, id)
    const panel = $.CreatePanel('Panel', parent, '');
    this.panel = panel;
    panel.BLoadLayoutSnippet('PlayerPortrait');            // load a <snippet> by name (returns boolean)

    this.heroImage = panel.FindChildTraverse('HeroImage') as ImagePanel;
    this.hpBar = panel.FindChildTraverse('HealthBar')!;     // FindChild (direct) vs FindChildTraverse (deep)

    this.heroImage.SetImage('s2r://panorama/images/heroes/' + heroName + '_png.vtex');
  }

  SetHealthPercent(p: number) {
    this.hpBar.style.width = Math.floor(p) + '%';           // inline style mutation (camelCase prop)
  }

  SetActive(on: boolean) {
    this.panel.SetHasClass('Active', on);                   // toggle a CSS class -> triggers transitions
  }
}

let ui = new ExampleUI($.GetContextPanel());                // typical entry point
```

Key panel methods that interact with CSS (verified signatures):
- Classes: `AddClass(name)`, `RemoveClass(name)`, `ToggleClass(name)`, `SetHasClass(name, active)`, `BHasClass(name): boolean`.
- Inline style: `panel.style` is a `VCSSStyleDeclaration` whose properties use **camelCase** DOM names, e.g. `panel.style.width = "50%"`, `panel.style.backgroundColor = "#000"`, `panel.style.marginTop = "8px"`. (Hyphenated CSS names like `panel.style["margin-top"]` do not work; convert to camelCase.)
- Visibility: `panel.visible = false` maps to `visibility: collapse`; `panel.SetReadyForDisplay(true)`.
- Lifecycle: `$.CreatePanel(type, parent, id, properties?)`, `panel.RemoveAndDeleteChildren()`, `panel.DeleteAsync(time)`.
- Lookups: `FindChild(id)`, `FindChildTraverse(id)`, `$('#id')` (within context panel scope).
- Scheduling for animations: `$.Schedule(seconds, fn)` to add a class on the next frame so a `transition` can run.

```typescript
// Force-reflow trick so a transition runs after creating + classing a panel:
const p = $.CreatePanel('Panel', $.GetContextPanel(), 'fx');
p.AddClass('Start');                 // initial state
$.Schedule(0, () => p.AddClass('Show')); // next frame -> transition Start->Show fires
```

## Driving UI from Lua (server side)

CSS/UI state often reflects gameplay. The server pushes data via net tables and custom events; the JS subscribes and toggles classes/styles.

```lua
-- Lua (vscripts): push state the UI will react to
CustomNetTables:SetTableValue("player_state", tostring(playerID), { hp = 0.42 })

-- Fire an event consumed by Panorama JS
CustomGameEventManager:Send_ServerToPlayer(
    PlayerResource:GetPlayer(playerID),
    "hp_changed",
    { playerID = playerID, hpPercentage = 42 }
)
```

```typescript
// Panorama JS: receive and apply to CSS-driven UI
interface HPChangedEvent { playerID: PlayerID; hpPercentage: number; }
GameEvents.Subscribe<HPChangedEvent>('hp_changed', (e) => {
  portraits[e.playerID].SetHealthPercent(e.hpPercentage);
});
// Net table:
CustomNetTables.SubscribeNetTableListener('player_state', (_t, key, data) => {
  somePanel.style.width = Math.floor(data.hp * 100) + '%';
});
```

## Recipes

### Valve-style button with hover/active (shipping)

```xml
<TextButton id="DefaultValveButtonID" class="DefaultValveButtonClass" text="#DefaultValveButton"/>
```

```css
.DefaultValveButtonClass {
  width: 270px; min-width: 192px; min-height: 36px;
  background-color: gradient(linear, 0% 0%, 0% 100%, from(#373d45), to(#4d5860));
  border-style: solid; border-width: 1px; padding: 4px 10px;
  border-top-color: #555555; border-left-color: #494949;
  border-bottom-color: #333333; border-right-color: #404040;
  transition-property: background-color; transition-duration: 0.05s; transition-timing-function: linear;
}
.DefaultValveButtonClass Label {
  text-transform: uppercase; letter-spacing: 2px; color: #ffffff; text-align: center;
  horizontal-align: center; vertical-align: middle; text-shadow: 2px 2px 0px 1 #000000;
  font-size: 18px; font-family: defaultFont;
  transition-property: color; transition-duration: 0.35s; transition-timing-function: ease-in-out;
}
.DefaultValveButtonClass:hover {
  background-color: gradient(linear, 0% 0%, 0% 100%, from(#4c5561), to(#6c7d88));
  border-top-color: #aaaaaa77;
}
.DefaultValveButtonClass:active {
  background-color: gradient(linear, 0% 0%, 0% 100%, from(#393939), to(#555555));
  sound: 'ui_generic_button_click';
}
```

### Icon + label button using nested flow (shipping)

```xml
<Button id="ExampleButton2ID" class="ExampleButton2Class">
  <Panel class="Contents">
    <Panel class="CustomIcon"/>
    <Label id="ExampleButton2Label" text="#ExampleButton"/>
  </Panel>
</Button>
```

```css
.ExampleButton2Class {
  background-color: gradient(linear, 0% 0%, 0% 100%, from(#6b211c), to(#8e2b19));
  border: 1px solid #bc4539;
  transition-property: border, brightness; transition-duration: 0.1s; transition-timing-function: linear;
  overflow: noclip; min-width: 300px; min-height: 45px;
}
.Contents { horizontal-align: center; vertical-align: middle; flow-children: right; margin: 0px 20px; }
.CustomIcon {
  background-image: url('s2r://panorama/images/control_icons/dota_logo_white_png.vtex');
  background-size: contain; width: 26px; height: 26px; margin-right: 4px; vertical-align: middle;
}
.ExampleButton2Class:hover { brightness: 2; }
.ExampleButton2Class:hover Label { color: white; }
.ExampleButton2Class:active { brightness: 3; border: 1px solid #501f18; sound: 'ui_generic_button_click'; }
.ExampleButton2Class:active Label { transform: translateY(1px); }
```

### Pop-in panel (scale + fade transition)

```css
#PopupESCMenu {
  width: 350px; horizontal-align: center; vertical-align: center;
  opacity: 1; transform: none;
  background-image: url('file://{images}/custom_game/interface/esc_bg_psd.png');
  background-position: center top; background-color: none; flow-children: down; padding: 2px;
  transition-property: opacity, transform, pre-transform-scale2d, wash-color;
  transition-duration: 0.4s; transition-delay: 0s; transition-timing-function: ease-in-out;
}
#PopupESCMenu.Hidden { opacity: 0; pre-transform-scale2d: 0.85; }  /* toggle .Hidden from JS */
```

### Horizontal bar that fills proportionally

```css
.HealthContainer { width: 200px; height: 20px; background-color: black; }
#HealthBar { height: 20px; width: 50%; background-color: green; } /* set width % from JS */
```

## Common pitfalls

- **Panels shrink-wrap by default.** `width`/`height` default to `fit-children`. If a panel looks invisible/zero-sized, give it an explicit size or `fill-parent-flow(1.0)` (on the flow axis) or `width: 100%`.
- **No `display`/`display:flex`/`float`/`grid`.** Use `flow-children: down|right|none|down-wrap|right-wrap`. Porting flexbox code line-by-line will not work.
- **`position` is a 3-tuple and needs `flow-children: none`.** Writing `position: 10px 20px 0px;` on a child inside a flowing parent is ignored/warned. Use `x`/`y`/`z` plus a non-flowing parent, or alignment.
- **Hide with `visibility: collapse`, not `display:none`.** `collapse` removes from layout (siblings reflow); `visible` keeps it. The only `visibility` values are `visible` and `collapse`.
- **`#rrggbbaa` alpha is the LAST byte.** `#39b0d325` is ~15% alpha cyan, not a dark color. Easy to confuse with `#aarrggbb` from other frameworks.
- **`gradient()` is old-Webkit syntax.** `linear-gradient(to bottom, ...)` does NOT parse. Use `gradient(linear, 0% 0%, 0% 100%, from(...), to(...))`.
- **Transitions need both states present and a non-trivial start value.** Setting a property only in `:hover` with no base value, or toggling `visibility: collapse` (not transitionable), kills the animation. Transition `opacity`/`transform`/`pre-transform-scale2d` instead, and keep the panel in layout.
- **Creating a panel then adding a class in the same frame skips the transition.** Use `$.Schedule(0, ...)` (or set the base state, then the target state on the next frame).
- **`text-overflow` defaults to `ellipsis`** and has only `clip | ellipsis | shrink` (no `noclip`). If you expected web's `clip` default, long labels will silently show "...". Set `text-overflow: clip;` or `white-space: nowrap;`/`shrink` as needed.
- **`z-index` (paint order) is not `z` (depth).** To reorder overlapping siblings use `z-index`; `z`/the third position component feeds perspective and can change apparent size.
- **`s2r://` paths point at COMPILED assets (`*_png.vtex`, `*_psd.vtex`).** A raw `.png` only works via `file://{images}/...`; mixing them up yields a missing-texture (pink/checker) panel. Hero art is `s2r://panorama/images/heroes/<name>_png.vtex`.
- **Compositing filters affect ALL children.** `brightness`, `blur`, `wash-color`, `saturation`, `opacity` on a parent cascade visually onto every descendant; isolate by applying them on a leaf panel.
- **`box-shadow`/`text-shadow` syntax differs from web.** `box-shadow` adds optional `inset`/`fill`; `text-shadow` inserts a strength float (`hOff vOff blur strength color`). Web-style shadow strings will fail to parse.
- **There is no `tint`, `img-shadow`, or `image-rendering` CSS property.** Tint via `wash-color` (or `-s2-mix-blend-mode: multiply`); scale images with the panel's XML `scaling` attribute; fake an image shadow with `box-shadow` on a wrapping panel.
- **Blend mode is `-s2-mix-blend-mode`, not `mix-blend-mode`.** The unprefixed web name does not exist in Panorama.
- **`panel.style` properties are camelCase, not hyphenated.** Use `panel.style.backgroundColor`, not `panel.style["background-color"]`.
- **Default panel sizing + `overflow: squish`** can silently scale children down; if children look mysteriously compressed, the parent is too small and squishing — set `overflow: noclip`/`clip`/`scroll` or fix sizes.
- **Engine `<Needs a description>` props are real but undocumented.** `flow-children`, `align`, `margin`/`padding`, `font`, `animation*` work as described here (sourced from the Layout wiki + shipping CSS), but don't expect descriptive text in the raw `dump_panorama_css_properties` output.

## Key differences from web CSS (summary)

- Layout is **flow** (`flow-children`), not block/flex/grid; default size is `fit-children` (shrink-wrap).
- Sizing keywords are Panorama-only: `fit-children`, `fill-parent-flow(weight)`, `width-percentage()/height-percentage()`.
- Positioning is `position: x y z` (3-tuple) + `x`/`y`/`z`, requiring `flow-children: none`; `z-index` is separate from `z`.
- Hide via `visibility: collapse` (no `display:none`; values are only `visible`/`collapse`).
- `gradient()` is old-Webkit (`from()/to()/color-stop()`), usable as text/`color` and border colors; `#rrggbbaa` alpha is the 4th byte.
- Compositing filters are first-class properties (`blur`, `brightness`, `contrast`, `saturation`, `hue-rotation`, `wash-color`, `texture-sampling`, `-s2-mix-blend-mode`), not a `filter:` shorthand; transforms add `pre-transform-scale2d`/`pre-transform-rotate2d` and `perspective`/`perspective-origin` properties.
- `box-shadow` adds `fill`; `text-shadow` adds a strength float; `text-overflow` defaults to `ellipsis` and adds `shrink` (no `noclip`).
- No `tint`/`img-shadow`/`image-rendering`; image scaling uses the panel's XML `scaling` attribute.
- Extra pseudo-classes: `:selected`, `:activationdisabled`, `:descendantfocus`, `:layoutloading`, `:layoutfailed`. CSS can play sounds via `sound`/`sound-out`.
- CSS attaches from XML `<styles><include src="file://{resources}/..."/></styles>`, not `<link>`/`@import`.

## Sources

- ModDota / API — `dump_panorama_css_properties` (canonical property names/descriptions/examples): https://github.com/ModDota/API/blob/master/dump/dump_panorama_css_properties.md
- Valve Developer Community — Panorama CSS Properties: https://developer.valvesoftware.com/wiki/Dota_2_Workshop_Tools/Panorama/CSS_Properties
- Valve Developer Community — Panorama Layout (flow-children, fill-parent-flow, alignment, selectors): https://developer.valvesoftware.com/wiki/Dota_2_Workshop_Tools/Panorama/Layout
- Valve Developer Community — CSGO Panorama CSS Properties (parallel reference, pseudo-classes): https://developer.valvesoftware.com/wiki/CSGO_Panorama_CSS_Properties
- ModDota — Button Examples (shipping CSS for pseudo-classes, gradients, transitions, box-shadow, brightness, sound): https://moddota.com/panorama/button-examples/
- ModDota — Introduction to Panorama UI with TypeScript (file model, flow-children, s2r:// usage, JS API): https://moddota.com/panorama/introduction-to-panorama-ui-with-typescript
- panorama-languages-support / vscode-panorama-css — gradient snippet syntax: https://github.com/panorama-languages-support/vscode-panorama-css

Local project files used for verbatim shipping examples:
- `c:\Users\work\dota2-workshop-mcp\src\data\docs\pages\panorama__button-examples.md`
- `c:\Users\work\dota2-workshop-mcp\src\data\docs\pages\panorama__introduction-to-panorama-ui-with-typescript.md`
- `c:\Users\work\dota2-workshop-mcp\src\data\panorama-api.json` (verified JS panel method signatures)
