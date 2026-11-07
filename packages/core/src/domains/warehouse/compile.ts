import type { Cell, Charger, Conveyor, Dock, RobotDef, Shelf, World, WorldSpec } from './schema';

const ROBOT_NAMES = ['Ada', 'Bolt', 'Cleo', 'Dash', 'Echo', 'Finn', 'Gus', 'Hal', 'Iris', 'Juno', 'Kit', 'Lux'];
const WEST_MARGIN = 4;
const BLOCK_WIDTH = 4;
const SORT_HALL = 7;
const STATION_SPOTS = [
  [0.15, 0.5, 0.85],
  [0.32, 0.67, 0.97],
];

export function robotName(index: number) {
  return ROBOT_NAMES[index % ROBOT_NAMES.length] + (index >= ROBOT_NAMES.length ? ` ${index}` : '');
}

export function compileWorld(spec: WorldSpec): World {
  const shelfTop = 3;
  const shelfBottom = shelfTop + spec.shelvesPerAisle - 1;
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
      const y = shelfTop + i;
      shelves.push({ id: `S${shelves.length + 1}`, x: x0, y, access: { x: x0 - 1, y }, owner: '' });
      shelves.push({ id: `S${shelves.length + 1}`, x: x0 + 1, y, access: { x: x0 + 2, y }, owner: '' });
    }
  }

  const robots: RobotDef[] = Array.from({ length: spec.robots }, (_, i) => ({
    id: `R${i + 1}`,
    name: robotName(i),
    home: { x: WEST_MARGIN + i * 2, y: 0 },
  }));
  shelves.forEach((shelf, i) => {
    shelf.owner = robots[Math.floor((i / shelves.length) * robots.length)].id;
  });

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
    const y = shelfTop + i * 2;
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

  const tripEstimate = spec.aisles * BLOCK_WIDTH + spec.shelvesPerAisle + 22;
  const load = { light: 0.9, steady: 1.3, heavy: 1.8 }[spec.demand];

  return {
    schema: 1,
    spec,
    cols,
    rows,
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
