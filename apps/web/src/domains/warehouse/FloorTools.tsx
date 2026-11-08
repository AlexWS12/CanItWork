import { SYSTEM } from '@tv/core';
import { useEffect } from 'react';
import { runner } from '../../runner';
import { select, useStore } from '../../store';
import { useFloorEdit, type Placeable } from './drag';
import './FloorTools.css';

const KINDS: Array<[Placeable, string]> = [
  ['robot', 'Robot'],
  ['shelf', 'Shelf'],
  ['charger', 'Charger'],
];

/**
 * Hand edits above the 3D view. Every design that has system-wide settings gets a Settings button; a warehouse also gets
 * Add, which arms placement: pick what to add, then click the cell it goes on.
 */
export function FloorTools() {
  const domain = useStore((s) => s.environment?.domain);
  // A new run, or an edit, can change whether there are settings to show
  useStore((s) => s.structure);
  const warehouse = domain === 'warehouse';
  const placing = useFloorEdit((s) => s.placing);
  const settingsOpen = useStore((s) => s.selected === SYSTEM);
  const hasSettings = Boolean(domain && runner.run?.inspect(SYSTEM)?.settings?.length);

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

  if (!warehouse && !hasSettings) return null;
  return (
    <div className="floor-tools" role="toolbar" aria-label={warehouse ? 'Add to the floor' : 'Edit the design'}>
      {warehouse && (
        <>
          <span className="kicker">Add</span>
          {KINDS.map(([kind, label]) => (
            <button key={kind} aria-pressed={placing === kind} onClick={() => useFloorEdit.setState({ placing: placing === kind ? null : kind, ghost: null })}>
              {label}
            </button>
          ))}
          {hasSettings && <span className="floor-tools-divider" aria-hidden />}
        </>
      )}
      {hasSettings && (
        <button aria-pressed={settingsOpen} onClick={() => select(settingsOpen ? null : SYSTEM)}>
          Settings
        </button>
      )}
      {placing && <span className="floor-tools-hint">Click a floor cell · Esc to cancel</span>}
    </div>
  );
}
