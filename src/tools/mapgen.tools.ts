import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { resolveProject } from "../config.js";
import { requireDotaPaths, DotaPaths } from "../dota/paths.js";
import { AddonProject } from "../dota/project.js";
import { vmapToText, textToVmap, cloneVmap, compileVmap, buildEntityBlock, insertEntity, maxNodeId } from "../dota/vmap.js";
import { parseTileGrid, applyTileGrid, setHeight, setWater, setTileset, fill, tileToWorld, vIndex, cIndex, Shape } from "../dota/tilegrid.js";
import { parseKV, serializeKV, getWrapperBlock, findPair, upsertPair, objectToBlock, isBlock } from "../kv/index.js";
import { resolveDataPath } from "../util/datapath.js";
import { encodeRgbaPng } from "../util/png.js";
import { readTextFile, writeTextFile, pathExists } from "../util/fsx.js";
import { json, text, image, error, guard, ToolResult } from "../util/result.js";

const NAME_RE = /^[a-z][a-z0-9_]+$/;

function paths(dota: DotaPaths, project: AddonProject, name: string) {
  return {
    base: join(dota.contentDotaAddons, "addon_template", "maps", "template_map.vmap"),
    contentVmap: join(dota.contentDotaAddons, project.addonName, "maps", `${name}.vmap`),
    gameVpk: join(dota.gameDotaAddons, project.addonName, "maps", `${name}.vpk`),
    addoninfo: join(project.gameDir, "addoninfo.txt"),
  };
}

async function registerMap(addoninfoPath: string, name: string, maxPlayers: number): Promise<void> {
  const doc = (await pathExists(addoninfoPath))
    ? parseKV((await readTextFile(addoninfoPath)).text)
    : parseKV(`"AddonInfo"\n{\n\t"maps" ""\n\t"IsPlayable" "1"\n}\n`);
  const wrapper = getWrapperBlock(doc)!;
  const mapsPair = findPair(wrapper, "maps");
  const list = (mapsPair && !isBlock(mapsPair.value) ? (mapsPair.value as string) : "").split(/\s+/).filter(Boolean);
  if (!list.includes(name)) list.push(name);
  upsertPair(wrapper, "maps", list.join(" "));
  if (!findPair(wrapper, name)) upsertPair(wrapper, name, objectToBlock({ MaxPlayers: String(maxPlayers) }));
  await writeTextFile(addoninfoPath, serializeKV(doc), { encoding: "utf8" });
}

// Build a Shape from a loose JSON object.
function toShape(s: any): Shape {
  if (!s || typeof s !== "object") throw new Error("shape must be an object");
  switch (s.kind) {
    case "rect": return { kind: "rect", x0: +s.x0, y0: +s.y0, x1: +s.x1, y1: +s.y1 };
    case "circle": return { kind: "circle", cx: +s.cx, cy: +s.cy, r: +s.r };
    case "ring": return { kind: "ring", cx: +s.cx, cy: +s.cy, rInner: +s.rInner, rOuter: +s.rOuter };
    case "path": return { kind: "path", points: (s.points || []).map((p: number[]) => [+p[0], +p[1]] as [number, number]), width: +s.width };
    default: throw new Error(`unknown shape kind "${s.kind}" (rect|circle|ring|path)`);
  }
}

function applyTerrainOps(textIn: string, ops: any[], log: string[]): string {
  const g = parseTileGrid(textIn);
  log.push(`tile grid ${g.width}x${g.height} (origin ${g.origin.join(",")}, ${g.tileSize}u/tile)`);
  for (const op of ops) {
    if (op.op === "fill") {
      fill(g, { height: op.level, water: op.water, tileset: op.tileset });
      log.push(`fill height=${op.level ?? "-"} water=${op.water ?? "-"} tileset=${op.tileset ?? "-"}`);
      continue;
    }
    const shape = toShape(op.shape);
    if (op.op === "height") log.push(`height ${op.level} (${op.dome ? "dome" : "flat"}) -> ${setHeight(g, shape, +op.level, !!op.dome)} verts`);
    else if (op.op === "water") log.push(`water=${op.on !== false} (invert=${!!op.invert}) -> ${setWater(g, shape, op.on !== false, !!op.invert)} verts`);
    else if (op.op === "tileset") log.push(`tileset=${op.tileset} -> ${setTileset(g, shape, +op.tileset)} cells`);
    else throw new Error(`unknown terrain op "${op.op}" (height|water|tileset|fill)`);
  }
  return applyTileGrid(textIn, g);
}

