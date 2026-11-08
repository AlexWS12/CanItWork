import { FLOOR } from '@tv/core';
import { useEffect } from 'react';
import { select, useStore } from '../../store';
import { useFloorEdit, type Placeable } from './drag';
import './FloorTools.css';

const KINDS: Array<[Placeable, string]> = [
  ['robot', 'Robot'],
  ['shelf', 'Shelf'],
  ['charger', 'Charger'],
];

/** Arms placement on the warehouse floor: pick what to add, then click the cell it goes on. */
export function FloorTools() {
  const warehouse = useStore((s) => s.environment?.domain === 'warehouse');
  const placing = useFloorEdit((s) => s.placing);
  const settingsOpen = useStore((s) => s.selected === FLOOR);

  useEffect(() => {
    if (!placing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useFloorEdit.setState({ placing: null, ghost: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [placing]);

  // A new design starts with nothing armed
  useEffect(() => () => useFloorEdit.setState({ placing: null, ghost: null }), [warehouse]);

  if (!warehouse) return null;
  return (
    <div className="floor-tools" role="toolbar" aria-label="Add to the floor">
      <span className="kicker">Add</span>
      {KINDS.map(([kind, label]) => (
        <button key={kind} aria-pressed={placing === kind} onClick={() => useFloorEdit.setState({ placing: placing === kind ? null : kind, ghost: null })}>
          {label}
        </button>
      ))}
      <span className="floor-tools-divider" aria-hidden />
      <button aria-pressed={settingsOpen} onClick={() => select(settingsOpen ? null : FLOOR)}>
        Settings
      </button>
      {placing && <span className="floor-tools-hint">Click a floor cell · Esc to cancel</span>}
    </div>
  );
}
