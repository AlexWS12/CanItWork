import { backToParent, linkBack, useDrill } from '../drill';
import { useStore } from '../store';
import './DrillBack.css';

/** While a design's part is open as a system of its own: where it came from, and the way back with what it learned. */
export function DrillBack() {
  const parent = useDrill((s) => s.parent);
  const building = useStore((s) => s.building);
  const domain = useStore((s) => s.environment?.domain);
  // The live reading changes as the schema is broken or fixed, so it is read on every tick.
  useStore((s) => s.telemetry.tick);
  if (!parent) return null;
  const link = !building && domain === 'database' ? linkBack() : null;
  return (
    <div className="drill-back" role="status">
      <span>
        Inside <b>{parent.label}</b>: this schema carries the {parent.rps.toLocaleString('en-US')} queries a second its database gets.
      </span>
      {link && (
        <span className="drill-link">
          Going back, {link.node.label ?? link.node.id} serves about {link.capacity.toLocaleString('en-US')} rps per replica at {link.latency} ms a query.
        </span>
      )}
      <button className="action" disabled={building} onClick={backToParent}>
        ← Back to {parent.label}
      </button>
    </div>
  );
}
