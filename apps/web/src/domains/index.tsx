import type { DomainId } from '@tv/core';
import type { ComponentType } from 'react';
import { Schema } from './database/Schema';
import { Bench } from './electronics/Bench';
import { Fleet } from './fleet/Fleet';
import { Network } from './network/Network';
import { Queues } from './queues/Queues';
import { Topology } from './software/Topology';
import { Warehouse } from './warehouse/Warehouse';

interface View {
  Scene: ComponentType;
  /** The angle the camera looks from, as a direction from the system's centre; the stage backs off along it until the system fits. */
  direction: [number, number, number];
}

// A three-quarter view from the front left, for systems spread over a floor
const tilted: [number, number, number] = [-0.1, 0.78, 0.78];

/** Every flow-network domain shares one scene. */
const network: View = { Scene: Network, direction: tilted };

export const VIEWS: Record<DomainId, View> = {
  warehouse: { Scene: Warehouse, direction: tilted },
  // A circuit is read from above, like a bench
  electronics: { Scene: Bench, direction: [0, 0.84, 0.54] },
  software: { Scene: Topology, direction: tilted },
  fleet: { Scene: Fleet, direction: tilted },
  // Table cards lie flat, so they are read almost straight down
  database: { Scene: Schema, direction: [0, 0.94, 0.34] },
  queues: { Scene: Queues, direction: tilted },
  power: network,
  water: network,
  supply: network,
  hospital: network,
  factory: network,
  airport: network,
  callcenter: network,
};