function placeEntities(textIn: string, entities: any[], paths_: any[], log: string[]): string {
  let txt = textIn;
  let node = maxNodeId(txt);
  for (const e of entities ?? []) {
    txt = insertEntity(txt, buildEntityBlock({ classname: e.classname, origin: e.origin, angles: e.angles, properties: e.properties }, ++node));
    log.push(`entity ${e.classname} @ ${e.origin ?? "0 0 0"}`);
  }
  for (const p of paths_ ?? []) {
    const pts: number[][] = p.points || [];
    for (let i = 0; i < pts.length; i++) {
      const origin = pts[i].join(" ");
      const props: Record<string, string> = { targetname: `${p.name}_${i}` };
      if (i < pts.length - 1) props.target = `${p.name}_${i + 1}`;
      if (p.speed) props.speed = String(p.speed);
      txt = insertEntity(txt, buildEntityBlock({ classname: "path_track", origin, properties: props }, ++node));
    }
    log.push(`path "${p.name}": ${pts.length} waypoints (first node ${p.name}_0)`);
  }
  return txt;
}

export function registerMapGenTools(server: McpServer) {
  server.registerTool(
    "entity_catalog",
    {
      title: "Dota map entity catalog",
      description:
        "List the catalog of placeable Dota map entities (classname + purpose + key keyvalues), so you know what " +
        "objects exist for map_add_entity / map_build. Filter by query or category (spawn, marker, path, trigger, " +
        "logic, light, env, prop, dota, fx, vision, world).",
      inputSchema: { query: z.string().optional(), category: z.string().optional() },
    },
    guard(async ({ query, category }): Promise<ToolResult> => {
      const data = JSON.parse(await readFile(await resolveDataPath("entity-catalog.json"), "utf8"));
      let list = data.entities as { name: string; category: string; purpose: string; keyValues?: string }[];
      if (category) list = list.filter((e) => e.category.toLowerCase() === category.toLowerCase());
      if (query) {
        const q = query.toLowerCase();
        list = list.filter((e) => e.name.toLowerCase().includes(q) || e.purpose.toLowerCase().includes(q) || (e.keyValues ?? "").toLowerCase().includes(q));
      }
      return json(
        { count: list.length, entities: list },
        list.map((e) => `[${e.category}] ${e.name}\n    ${e.purpose}\n    keys: ${e.keyValues ?? "(position only)"}`).join("\n") || "No entities match.",
      );
    }),
  );

  server.registerTool(
    "map_terrain",
    {
      title: "Shape map terrain",
      description:
        "Apply terrain operations to a map's Dota tile grid. Coordinates are in TILE units (0..gridWidth, default grid " +
        "64x64; world = origin + tile*256). Ops: {op:'height', shape, level, dome?}, {op:'water', shape, on?, invert?}, " +
        "{op:'tileset', shape, tileset}, {op:'fill', level?, water?, tileset?}. Shapes: {kind:'rect',x0,y0,x1,y1}, " +
        "{kind:'circle',cx,cy,r}, {kind:'ring',cx,cy,rInner,rOuter}, {kind:'path',points:[[x,y]...],width}. heights are " +
        "integer levels (~0-3 typical). Recompile after (or pass recompile=true).",
      inputSchema: {
        projectRoot: z.string().optional(),
        map: z.string(),
        ops: z.array(z.any()).describe("Array of terrain ops (see description)."),
        recompile: z.boolean().optional(),
      },
    },
    guard(async ({ projectRoot, map, ops, recompile }): Promise<ToolResult> => {
      const dota = await requireDotaPaths();
      const project = await resolveProject(projectRoot);
      const p = paths(dota, project, map);
      if (!(await pathExists(p.contentVmap))) return error(`Map not found: ${p.contentVmap}. Create it with map_create or map_build.`);
      const log: string[] = [];
      const txt = applyTerrainOps(await vmapToText(dota.dmxconvertExe, p.contentVmap), ops, log);
      await textToVmap(dota.dmxconvertExe, txt, p.contentVmap);
      if (recompile) {
        const res = await compileVmap(dota.resourceCompilerExe, dota.dotaGameDir, p.contentVmap, p.gameVpk);
        log.push(res.code === 0 ? `recompiled -> ${p.gameVpk}` : `recompile FAILED (${res.code})`);
      }
      return json({ map, ops: ops.length }, log.join("\n"));
    }),
  );

  server.registerTool(
    "map_build",
    {
      title: "Build a map from a spec",
      description:
        "Generate a whole playable map in one call: clone the template, shape terrain, place entities, lay waypoint " +
        "paths, register it, and (optionally) compile. This is what a natural-language map request compiles down to. " +
        "Terrain coords are TILE units; entity/path coords are WORLD units (use map_tile_to_world math: world = -8192 + " +
        "tile*256). See map_terrain for terrain op/shape forms.",
      inputSchema: {
        projectRoot: z.string().optional(),
        name: z.string(),
        maxPlayers: z.number().int().min(1).max(24).optional(),
        terrain: z.array(z.any()).optional().describe("Terrain ops (tile coords)."),
        entities: z.array(z.any()).optional().describe("[{classname, origin:'x y z', angles?, properties?}] (world coords)."),
        paths: z.array(z.any()).optional().describe("[{name, points:[[x,y,z]...], speed?}] -> chained path_track waypoints (world coords)."),
        compile: z.boolean().optional(),
        overwrite: z.boolean().optional(),
      },
    },
    guard(async ({ projectRoot, name, maxPlayers, terrain, entities, paths: paths_, compile, overwrite }): Promise<ToolResult> => {
      if (!NAME_RE.test(name)) return error(`Invalid map name "${name}".`);
      const dota = await requireDotaPaths();
      const project = await resolveProject(projectRoot);
      const p = paths(dota, project, name);
      if (!(await pathExists(p.base))) return error(`Template base map not found: ${p.base}`);
      if ((await pathExists(p.contentVmap)) && !overwrite) return error(`Map "${name}" exists (pass overwrite=true).`);

      await cloneVmap(p.base, p.contentVmap);
      await registerMap(p.addoninfo, name, maxPlayers ?? 10);

      const log: string[] = [`cloned + registered "${name}"`];
      let txt = await vmapToText(dota.dmxconvertExe, p.contentVmap);
      if (terrain && terrain.length) txt = applyTerrainOps(txt, terrain, log);
      if ((entities && entities.length) || (paths_ && paths_.length)) txt = placeEntities(txt, entities ?? [], paths_ ?? [], log);
      await textToVmap(dota.dmxconvertExe, txt, p.contentVmap);

      if (compile) {
        const res = await compileVmap(dota.resourceCompilerExe, dota.dotaGameDir, p.contentVmap, p.gameVpk);
        const ok = res.code === 0 && (await pathExists(p.gameVpk));
        log.push(ok ? `compiled -> ${p.gameVpk}` : `compile FAILED (exit ${res.code})\n${res.stdout.slice(-1200)}`);
      } else {
        log.push(`Next: map_compile name="${name}", then addon_launch_custom_game map="${name}".`);
      }
      return json({ name, vmap: p.contentVmap }, log.join("\n"));
    }),
  );

  server.registerTool(
    "map_preview",
    {
      title: "Preview a map (top-down image)",
      description:
        "Render a top-down image of a map's terrain straight from the tile grid (water = blue, road/other tilesets = " +
        "tan, grass = green, shaded by height) — no game launch needed. The fast way to see how a generated layout looks.",
      inputSchema: { projectRoot: z.string().optional(), map: z.string(), scale: z.number().int().min(2).max(16).optional() },
    },
    guard(async ({ projectRoot, map, scale }): Promise<ToolResult> => {
      const dota = await requireDotaPaths();
      const project = await resolveProject(projectRoot);
      const p = paths(dota, project, map);
      if (!(await pathExists(p.contentVmap))) return error(`Map not found: ${p.contentVmap}.`);
      const g = parseTileGrid(await vmapToText(dota.dmxconvertExe, p.contentVmap));
      const px = Math.max(2, Math.min(16, scale ?? 8));
      const W = g.width * px, H = g.height * px;
      const img = Buffer.alloc(W * H * 4);
      const put = (x: number, y: number, r: number, gg: number, b: number) => {
        const i = (y * W + x) * 4;
        img[i] = r; img[i + 1] = gg; img[i + 2] = b; img[i + 3] = 255;
      };
      for (let cy = 0; cy < g.height; cy++) {
        for (let cx = 0; cx < g.width; cx++) {
          const corners = [vIndex(g, cx, cy), vIndex(g, cx + 1, cy), vIndex(g, cx, cy + 1), vIndex(g, cx + 1, cy + 1)];
          const waterN = corners.reduce((n, i) => n + g.water[i], 0);
          const hAvg = corners.reduce((s, i) => s + g.heights[i], 0) / 4;
          const tile = g.tileset[cIndex(g, cx, cy)];
          let r: number, gg: number, b: number;
          if (waterN >= 2) {
            r = 36; gg = 86; b = 140; // water
          } else if (tile !== 0) {
            r = 170; gg = 150; b = 110; // road / alt tileset
          } else {
            r = 70; gg = 120; b = 55; // grass
          }
          const shade = 1 + Math.max(-0.3, Math.min(0.6, hAvg * 0.18)); // height shading
          r = Math.min(255, r * shade) | 0; gg = Math.min(255, gg * shade) | 0; b = Math.min(255, b * shade) | 0;
          const oy = (g.height - 1 - cy) * px; // +y up
          const ox = cx * px;
          for (let yy = 0; yy < px; yy++) for (let xx = 0; xx < px; xx++) put(ox + xx, oy + yy, r, gg, b);
        }
      }
      const png = encodeRgbaPng(W, H, img);
      const stats = { width: W, height: H, grid: [g.width, g.height], waterVerts: g.water.filter((w) => w).length, raised: g.heights.filter((h) => h > 0).length, roadCells: g.tileset.filter((t) => t !== 0).length };
      return image(png.toString("base64"), "image/png", `Top-down preview of "${map}" (${W}x${H}). water=${stats.waterVerts} verts, raised=${stats.raised} verts, road=${stats.roadCells} cells.`);
    }),
  );

  server.registerTool(
    "scaffold_td",
    {
      title: "Scaffold a tower-defense director",
      description:
        "Generate a TypeScript tower-defense director vscript (waypoint table + declarative wave/boss table + wave " +
        "spawner + per-creep waypoint follower via ExecuteOrderFromTable + leak/lives) — the canonical Dota TD pattern. " +
        "Pair the waypoints with a map_build path. Call startTowerDefense() from your GameMode after the game starts.",
      inputSchema: {
        projectRoot: z.string().optional(),
        waypoints: z.array(z.array(z.number())).describe("Ordered creep path in WORLD coords [[x,y,z],...] (match a map_build path)."),
        waves: z.array(z.any()).optional().describe("[{creep, count, perSpawn?, boss?}] — default sample waves if omitted."),
        lives: z.number().int().optional(),
        overwrite: z.boolean().optional(),
      },
    },
    guard(async ({ projectRoot, waypoints, waves, lives, overwrite }): Promise<ToolResult> => {
      const project = await resolveProject(projectRoot);
      if (!project.tsVscriptsDir) return error("This project has no src/vscripts (not a TS template).");
      const wps = (waypoints || []).map((p) => `Vector(${p[0]}, ${p[1]}, ${p[2] ?? 128})`).join(",\n    ");
      const waveList = (waves && waves.length ? waves : [
        { creep: "npc_dota_creep_badguys_melee", count: 18, perSpawn: 3 },
        { creep: "npc_dota_creep_badguys_ranged", count: 21, perSpawn: 3 },
        { creep: "npc_dota_creep_badguys_melee", count: 1, perSpawn: 1, boss: true },
      ]).map((w: any) => `  { creep: "${w.creep}", count: ${w.count ?? 12}, perSpawn: ${w.perSpawn ?? 3}, boss: ${!!w.boss} }`).join(",\n");
      const ts = `// Tower-defense director — generated by dota2-workshop-mcp.
// Canonical pattern learned from shipping TD games: a waypoint table + declarative
// wave table + a spawner + a per-creep waypoint follower (ExecuteOrderFromTable
// MOVE_TO_POSITION, advancing on proximity) + leak/lives. Call startTowerDefense()
// from your GameMode once the game is in progress.

interface TdWave { creep: string; count: number; perSpawn: number; boss: boolean; }

const WAYPOINTS: Vector[] = [
    ${wps}
];

const WAVES: TdWave[] = [
${waveList}
];

let g_lives = ${lives ?? 50};
const ARRIVE_RADIUS = 150;
const SPAWN_INTERVAL = 0.6;
const WAVE_GAP = 12;

export function startTowerDefense(this: void): void {
    print("[TD] starting, " + WAVES.length + " waves, " + WAYPOINTS.length + " waypoints");
    spawnWave(0);
}

function spawnWave(this: void, index: number): void {
    const wave = WAVES[index];
    if (!wave) { print("[TD] all waves cleared!"); return; }
    let spawned = 0;
    Timers.CreateTimer(0, () => {
        for (let k = 0; k < wave.perSpawn && spawned < wave.count; k++) { spawnCreep(wave); spawned++; }
        if (spawned < wave.count) return SPAWN_INTERVAL;
        Timers.CreateTimer(WAVE_GAP, () => { spawnWave(index + 1); return undefined; });
        return undefined;
    });
}

function spawnCreep(this: void, wave: TdWave): void {
    const unit = CreateUnitByName(wave.creep, WAYPOINTS[0], true, undefined, undefined, DotaTeam.BADGUYS);
    unit.SetControllableByPlayer(-1, false);
    if (wave.boss) unit.SetModelScale(1.6);
    (unit as any).tdIndex = 1;
    advance(unit);
}

function advance(this: void, unit: CDOTA_BaseNPC): void {
    const i = (unit as any).tdIndex as number;
    if (i >= WAYPOINTS.length) { leak(unit); return; }
    ExecuteOrderFromTable({ UnitIndex: unit.entindex(), OrderType: UnitOrder.MOVE_TO_POSITION, Position: WAYPOINTS[i] });
    unit.SetContextThink("td_follow", () => {
        if (!IsValidEntity(unit) || !unit.IsAlive()) return undefined;
        if (((unit.GetAbsOrigin() - WAYPOINTS[i]) as Vector).Length2D() < ARRIVE_RADIUS) {
            (unit as any).tdIndex = i + 1;
            advance(unit);
            return undefined;
        }
        return 0.25;
    }, 0.25);
}

function leak(this: void, unit: CDOTA_BaseNPC): void {
    g_lives -= 1;
    print("[TD] leak! lives = " + g_lives);
    if (IsValidEntity(unit)) unit.RemoveSelf();
    if (g_lives <= 0) print("[TD] game over");
}
`;
      const file = join(project.tsVscriptsDir, "td", "td_director.ts");
      if ((await pathExists(file)) && !overwrite) return error(`${file} exists (pass overwrite=true).`);
      await writeTextFile(file, ts, { encoding: "utf8" });
      return json(
        { file, waypoints: (waypoints || []).length, waves: (waves && waves.length) || 3 },
        `Wrote ${file}\nCall it from GameMode: import { startTowerDefense } from "./td/td_director"; then startTowerDefense() once PRE_GAME/IN_PROGRESS. Requires the template's Timers lib. Run npm run build, then launch.`,
      );
    }),
  );

  server.registerTool(
    "map_tile_to_world",
    {
      title: "Tile→world coordinate helper",
      description: "Convert tile-grid coordinates to world units for a map (so terrain and entity positions line up).",
      inputSchema: { projectRoot: z.string().optional(), map: z.string(), tx: z.number(), ty: z.number() },
    },
    guard(async ({ projectRoot, map, tx, ty }): Promise<ToolResult> => {
      const dota = await requireDotaPaths();
      const project = await resolveProject(projectRoot);
      const p = paths(dota, project, map);
      if (!(await pathExists(p.contentVmap))) return error(`Map not found: ${p.contentVmap}.`);
      const g = parseTileGrid(await vmapToText(dota.dmxconvertExe, p.contentVmap));
      const [wx, wy] = tileToWorld(g, tx, ty);
      return json({ map, tile: [tx, ty], world: [wx, wy], grid: [g.width, g.height], tileSize: g.tileSize, origin: g.origin }, `tile (${tx},${ty}) -> world (${wx}, ${wy})  [grid ${g.width}x${g.height}, ${g.tileSize}u/tile]`);
    }),
  );
}
