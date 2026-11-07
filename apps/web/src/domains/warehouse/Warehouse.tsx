import type { WarehouseRun } from '@tv/core';
import { runner } from '../../runner';
import { Actors } from './Actors';
import { Facility } from './Facility';

export function Warehouse() {
  const world = (runner.run as WarehouseRun | null)?.world;
  if (!world) return null;
  return (
    <>
      <Facility world={world} />
      <Actors world={world} />
    </>
  );
}
