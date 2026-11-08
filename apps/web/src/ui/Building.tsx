import { domainList, type AgentId, type ProviderStatus, type StepEvent } from '@tv/core';
import { useEffect, useState } from 'react';
import { splitPrompt } from '../entities';
import { reducedMotion } from '../motion';
import { useStore } from '../store';
import './Building.css';
import { Wordmark } from './Wordmark';
import { AGENT_LABEL, engineLine } from './labels';

// The build pipeline in apps/server/src/agents.ts `build`, used to show the steps still to come.
// Repairs repeat the Architect and Validator, so they never advance the pointer.
// Titles follow the server's, which depend on what is connected.
const PIPELINE: Array<{ agent: AgentId; title: (status: ProviderStatus | null) => string; simulator?: boolean }> = [
  { agent: 'interpreter', title: () => 'Identifying the domain' },
  { agent: 'architect', title: (s) => (s?.gemini === 'off' ? 'Drafting from a template' : 'Designing the environment') },
  { agent: 'validator', title: () => 'Checking the design', simulator: true },
  { agent: 'simulator', title: () => 'Running the baseline', simulator: true },
  { agent: 'redteam', title: (s) => (s?.swarms ? 'Attacking the design' : 'Looking for weak points') },
  { agent: 'simulator', title: () => 'Testing each claim', simulator: true },
];

function upcoming(steps: StepEvent[]) {
  let at = 0;
  for (const step of steps) {
    const i = PIPELINE.findIndex((p, j) => j >= at && p.agent === step.agent);
    if (i >= 0) at = i + 1;
  }
  return PIPELINE.slice(at);
}

const REVEAL_MS = 280;

function Prompt() {
  const prompt = useStore((s) => s.prompt);
  const entities = useStore((s) => s.entities);
  const [shown, setShown] = useState(0);
  useEffect(() => setShown(reducedMotion() ? entities.length : 0), [entities]);
  useEffect(() => {
    if (shown >= entities.length) return;
    const id = setTimeout(() => setShown(shown + 1), REVEAL_MS);
    return () => clearTimeout(id);
  }, [shown, entities]);
  return (
    <p className="build-prompt">
      {splitPrompt(prompt, entities).map((piece, i) =>
        piece.entity === null ? (
          piece.text
        ) : (
          <span key={i} className="entity" data-state={piece.entity >= shown ? 'pending' : piece.entity === shown - 1 ? 'placing' : 'placed'}>
            {piece.text}
          </span>
        ),
      )}
      <span className="caret" aria-hidden />
    </p>
  );
}

// Collapsed to the best match by default; the full list is one click away for anyone curious
function DomainOdds() {
  const odds = useStore((s) => s.domainOdds);
  const [open, setOpen] = useState(false);
  if (!odds) return null;
  const rows = domainList()
    .map((d) => ({ id: d.id, label: d.label, p: odds[d.id] ?? 0 }))
    .sort((a, b) => b.p - a.p);
  const [top] = rows;
  const pct = (p: number) => `${Math.round(p * 100)}%`;
  return (
    <div className="odds" data-open={open}>
      <button className="odds-summary" aria-expanded={open} aria-controls="odds-grid" onClick={() => setOpen(!open)}>
        <span className="kicker">Best simulator for this · Jev</span>
        <span className="odds-top">
          <b>{top.label}</b>
          <span className="odds-track" aria-hidden>
            <div style={{ width: pct(top.p) }} />
          </span>
          <span className="num">{pct(top.p)} match</span>
          <span className="odds-toggle">{open ? 'Hide' : `Compare all ${rows.length}`}</span>
        </span>
      </button>
      {open && (
        <div className="odds-grid" id="odds-grid">
          {rows.slice(1).map((row) => (
            <div key={row.id} className="odds-row">
              <span>{row.label}</span>
              <div className="odds-track">
                <div style={{ width: pct(row.p) }} />
              </div>
              <span className="num">{row.p < 0.01 ? '<1%' : pct(row.p)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type Row = { key: string; status: StepEvent['status'] | 'pending'; agent: AgentId; title: string; simulator: boolean; step?: StepEvent };

function Timeline() {
  const steps = useStore((s) => s.steps);
  const status = useStore((s) => s.status);
  const rows: Row[] = [
    ...steps.map((step) => ({ key: step.id, status: step.status, agent: step.agent, title: step.title, simulator: step.engine === 'simulator', step })),
    ...upcoming(steps).map((p, i) => ({
      key: `next-${steps.length + i}`,
      status: 'pending' as const,
      agent: p.agent,
      title: p.title(status ?? null),
      simulator: Boolean(p.simulator),
    })),
  ];
  return (
    <ol className="timeline" aria-live="polite">
      {rows.map((row, i) => {
        const next = rows[i + 1];
        const into = row.status === 'done' && next?.status === 'running' ? 'running' : row.status;
        return (
          <li key={row.key} className="tl-row" data-status={row.status}>
            <div className="tl-rail" aria-hidden>
              <span className="tl-node">{row.status === 'running' && <span className="pulse" />}</span>
              {next && <span className="tl-line" data-into={into} />}
            </div>
            {row.status === 'running' ? (
              <div className="tl-content">
                <div className="tl-card">
                  <div className="tl-head">
                    <b>{AGENT_LABEL[row.agent]}</b>
                    <span className="tl-engine" data-sim={row.simulator}>
                      {row.simulator ? 'ground truth' : engineLine(row.step!)}
                    </span>
                  </div>
                  <span className="tl-title">{row.title}</span>
                  {row.step?.progress !== undefined && (
                    <div className="tl-progress">
                      <div style={{ width: `${Math.round(row.step.progress * 100)}%` }} />
                    </div>
                  )}
                  {row.step?.detail && <span className="tl-detail">{row.step.detail}</span>}
                </div>
              </div>
            ) : (
              <div className="tl-content">
                <div className="tl-head">
                  <b>{AGENT_LABEL[row.agent]}</b>
                  {row.step ? (
                    <span className="tl-engine" data-sim={row.simulator}>
                      {engineLine(row.step)}
                    </span>
                  ) : (
                    row.simulator && <span className="tl-engine">ground truth</span>
                  )}
                </div>
                <span className="tl-title">
                  {row.title}
                  {row.step?.detail && ` · ${row.step.detail}`}
                </span>
              </div>
            )}
            <span className="sr-only">{row.status}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function Building() {
  return (
    <div className="building">
      <section className="build-main">
        <Wordmark />
        <div className="build-sentence">
          <span className="build-state">
            <span className="pulse" aria-hidden /> Building
          </span>
          <Prompt />
        </div>
        <DomainOdds />
      </section>
      <section className="build-agents" aria-labelledby="agents-title">
        <h2 id="agents-title" className="kicker">
          Agents
        </h2>
        <Timeline />
        <p className="build-honest">If it can't model what you describe, it says so instead of guessing.</p>
      </section>
    </div>
  );
}
