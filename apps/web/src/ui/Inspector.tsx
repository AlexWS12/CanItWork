import { breakThing } from '../actions';
import { runner } from '../runner';
import { useStore } from '../store';
import './Inspector.css';

export function Inspector() {
  const selected = useStore((s) => s.selected);
  useStore((s) => s.telemetry.tick);
  const set = useStore((s) => s.set);
  const view = selected ? runner.run?.inspect(selected) : null;
  if (!view) return null;
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
    </div>
  );
}
