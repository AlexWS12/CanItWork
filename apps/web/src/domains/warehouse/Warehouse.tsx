import type { WarehouseRun } from '@tv/core';
import { useMemo } from 'react';
import { runner } from '../../runner';
import { useStore } from '../../store';
import { Actors } from './Actors';
import { Facility } from './Facility';

export function Warehouse() {
  useStore((s) => s.structure);
  const run = runner.run as WarehouseRun | null;
  const structure = useStore.getState().structure;
  // Hand edits move things on the run's floor in place, so each change gets a fresh copy for the view to redraw from.
  const world = useMemo(
    () => (run ? { ...run.world, shelves: run.world.shelves.map((s) => ({ ...s })), chargers: run.world.chargers.map((c) => ({ ...c })) } : null),
    [run, structure],
  );
  if (!world) return null;
  return (
    <>
      <Facility world={world} />
      <Actors world={world} />
    </>
  );
}
