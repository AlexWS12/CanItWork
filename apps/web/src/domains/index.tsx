import { DOMAINS, type CircuitSpec, type DatabaseSpec, type DomainId, type Environment, type SystemSpec, type World } from '@tv/core';
import type { ComponentType } from 'react';
import { Schema, schemaExtent } from './database/Schema';
import { Bench, benchExtent } from './electronics/Bench';
import { Topology } from './software/Topology';
import { Warehouse } from './warehouse/Warehouse';

interface View {
  Scene: ComponentType;
  camera(environment: Environment): [number, number, number];
}

const tilted = (span: number): [number, number, number] => [-span * 0.1, span * 0.78, span * 0.78];

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
      const { width, depth } = benchExtent(environment.spec as CircuitSpec);
      const distance = Math.max(width / 0.44, depth / 0.46, 26);
      return [0, distance * 0.84, distance * 0.54];
    },
  },
  software: {
    Scene: Topology,
    camera(environment) {
      const nodes = (environment.spec as SystemSpec).nodes.length;
      return tilted(46 + nodes * 1.8);
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
};
