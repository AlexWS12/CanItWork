import { breakThing } from '../actions';
import { runner } from '../runner';
import { useStore } from '../store';
import { Sparkline } from './Charts';
import './Transport.css';

export function Transport() {
  const t = useStore((s) => s.telemetry);
  const environment = useStore((s) => s.environment);
  // The recovery sheet covers the dock while it's open
  const covered = useStore((s) => Boolean(s.report) && s.reportOpen);
  if (!environment || covered) return null;
  return (
    <footer className="transport" style={{ ['--stats' as string]: t.stats.length }}>
      <div className="controls">
        <button className="play" onClick={() => runner.toggle()}>
          {t.running ? 'Pause' : 'Play'}
        </button>
        <div className="speeds" role="group" aria-label="Speed">
          {[1, 2, 4].map((speed) => (
            <button key={speed} aria-pressed={t.speed === speed} onClick={() => runner.setSpeed(speed)}>
              {speed}x
            </button>
          ))}
        </div>
      </div>
      <div className="stats">
        {t.stats.map((stat, i) => (
          <div key={stat.label} className="stat" data-tone={stat.tone} data-primary={i === 0}>
            <div className="stat-text">
              <b>{stat.value}</b>
              <span>{stat.label}</span>
            </div>
            <Sparkline values={t.statHistory[stat.label] ?? []} label={`${stat.label} over time`} />
          </div>
        ))}
      </div>
      <div className="breakers">
        <span className="breakers-head">Break</span>
        {t.breakables.map((option) => (
          <button key={option.label} title={option.label} onClick={() => void breakThing(option.incident)}>
            {option.label}
          </button>
        ))}
      </div>
    </footer>
  );
}
