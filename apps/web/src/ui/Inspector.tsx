import { componentIds, isEditable } from '@tv/core';
import { useEffect, useState } from 'react';
import { breakThing, editComponent, editFloor } from '../actions';
import { runner } from '../runner';
import { useStore } from '../store';
import './Inspector.css';

const isMac = /mac|iphone|ipad/i.test(navigator.platform);

export function Inspector() {
  const selected = useStore((s) => s.selected);
  useStore((s) => s.telemetry.tick);
  const set = useStore((s) => s.set);
  const environment = useStore((s) => s.environment);
  const busy = useStore((s) => s.editing || s.chatting);
  // Why the last hand edit from here was refused, until something else is selected
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(() => setRefusal(null), [selected]);
  // Links and parts a patch added at runtime aren't in the spec, so only spec components can be edited
  const editable = Boolean(environment && selected && isEditable(environment.domain) && componentIds(environment.domain, environment.spec).includes(selected));

  useEffect(() => {
    if (!editable || !selected) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        void editComponent({ op: 'remove', id: selected });
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        void editComponent({ op: 'duplicate', id: selected });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editable, selected]);

  const view = selected ? runner.run?.inspect(selected) : null;
  if (!view || !selected) return null;
  return (
    <div className="inspector">
      <header>
        <h3>{view.title}</h3>
        <button aria-label="Close" onClick={() => set({ selected: null })}>
          ×
        </button>
      </header>
      <dl>
        {view.rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {view.actions.map((action) => (
        <button
          key={action.label}
          className={action.destructive ? 'action danger' : 'action'}
          onClick={() => (action.destructive ? void breakThing(action.incident) : runner.inject(action.incident))}
        >
          {action.label}
        </button>
      ))}
      {view.edits?.length ? (
        <div className="edit-actions floor-edits">
          {view.edits.map((edit) => (
            <button
              key={edit.label}
              className="action danger"
              disabled={busy}
              onClick={() => {
                const reason = editFloor(edit.patches);
                setRefusal(reason);
                // A deleted thing has nothing left to inspect
                if (!reason && !runner.run?.inspect(selected)) set({ selected: null });
              }}
            >
              {edit.label}
            </button>
          ))}
          <p className={refusal ? 'edit-hint edit-refusal' : 'edit-hint'} role={refusal ? 'alert' : undefined}>
            {refusal ?? 'Drag it to move it on the floor.'}
          </p>
        </div>
      ) : null}
      {editable && (
        <div className="edit-actions">
          <button className="action" disabled={busy} onClick={() => void editComponent({ op: 'duplicate', id: selected })} title={`Duplicate (${isMac ? '⌘' : 'Ctrl+'}D)`}>
            Duplicate
          </button>
          <button className="action" disabled={busy} onClick={() => void editComponent({ op: 'remove', id: selected })} title="Delete (Delete key)">
            Delete
          </button>
          <p className="edit-hint">Drag to move. The agents check every duplicate or delete.</p>
        </div>
      )}
    </div>
  );
}
