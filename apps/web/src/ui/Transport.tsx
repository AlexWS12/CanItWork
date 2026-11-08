import { breakThing } from '../actions';
import { HEALTH_LABEL, displayLabel, headline, healthOf, metricHelp } from '../explain';
import { runner } from '../runner';
import { useStore } from '../store';
import { Sparkline } from './Charts';
import './Transport.css';

// A trend line only earns its place when the number has moved
const moved = (values: number[]) => values.length > 1 && Math.max(...values) - Math.min(...values) > 1e-9;

const isCost = (value: string | number) => /\/mo$/.test(String(value));

// A cost estimate wobbles with traffic every tick, so its tile shows the recent average, rounded to what an estimate can
// claim: "≈ $320/mo" rather than $319, $327, $312 flickering past
function steady(value: string | number, history: number[]) {
  if (!isCost(value) || history.length < 2) return value;
  const recent = history.slice(-20);
  const mean = recent.reduce((sum, v) => sum + v, 0) / recent.length;
  const step = mean >= 10000 ? 500 : mean >= 1000 ? 50 : 10;
  return `≈ $${(Math.round(mean / step) * step).toLocaleString('en-US')}/mo`;
}

export function Transport() {
  const t = useStore((s) => s.telemetry);
  const environment = useStore((s) => s.environment);
  const explanation = useStore((s) => s.explanation);
  const report = useStore((s) => s.report);
  if (!environment) return null;
  // While an incident runs, the headline gives way to the recovery panel's own
  const summary = headline(t.stats, explanation, !report);
  return (
    <footer className="transport" style={{ ['--stats' as string]: t.stats.length }}>
      {summary.text && (
        <p className="dock-headline" data-health={summary.health} aria-live="polite">
          <span className="health-dot" aria-hidden />
          {summary.text}
        </p>
      )}
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
        {t.stats.map((stat, i) => {
          const health = healthOf(stat);
          const history = t.statHistory[stat.label] ?? [];
          const help = metricHelp(stat.label, explanation);
          return (
            <div key={stat.label} className="stat" data-tone={stat.tone} data-primary={i === 0} tabIndex={0} aria-describedby={`stat-help-${i}`}>
              <div className="stat-top">
                <b>{steady(stat.value, history)}</b>
                {/* Healthy is the normal case, so it is a quiet dot; only something worth a look says so in words */}
                <span className="health" data-health={health} title={HEALTH_LABEL[health]}>
                  {health === 'good' ? <span className="sr-only">{HEALTH_LABEL[health]}</span> : HEALTH_LABEL[health]}
                </span>
              </div>
              <span className="stat-label">
                {displayLabel(stat.label)}
                {/* Every tile explains itself on hover or focus; this says so */}
                <svg className="stat-more" width="12" height="12" viewBox="0 0 16 16" aria-hidden>
                  <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M8 7v4.2M8 4.8v.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </span>
              {moved(history) && !isCost(stat.value) && <Sparkline values={history} label={`${stat.label} over time`} />}
              <span className="stat-help" role="tooltip" id={`stat-help-${i}`}>
                <b>{displayLabel(stat.label)}</b>
                {help}
                {stat.detail && (
                  <span className="stat-detail">
                    {stat.detail.map((row) => (
                      <span key={row.label} className="stat-detail-row" data-tone={row.tone}>
                        <span>{row.label}</span>
                        <span className="stat-detail-bar" aria-hidden>
                          <span style={{ width: `${Math.min(100, parseFloat(row.value) || (row.value === 'closed' ? 100 : 0))}%` }} />
                        </span>
                        <span className="num">{row.value}</span>
                      </span>
                    ))}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <div className="breakers">
        <span className="breakers-head">Try a problem</span>
        {t.breakables.map((option) => (
          <button key={option.label} title={`${option.label}: see what happens, then let the agents find and test a fix`} onClick={() => void breakThing(option.incident)}>
            {option.label}
          </button>
        ))}
      </div>
    </footer>
  );
}
