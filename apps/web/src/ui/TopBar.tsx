import { DOMAINS, type KeyCheck, type ProviderStatus } from '@tv/core';
import { useEffect, useState } from 'react';
import { startOver } from '../actions';
import { useStore } from '../store';
import { ticks } from './labels';
import { AccountButton } from './Account';
import { LivePill } from './LivePill';
import { PrunePill } from './PruneSavings';
import { SaveButton } from './SavePanel';
import { ShareButton } from './SharePanel';
import { Wordmark } from './Wordmark';
import './TopBar.css';

const CHECK_LABEL: Record<KeyCheck, string> = { ok: 'key works', failing: 'key failing', unchecked: 'key not checked' };
const DATABASE_LABEL: Record<KeyCheck, string> = { ok: 'database answers', failing: 'database not answering', unchecked: 'not checked' };

// Key problems stay in each chip's tooltip; ?debug spells them out on screen
const debug = new URLSearchParams(location.search).has('debug');

type Chip = [name: string, on: boolean, how: string, check: KeyCheck | undefined];

const chipsOf = (status: ProviderStatus | null | undefined): Chip[] =>
  status
    ? [
        ['Gemini', status.gemini !== 'off', status.gemini, status.checks?.gemini],
        ['Jev', status.typesafe, status.typesafe ? 'TypeSafe' : 'off', status.checks?.typesafe],
        ['Swarms', status.swarms, status.swarms ? 'hosted' : 'off', status.checks?.swarms],
        ['Tiger Data', status.storage === 'postgres', status.storage === 'postgres' ? 'Postgres' : 'local file', status.checks?.storage],
      ]
    : [];

// What each service does here, in plain words, for the status menu
const ROLE: Record<string, string> = {
  Gemini: 'Designs and explains',
  Jev: 'Picks the right simulator',
  Swarms: 'Runs the Red Team and Recovery Council',
  'Tiger Data': 'Keeps your saved runs',
};

/** One quiet dot for every service the agents use; the menu behind it says what each does and whether it answers. */
function StatusMenu() {
  const status = useStore((s) => s.status);
  const [open, setOpen] = useState(false);
  const chips = chipsOf(status);
  const live = chips.filter(([, on]) => on);
  const failing = live.some(([, , , check]) => check === 'failing');
  const state = status === null ? 'offline' : !live.length ? 'local' : failing ? 'warn' : 'ok';
  const summary = { offline: 'Server offline', local: 'Local rules only', warn: 'A service needs attention', ok: 'All services live' }[state];
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent | MouseEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !(e.target as Element).closest('.status-menu')) setOpen(false);
    };
    window.addEventListener('keydown', close);
    window.addEventListener('pointerdown', close);
    return () => {
      window.removeEventListener('keydown', close);
      window.removeEventListener('pointerdown', close);
    };
  }, [open]);
  return (
    <div className="status-menu">
      <button className="status-button" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(!open)} title={summary}>
        <span className="status-dot" data-state={state} aria-hidden />
        <span className="status-label">{state === 'ok' ? 'Live' : summary}</span>
      </button>
      {open && (
        <div className="status-panel" role="dialog" aria-label="Services">
          <b className="status-title">{summary}</b>
          <ul>
            {chips.map(([name, on, how, check]) => (
              <li key={name} data-on={on}>
                <span className="status-dot" data-state={!on ? 'off' : check === 'failing' ? 'warn' : 'ok'} aria-hidden />
                <span className="status-name">{name}</span>
                <span className="status-role">
                  {on ? ROLE[name] : `Off: ${how}`}
                  {on && check && check !== 'ok' && ` · ${(name === 'Tiger Data' ? DATABASE_LABEL : CHECK_LABEL)[check]}`}
                </span>
              </li>
            ))}
          </ul>
          <PrunePill />
          {debug && <p className="status-debug">Debug: every key check is shown above.</p>}
        </div>
      )}
    </div>
  );
}

function StatePill() {
  const tick = useStore((s) => s.telemetry.tick);
  const running = useStore((s) => s.telemetry.running);
  const speed = useStore((s) => s.telemetry.speed);
  const report = useStore((s) => s.report);
  const open = useStore((s) => s.reportOpen);
  if (report && open) {
    return (
      <span className="state-pill" data-state="incident">
        Incident · {report.incident} · t {ticks(report.tick)}
      </span>
    );
  }
  return (
    <span className="state-pill" data-state={running ? 'running' : 'paused'}>
      {running && <span className="pulse" aria-hidden />}
      {running ? `Running · t ${ticks(tick)} · ${speed}x` : `Paused · t ${ticks(tick)}`}
    </span>
  );
}

export function TopBar() {
  const environment = useStore((s) => s.environment);
  const building = useStore((s) => s.building);
  // The landing's live hero is a showcase, not the user's system: the landing strip stays
  const showcase = useStore((s) => s.showcase);
  const incident = useStore((s) => Boolean(s.report) && s.reportOpen);
  const running = useStore((s) => s.telemetry.running);
  // The build screen has its own wordmark and nothing else belongs over it
  if (building) return null;
  if (!environment || showcase) {
    return (
      <div className="status">
        <Wordmark />
        <StatusMenu />
        <AccountButton />
      </div>
    );
  }
  const domain = DOMAINS[environment.domain];
  return (
    <header className="topbar" data-incident={incident}>
      {/* Same precedence as StatePill: an open incident, otherwise running or paused */}
      <Wordmark state={incident ? 'incident' : running ? 'running' : 'paused'} />
      <span className="divider" aria-hidden />
      <div className="identity" title={environment.summary}>
        <b>{environment.name}</b>
        <span className="domain-tag">{domain.label}</span>
      </div>
      <div className="topbar-center">
        <StatePill />
      </div>
      <StatusMenu />
      <LivePill />
      <SaveButton />
      <ShareButton />
      <button className="new-system start-over" onClick={startOver}>
        New system
      </button>
      <AccountButton />
    </header>
  );
}
