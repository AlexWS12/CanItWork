import { componentIds, isEditable, settingPatch, type Setting } from '@tv/core';
import { useEffect, useState } from 'react';
import { breakThing, editComponent, editFloor } from '../actions';
import { runner } from '../runner';
import { useStore } from '../store';
import './Inspector.css';

const isMac = /mac|iphone|ipad/i.test(navigator.platform);

export function Inspector() {
  const selected = useStore((s) => s.selected);
  useStore((s) => s.telemetry.tick);
  // A hand edit on a paused run changes what's shown without moving the clock
  useStore((s) => s.structure);
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
      {view.settings?.length ? (
        <div className="settings">
          {view.settings.map((setting) => (
            <SettingControl key={setting.label} setting={setting} disabled={busy} onChange={(value) => setRefusal(editFloor([settingPatch(setting, value)]))} />
          ))}
          {/* With edit buttons below, the refusal shows once, under them */}
          {refusal && !view.edits?.length && (
            <p className="edit-hint edit-refusal" role="alert">
              {refusal}
            </p>
          )}
        </div>
      ) : null}
      {view.edits?.length ? (
        <div className="edit-actions floor-edits">
          {view.edits.map((edit) => (
            <button
              key={edit.label}
              className={edit.destructive ? 'action danger' : 'action'}
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
          {(refusal ?? view.editHint) && (
            <p className={refusal ? 'edit-hint edit-refusal' : 'edit-hint'} role={refusal ? 'alert' : undefined}>
              {refusal ?? view.editHint}
            </p>
          )}
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

/** One setting the design runs with. A slider sends its value once it's let go, so a drag is one change in the log. */
function SettingControl({ setting, disabled, onChange }: { setting: Setting; disabled: boolean; onChange: (value: string | number) => void }) {
  const [draft, setDraft] = useState<number | null>(null);
  const id = `setting-${setting.key}`;
  if (setting.kind === 'choice') {
    return (
      <div className="setting" role="group" aria-labelledby={id}>
        <span id={id} className="setting-label">
          {setting.label}
        </span>
        <div className="setting-choices">
          {setting.options.map((option) => (
            <button key={option.value} aria-pressed={setting.value === option.value} disabled={disabled} onClick={() => setting.value !== option.value && onChange(option.value)}>
              {option.label}
            </button>
          ))}
        </div>
        {setting.hint && <p className="setting-hint">{setting.hint}</p>}
      </div>
    );
  }
  const shown = draft ?? setting.value;
  const commit = () => {
    if (draft !== null && draft !== setting.value) onChange(draft);
    setDraft(null);
  };
  return (
    <div className="setting">
      <label htmlFor={id} className="setting-label">
        {setting.label}
        <output htmlFor={id}>
          {shown}
          {setting.unit}
        </output>
      </label>
      <input
        id={id}
        type="range"
        min={setting.min}
        max={setting.max}
        step={setting.step}
        value={shown}
        disabled={disabled}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      {setting.hint && <p className="setting-hint">{setting.hint}</p>}
    </div>
  );
}
