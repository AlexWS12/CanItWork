import { DOMAINS, type CircuitSpec, type DatabaseSpec, type DomainId, type Environment, type NetSpec, type SystemSpec, type World } from '@tv/core';
import type { ComponentType } from 'react';
import { Schema, schemaExtent } from './database/Schema';
import { Bench, benchExtent } from './electronics/Bench';
import { Network, networkExtent } from './network/Network';
import { Queues, queuesExtent, towerFocus } from './queues/Queues';
import { Fleet } from './fleet/Fleet';
import { Topology, topologyExtent } from './software/Topology';
import { Warehouse } from './warehouse/Warehouse';

interface View {
  Scene: ComponentType;
  camera(environment: Environment): [number, number, number];
  /** Where the camera looks, the origin unless a scene is tall or off-centre. The camera position is relative to it. */
  target?(environment: Environment): [number, number, number];
}

const tilted = (span: number): [number, number, number] => [-span * 0.1, span * 0.78, span * 0.78];

/** Every flow-network domain shares one scene, framed to the network's size. */
const network: View = {
  Scene: Network,
  camera(environment) {
    const { width, depth } = networkExtent(environment.spec as NetSpec);
    return tilted(Math.max(40, width * 1.05, depth * 1.6));
  },
};

export const VIEWS: Record<DomainId, View> = {
  warehouse: {
    Scene: Warehouse,
    camera(environment) {
      const world = DOMAINS.warehouse.compile(environment.spec) as World;
      return tilted(Math.max(world.cols, world.rows * 1.7) * 2);
    },
  },
  electronics: {
    Scene: Bench,
    camera(environment) {
      const { width, depth } = benchExtent(DOMAINS.electronics.compile(environment.spec) as CircuitSpec);
      // Several breadboards need more room between the side panels.
      const wide = width > 30;
      const distance = Math.max(width / (wide ? 0.3 : 0.44), depth / (wide ? 0.38 : 0.46), 26);
      return [0, distance * 0.84, distance * 0.54];
    },
  },
  software: {
    Scene: Topology,
    camera(environment) {
      const spec = environment.spec as SystemSpec;
      const { width, depth } = topologyExtent(spec);
      // The side panels leave about half the screen clear, so frame the layout's full width and depth inside it.
      return tilted(Math.max(46 + spec.nodes.length * 1.8, (width + 8) * 2, (depth + 6) * 2.4));
    },
  },
  fleet: {
    Scene: Fleet,
    camera() {
      return tilted(68);
    },
  },
  database: {
    Scene: Schema,
    camera(environment) {
      const { width, depth } = schemaExtent(environment.spec as DatabaseSpec);
      const distance = Math.max(width / 0.55, depth / 0.44, 22);
      return [0, distance * 0.94, distance * 0.34];
    },
  },
  power: network,
  queues: {
    Scene: Queues,
    camera(environment) {
      const spec = environment.spec as NetSpec;
      const { width, depth } = queuesExtent(spec);
      // A tower needs the camera far enough back to see its top floor.
      const tall = (towerFocus(environment)?.height ?? 0) * 2.3;
      return tilted(Math.max(26, width * 0.95, depth * 1.4, tall));
    },
    target(environment) {
      const focus = towerFocus(environment);
      return focus ? [focus.x * 0.5, focus.height * 0.38, focus.z * 0.5] : [0, 0, 0];
    },
  },
  water: network,
  supply: network,
  hospital: network,
  factory: network,
  airport: network,
  callcenter: network,
};
