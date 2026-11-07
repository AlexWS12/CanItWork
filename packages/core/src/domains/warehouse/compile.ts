import type { Cell, Charger, Conveyor, Dock, FloorShape, RobotDef, Shelf, World, WorldSpec, ZoneArea } from './schema';

const ROBOT_NAMES = ['Ada', 'Bolt', 'Cleo', 'Dash', 'Echo', 'Finn', 'Gus', 'Hal', 'Iris', 'Juno', 'Kit', 'Lux'];
const WEST_MARGIN = 4;
const BLOCK_WIDTH = 4;
const SORT_HALL = 7;
const WING_DEPTH = 4;
const STATION_SPOTS = [
  [0.15, 0.5, 0.85],
  [0.32, 0.67, 0.97],
];

export function robotName(index: number) {
  return ROBOT_NAMES[index % ROBOT_NAMES.length] + (index >= ROBOT_NAMES.length ? ` ${index}` : '');
}

/** U and T need a wing on each side of the cut-out, so below this they compile as rectangles. */
export const MIN_AISLES_FOR_SHAPE: Record<FloorShape, number> = { rect: 1, L: 1, U: 3, T: 3 };

/**
 * How many rows each part of the floor gives up to the outside at its north end.
 * Aisle blocks that give rows up keep all their shelves and shift south, so every shape
 * holds the same stock as the rectangle; only the distances robots travel change.
 */
function cutouts(shape: FloorShape, aisles: number) {
  const blocks = new Array<number>(aisles).fill(0);
  let west = 0;
  let east = 0;
  if (aisles < MIN_AISLES_FOR_SHAPE[shape]) return { blocks, west, east };
  if (shape === 'L') {
    for (let b = Math.ceil(aisles / 2); b < aisles; b++) blocks[b] = WING_DEPTH;
    east = WING_DEPTH;
  } else if (shape === 'U') {
    for (let b = 1; b < aisles - 1; b++) blocks[b] = WING_DEPTH;
  } else if (shape === 'T') {
    blocks[0] = blocks[aisles - 1] = WING_DEPTH;
    west = east = WING_DEPTH;
  }
  return { blocks, west, east };
}

export function compileWorld(spec: WorldSpec): World {
  const cut = cutouts(spec.shape ?? 'rect', spec.aisles);
  const hallX = WEST_MARGIN + spec.aisles * BLOCK_WIDTH - 1;
  const blockOf = (x: number) => Math.floor((x - WEST_MARGIN + 1) / BLOCK_WIDTH);
  const topOf = (x: number) => (x < WEST_MARGIN - 1 ? cut.west : x >= hallX ? cut.east : cut.blocks[blockOf(x)]);
  const drop = Math.max(0, ...cut.blocks);

  const shelfTop = 3;
  const shelfBottom = shelfTop + drop + spec.shelvesPerAisle - 1;
  const crossSouth = shelfBottom + 1;
  const beltY = crossSouth + 2;
  const beltYs = spec.conveyors === 2 ? [beltY, beltY + 1] : [beltY];
  const rows = beltYs[beltYs.length - 1] + 2;
  const sorterX = WEST_MARGIN + spec.aisles * BLOCK_WIDTH + 2;
  const cols = sorterX + SORT_HALL;

  const shelves: Shelf[] = [];
  for (let block = 0; block < spec.aisles; block++) {
    const x0 = WEST_MARGIN + block * BLOCK_WIDTH;
    for (let i = 0; i < spec.shelvesPerAisle; i++) {
      const y = shelfTop + cut.blocks[block] + i;
      shelves.push({ id: `S${shelves.length + 1}`, x: x0, y, access: { x: x0 - 1, y }, owner: '' });
      shelves.push({ id: `S${shelves.length + 1}`, x: x0 + 1, y, access: { x: x0 + 2, y }, owner: '' });
    }
  }

  const robots: RobotDef[] = Array.from({ length: spec.robots }, (_, i) => {
    const x = WEST_MARGIN + i * 2;
    return { id: `R${i + 1}`, name: robotName(i), home: { x, y: topOf(x) } };
  });
  shelves.forEach((shelf, i) => {
    shelf.owner = robots[Math.floor((i / shelves.length) * robots.length)].id;
  });

  const zones: ZoneArea[] = [];
  let nextBlock = 0;
  for (const zone of spec.zones ?? []) {
    const first = nextBlock;
    const last = Math.min(spec.aisles, nextBlock + zone.aisles) - 1;
    nextBlock += zone.aisles;
    if (first > last) continue;
    const x = WEST_MARGIN - 1 + first * BLOCK_WIDTH;
    const w = (last - first + 1) * BLOCK_WIDTH;
    const y = shelfTop + Math.min(...cut.blocks.slice(first, last + 1));
    const area: ZoneArea = { name: zone.name, x, y, w, h: shelfBottom - y + 1 };
    if (zone.share !== undefined) area.share = zone.share;
    zones.push(area);
    for (const shelf of shelves) if (shelf.x >= x && shelf.x < x + w) shelf.zone = zone.name;
  }

  const conveyors: Conveyor[] = beltYs.map((y, i) => {
    const path: Cell[] = [];
    for (let x = WEST_MARGIN; x < sorterX; x++) path.push({ x, y });
    const stations = STATION_SPOTS[i].map((f) => {
      const index = Math.floor(f * (path.length - 1));
      return { x: path[index].x, y: beltY - 1, index };
    });
    return { id: `C${i + 1}`, path, stations };
  });

  const chargers: Charger[] = Array.from({ length: spec.chargers }, (_, i) => {
    const y = shelfTop + cut.west + i * 2;
    return { id: `E${i + 1}`, x: 0, y, bay: { x: 1, y } };
  });

  const sorterH = spec.conveyors === 2 ? 4 : 3;
  const sorterY = beltY - 1;
  const sorter = {
    id: 'SORT',
    x: sorterX,
    y: sorterY,
    w: 3,
    h: sorterH,
    bypass: { x: sorterX + 1, y: sorterY - 1 },
  };

  const docks: Dock[] = Array.from({ length: spec.docks }, (_, i) => ({
    id: `D${i + 1}`,
    x: cols - 1,
    y: Math.max(0, Math.min(rows - 1, sorterY + 1 + (i - (spec.docks - 1) / 2) * 2)) | 0,
  }));

  const walls: Cell[] = [];
  for (let x = 0; x < cols; x++) for (let y = 0; y < topOf(x); y++) walls.push({ x, y });

  const tripEstimate = spec.aisles * BLOCK_WIDTH + spec.shelvesPerAisle + drop + 22;
  const load = { light: 0.9, steady: 1.3, heavy: 1.8 }[spec.demand];

  return {
    schema: 1,
    spec,
    cols,
    rows,
    walls,
    zones,
    robots,
    shelves,
    conveyors,
    chargers,
    sorter,
    docks,
    params: {
      orderEvery: Math.max(1, Math.round(tripEstimate / spec.robots / load)),
      pickTicks: 5,
      dropTicks: 2,
      beltTicks: 1,
      sortTicks: 2,
      chuteTicks: 8,
      batteryCapacity: 900,
      chargePerTick: 9,
    },
    policy: { dispatch: spec.dispatch, chargeThreshold: 0.25, conveyorBypass: false },
  };
}

export const DEFAULT_SPEC: WorldSpec = {
  robots: 3,
  aisles: 3,
  shelvesPerAisle: 7,
  conveyors: 1,
  chargers: 1,
  docks: 3,
  demand: 'steady',
  dispatch: 'zoned',
};
