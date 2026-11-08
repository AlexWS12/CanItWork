import { DOMAINS, type KeyCheck, type ProviderStatus } from '@tv/core';
import { useState } from 'react';
import { startOver } from '../actions';
import { useStore } from '../store';
import { ticks } from './labels';
import { AccountButton } from './Account';
import { LivePill } from './LivePill';
import { PrunePill } from './PruneSavings';
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

function Integrations({ variant }: { variant: 'chip' | 'dot' }) {
  const status = useStore((s) => s.status);
  const chips = chipsOf(status);
  const live = chips.some(([, on]) => on);
  return (
    <div className={`integrations ${variant}s`}>
      {status && !live && <span className="offline">Local rules, no AI connected</span>}
      {status === null && <span className="offline">Server offline</span>}
      {chips.map(([name, on, how, check]) => {
        const label = `${name}: ${how}${on && check ? `, ${(name === 'Tiger Data' ? DATABASE_LABEL : CHECK_LABEL)[check]}` : ''}`;
        return (
          <span key={name} className={variant} data-on={on} data-check={on && (debug || check !== 'failing') ? check : undefined} title={label}>
            <span className="integration-name">{name}</span>
            {on && check === 'failing' && debug ? <span className="chip-note"> key failing</span> : <span className="sr-only">{label.slice(name.length)}</span>}
          </span>
        );
      })}
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
  const incident = useStore((s) => Boolean(s.report) && s.reportOpen);
  const running = useStore((s) => s.telemetry.running);
  // The build screen has its own wordmark and nothing else belongs over it
  if (building) return null;
  if (!environment) {
    return (
      <div className="status">
        <Wordmark />
        <Integrations variant="chip" />
        <PrunePill />
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
      <PrunePill />
      <Integrations variant="dot" />
      <LivePill />
      <ShareButton />
      <button className="new-system" onClick={startOver}>
        New system
      </button>
      <AccountButton />
    </header>
  );
}
