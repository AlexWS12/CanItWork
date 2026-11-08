import type { Breakable } from '@tv/core';
import { useEffect, useRef, useState } from 'react';
import { breakThing } from '../actions';
import { HEALTH_LABEL, displayLabel, headline, healthOf, metricHelp, metricSource, type Health } from '../explain';
import { runner } from '../runner';
import { useStore } from '../store';
import { Sparkline } from './Charts';
import './Transport.css';

// Health changes on screen only once they have lasted: a problem shows after a second, a warning after three, and an
// all-clear after four. Readings jitter with traffic from tick to tick, and a summary that flipped with every jitter
// would look broken; anything that lasts still shows promptly. Keyed by the run, so a new design starts fresh.
const HOLD_MS: Record<Health, number> = { problem: 1000, watch: 3000, good: 4000 };
// The summary's wording, once its health holds, still waits a few seconds between rewrites
const REWORD_MS = 6000;
type Held = { health: Health; text: string; pending: Health | null; since: number; changed: number };
const held = new Map<string, Held>();

function steady(key: string, health: Health, text = ''): { health: Health; text: string } {
  const now = performance.now();
  const h = held.get(key);
  if (!h) {
    held.set(key, { health, text, pending: null, since: now, changed: now });
    return { health, text };
  }
  if (health === h.health) {
    h.pending = null;
    if (text !== h.text && now - h.changed > REWORD_MS) {
      h.text = text;
      h.changed = now;
    }
  } else if (h.pending !== health) {
    h.pending = health;
    h.since = now;
  } else if (now - h.since >= HOLD_MS[health]) {
    Object.assign(h, { health, text, pending: null, changed: now });
  }
  return { health: h.health, text: h.text };
}

// A trend line only earns its place when the number has moved
const moved = (values: number[]) => values.length > 1 && Math.max(...values) - Math.min(...values) > 1e-9;

const isCost = (value: string | number) => /\/mo$/.test(String(value));

// "$1,240/mo" as 1240, so cost lines can be drawn against each other
const dollars = (value: string) => Number(value.replace(/[^\d.]/g, '')) || 0;

// A breakdown row's bar: a share of the largest line for costs, the reading itself for percentages
function barWidth(row: { value: string }, cost: boolean, largest: number) {
  if (cost) return largest > 0 ? (dollars(row.value) / largest) * 100 : 0;
  return Math.min(100, parseFloat(row.value) || (row.value === 'closed' ? 100 : 0));
}

// A cost estimate wobbles with traffic every tick, so its tile shows the recent average, rounded to what an estimate can
// claim: "≈ $320/mo" rather than $319, $327, $312 flickering past
function steadyCost(value: string | number, history: number[]) {
  if (!isCost(value) || history.length < 2) return value;
  const recent = history.slice(-20);
  const mean = recent.reduce((sum, v) => sum + v, 0) / recent.length;
  const step = mean >= 10000 ? 500 : mean >= 1000 ? 50 : 10;
  return `≈ $${(Math.round(mean / step) * step).toLocaleString('en-US')}/mo`;
}

export function Transport() {
  const t = useStore((s) => s.telemetry);
  const environment = useStore((s) => s.environment);
  const run = useStore((s) => s.environmentKey);
  const explanation = useStore((s) => s.explanation);
  const report = useStore((s) => s.report);
  if (!environment) return null;
  // While an incident runs, the headline gives way to the recovery panel's own
  const raw = headline(t.stats, explanation, !report);
  const summary = steady(`${run}:summary`, raw.health, raw.text);
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
          const health = steady(`${run}:${stat.label}`, healthOf(stat)).health;
          const history = t.statHistory[stat.label] ?? [];
          const help = metricHelp(stat.label, explanation);
          const source = metricSource(stat.label);
          const cost = isCost(stat.value);
          const largest = cost ? Math.max(0, ...(stat.detail ?? []).map((row) => dollars(row.value))) : 0;
          return (
            <div key={stat.label} className="stat" data-tone={stat.tone} data-primary={i === 0} tabIndex={0} aria-describedby={`stat-help-${i}`}>
              <div className="stat-top">
                <b>{steadyCost(stat.value, history)}</b>
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
                <span className="stat-source" data-kind={source.kind}>
                  Comes from <b>{source.text}</b>
                </span>
                {stat.detail && (
                  <span className="stat-detail" data-kind={cost ? 'cost' : undefined}>
                    {stat.detail.map((row) => (
                      <span key={row.label} className="stat-detail-row" data-tone={row.tone}>
                        <span>{row.label}</span>
                        <span className="stat-detail-bar" aria-hidden>
                          <span style={{ width: `${barWidth(row, cost, largest)}%` }} />
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
      <Breakers options={t.breakables} />
    </footer>
  );
}

// The dock fits two rows of two: with more problems than that, three show and the fourth slot opens the full list
const SHOWN = 3;

function Breakers({ options }: { options: Breakable[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const overflow = options.length > SHOWN + 1;

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const pick = (incident: Breakable['incident']) => {
    setOpen(false);
    void breakThing(incident);
  };
  const title = (label: string) => `${label}: see what happens, then let the agents find and test a fix`;

  return (
    <div className="breakers" ref={box}>
      <span className="breakers-head">Try a problem</span>
      {options.map((option, i) => (
        <button key={option.label} data-extra={overflow && i >= SHOWN} title={title(option.label)} onClick={() => pick(option.incident)}>
          {option.label}
        </button>
      ))}
      {overflow && (
        <button className="breakers-more" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
          All {options.length} problems
        </button>
      )}
      {open && (
        <div className="breakers-menu" role="menu">
          {options.map((option) => (
            <button key={option.label} role="menuitem" title={title(option.label)} onClick={() => pick(option.incident)}>
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
