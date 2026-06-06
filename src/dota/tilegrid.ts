// Programmatic terrain authoring for the Dota tile grid (CMapDotaTileGrid).
//
// The ground is a grid of W x H cells with (W+1) x (H+1) vertices. We parse the
// editable arrays out of a vmap's kv2 text, mutate them with shape ops (rect / circle /
// ring / path-stroke), and write them back. Verified: heights + water render in-game.
//
// Coordinates: tile space. Vertex (vx,vy) in [0..W] x [0..H]; cell (cx,cy) in
// [0..W-1] x [0..H-1]. World = origin + tile * tileSize (tileSize defaults to 256u:
// the template grid spans 16384u over 64 tiles).

export interface TileGrid {
  width: number; // cells X (gridWidth)
  height: number; // cells Y (gridHeight)
  vw: number; // vertices X = width+1
  vh: number; // vertices Y = height+1
  origin: [number, number, number];
  tileSize: number;
  heights: number[]; // length vw*vh, integer levels
  water: number[]; // length vw*vh, 0/1
  tileset: number[]; // length width*height, index into tileSetMapInfo
}

const TILE_SIZE = 256;

function intArray(text: string, key: string): number[] | null {
  const m = text.match(new RegExp('"' + key + '" "int_array"\\s*\\[([\\s\\S]*?)\\]'));
  return m ? (m[1].match(/-?\d+/g) || []).map(Number) : null;
}
function boolArray(text: string, key: string): number[] | null {
  const m = text.match(new RegExp('"' + key + '" "bool_array"\\s*\\[([\\s\\S]*?)\\]'));
  return m ? (m[1].match(/\b[01]\b|true|false/g) || []).map((v) => (v === "1" || v === "true" ? 1 : 0)) : null;
}

export function parseTileGrid(text: string): TileGrid {
  const gw = text.match(/"gridWidth" "int" "(\d+)"/);
  const gh = text.match(/"gridHeight" "int" "(\d+)"/);
  if (!gw || !gh) throw new Error("No CMapDotaTileGrid (gridWidth/Height) found in this map.");
  const width = Number(gw[1]);
  const height = Number(gh[1]);
  const om = text.match(/"CMapDotaTileGrid"[\s\S]*?"origin" "vector3" "([^"]+)"/);
  const origin = (om ? om[1].split(/\s+/).map(Number) : [0, 0, 0]) as [number, number, number];
  const heights = intArray(text, "verticesHeight");
  const water = boolArray(text, "verticesWater");
  const tileset = intArray(text, "cellsTileSet");
  if (!heights || !water || !tileset) throw new Error("Tile grid arrays missing (verticesHeight/verticesWater/cellsTileSet).");
  return { width, height, vw: width + 1, vh: height + 1, origin, tileSize: TILE_SIZE, heights, water, tileset };
}

export function applyTileGrid(text: string, g: TileGrid): string {
  const repl = (key: string, type: string, vals: number[]) =>
    text.replace(
      new RegExp('("' + key + '" "' + type + '"\\s*\\[)[\\s\\S]*?(\\])'),
      "$1\n" + vals.map((v) => '"' + v + '"').join(",\n") + "\n$2",
    );
  text = repl("verticesHeight", "int_array", g.heights);
  text = repl("verticesWater", "bool_array", g.water);
  text = repl("cellsTileSet", "int_array", g.tileset);
  return text;
}

// --- index helpers ---
export const vIndex = (g: TileGrid, vx: number, vy: number) => vy * g.vw + vx;
export const cIndex = (g: TileGrid, cx: number, cy: number) => cy * g.width + cx;
export function tileToWorld(g: TileGrid, vx: number, vy: number): [number, number] {
  return [g.origin[0] + vx * g.tileSize, g.origin[1] + vy * g.tileSize];
}

// --- shape predicates over a coordinate (in tile units) ---
export type Shape =
  | { kind: "rect"; x0: number; y0: number; x1: number; y1: number }
  | { kind: "circle"; cx: number; cy: number; r: number }
  | { kind: "ring"; cx: number; cy: number; rInner: number; rOuter: number }
  | { kind: "path"; points: [number, number][]; width: number };

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function inShape(s: Shape, x: number, y: number): boolean {
  switch (s.kind) {
    case "rect":
      return x >= Math.min(s.x0, s.x1) && x <= Math.max(s.x0, s.x1) && y >= Math.min(s.y0, s.y1) && y <= Math.max(s.y0, s.y1);
    case "circle":
      return Math.hypot(x - s.cx, y - s.cy) <= s.r;
    case "ring": {
      const d = Math.hypot(x - s.cx, y - s.cy);
      return d >= s.rInner && d <= s.rOuter;
    }
    case "path": {
      for (let i = 0; i < s.points.length - 1; i++) {
        if (distToSegment(x, y, s.points[i][0], s.points[i][1], s.points[i + 1][0], s.points[i + 1][1]) <= s.width / 2) return true;
      }
      return false;
    }
  }
}

// --- region operations ---
/** Set vertex height for all vertices inside the shape (optionally a domed peak for circles). */
export function setHeight(g: TileGrid, shape: Shape, level: number, dome = false): number {
  let n = 0;
  for (let vy = 0; vy < g.vh; vy++) {
    for (let vx = 0; vx < g.vw; vx++) {
      if (!inShape(shape, vx, vy)) continue;
      let h = level;
      if (dome && shape.kind === "circle") {
        const d = Math.hypot(vx - shape.cx, vy - shape.cy);
        h = Math.round(((shape.r - d) / shape.r) * level);
      }
      g.heights[vIndex(g, vx, vy)] = h;
      n++;
    }
  }
  return n;
}

/** Toggle water for vertices inside (or, with invert, outside) the shape. */
export function setWater(g: TileGrid, shape: Shape, on: boolean, invert = false): number {
  let n = 0;
  for (let vy = 0; vy < g.vh; vy++) {
    for (let vx = 0; vx < g.vw; vx++) {
      const inside = inShape(shape, vx, vy);
      if (invert ? inside : !inside) continue;
      g.water[vIndex(g, vx, vy)] = on ? 1 : 0;
      n++;
    }
  }
  return n;
}

/** Paint a tileset index onto cells inside the shape (cell center tested). */
export function setTileset(g: TileGrid, shape: Shape, tilesetIndex: number): number {
  let n = 0;
  for (let cy = 0; cy < g.height; cy++) {
    for (let cx = 0; cx < g.width; cx++) {
      if (!inShape(shape, cx + 0.5, cy + 0.5)) continue;
      g.tileset[cIndex(g, cx, cy)] = tilesetIndex;
      n++;
    }
  }
  return n;
}

/** Fill the whole grid to a height/water baseline (e.g. all water for an ocean). */
export function fill(g: TileGrid, opts: { height?: number; water?: boolean; tileset?: number }): void {
  if (opts.height !== undefined) g.heights.fill(opts.height);
  if (opts.water !== undefined) g.water.fill(opts.water ? 1 : 0);
  if (opts.tileset !== undefined) g.tileset.fill(opts.tileset);
}
