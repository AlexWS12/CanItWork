import { useStore } from '../store';
import './MobileNav.css';

const VIEWS = [
  ['scene', 'Scene'],
  ['chat', 'Chat'],
  ['agents', 'Agents'],
] as const;

/* Only shown on narrow screens, where the panels can't sit beside the scene */
export function MobileNav() {
  const view = useStore((s) => s.view);
  const set = useStore((s) => s.set);
  return (
    <nav className="mobile-nav" aria-label="View">
      {VIEWS.map(([id, label]) => (
        <button key={id} aria-pressed={view === id} onClick={() => set({ view: id })}>
          {label}
        </button>
      ))}
    </nav>
  );
}
