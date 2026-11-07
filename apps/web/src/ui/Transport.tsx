import { breakThing } from '../actions';
import { runner } from '../runner';
import { useStore } from '../store';
import { Sparkline } from './Charts';
import './Transport.css';

export function Transport() {
  const t = useStore((s) => s.telemetry);
  const environment = useStore((s) => s.environment);
  if (!environment) return null;
  return (
    <footer className="transport">
      <div className="controls">
        <button className="play" onClick={() => runner.toggle()} aria-label={t.running ? 'Pause' : 'Play'}>
          {t.running ? 'Pause' : 'Play'}
        </button>
        {[1, 2, 4].map((speed) => (
          <button key={speed} aria-pressed={t.speed === speed} onClick={() => runner.setSpeed(speed)}>
            {speed}x
          </button>
        ))}
        <span className="tick">t {t.tick}</span>
      </div>
      <div className="stats">
        {t.stats.map((stat) => (
          <div key={stat.label} className="stat" data-tone={stat.tone}>
            <b>{stat.value}</b>
            <span>{stat.label}</span>
          </div>
        ))}
        <Sparkline values={t.history} />
      </div>
      <div className="breakers">
        <span>Break</span>
        {t.breakables.map((option) => (
          <button key={option.label} title={option.label} onClick={() => void breakThing(option.incident)}>
            {option.label}
          </button>
        ))}
      </div>
    </footer>
  );
}
