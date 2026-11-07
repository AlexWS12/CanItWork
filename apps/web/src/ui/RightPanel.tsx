import type { Finding, StepEvent, Usage } from '@tv/core';
import { BuildGuidePanel } from './BuildGuide';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { scrollBehavior } from '../motion';
import { useStore } from '../store';
import { AGENT_LABEL, ENGINE_LABEL, engineLine } from './labels';
import './RightPanel.css';

function Scoreboard({ findings }: { findings: Finding[] }) {
  const held = findings.filter((f) => f.verdict === 'confirmed').length;
  return (
    <div className="scoreboard">
      <div className="score-tile" data-verdict="confirmed">
        <b>{held}</b>
        <span>{held === 1 ? 'claim held' : 'claims held'}</span>
      </div>
      <div className="score-tile" data-verdict="refuted">
        <b>{findings.length - held}</b>
        <span>refuted</span>
      </div>
    </div>
  );
}

function Claims({ findings }: { findings: Finding[] }) {
  return (
    <ul className="claims" aria-label="Claims tested in the simulator">
      {findings.map((f) => (
        <li key={f.claim} className="claim" data-verdict={f.verdict}>
          <span className="verdict">{f.verdict === 'confirmed' ? 'Confirmed' : 'Refuted'}</span>
          <span>
            {f.claim}
            <small className="delta">{f.evidence}</small>
          </span>
        </li>
      ))}
    </ul>
  );
}

// One line per step; a line opens into the full step card
function TraceLine({ step }: { step: StepEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button className="trace-line" data-status={step.status} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="trace-title">{step.title}</span>
        <span className="trace-engine" data-engine={step.engine}>
          {step.status === 'running' ? `${ENGINE_LABEL[step.engine]} · running` : engineLine(step)}
        </span>
      </button>
      {open && (
        <div className="step" data-status={step.status}>
          <div className="step-head">
            <span className="step-agent">{AGENT_LABEL[step.agent]}</span>
            <span className="tag" data-engine={step.engine}>
              {ENGINE_LABEL[step.engine]}
            </span>
          </div>
          <p>{step.title}</p>
          {step.detail && <small>{step.detail}</small>}
        </div>
      )}
    </li>
  );
}

function Agents() {
  const steps = useStore((s) => s.steps);
  const findings = useStore((s) => s.findings);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: scrollBehavior(), block: 'end' });
  }, [steps.length]);
  return (
    <div className="agents">
      {findings.length > 0 && (
        <>
          <Scoreboard findings={findings} />
          <Claims findings={findings} />
        </>
      )}
      <ol className="trace" aria-label="Agent steps">
        {steps.map((step) => (
          <TraceLine key={step.id} step={step} />
        ))}
      </ol>
      <div ref={end} />
    </div>
  );
}

const money = (n: number | null) => (n === null ? '—' : `$${n.toFixed(n < 0.01 ? 5 : 4)}`);

function UsageRow({ usage }: { usage: Usage }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="usage-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>{usage.feature}</span>
        <span className="tag" data-engine={usage.engine}>
          {ENGINE_LABEL[usage.engine]}
        </span>
        <span className="num">{usage.inputTokens + usage.outputTokens}</span>
        <span className="num">{money(usage.costUsd)}</span>
      </button>
      {open && (
        <pre className="receipt">
          {JSON.stringify(
            { model: usage.model, via: usage.via, routedModel: usage.routedModel, cacheHit: usage.cacheHit, saved: usage.costSavedUsd, receipt: usage.receipt },
            null,
            2,
          )}
        </pre>
      )}
    </>
  );
}

function UsageLedger() {
  const usage = useStore((s) => s.usage);
  const tokens = usage.reduce((sum, u) => sum + u.inputTokens + u.outputTokens, 0);
  const cost = usage.reduce((sum, u) => sum + (u.costUsd ?? 0), 0);
  const saved = usage.reduce((sum, u) => sum + (u.costSavedUsd ?? 0), 0);
  const cached = usage.filter((u) => u.cacheHit).length;
  if (!usage.length) {
    return <p className="empty">No model calls yet. Every Gemini and Swarms call appears here with its tokens, cost and receipt.</p>;
  }
  return (
    <div className="ledger">
      <div className="ledger-totals">
        <div>
          <b>{tokens.toLocaleString()}</b>
          <span>tokens</span>
        </div>
        <div>
          <b>{money(cost)}</b>
          <span>spent</span>
        </div>
        <div>
          <b>{money(saved)}</b>
          <span>saved by Prune</span>
        </div>
        <div>
          <b>{cached}</b>
          <span>cache hits</span>
        </div>
      </div>
      {usage.map((u, i) => (
        <UsageRow key={i} usage={u} />
      ))}
    </div>
  );
}

export function RightPanel() {
  const stored = useStore((s) => s.tab);
  const electronics = useStore((s) => s.environment?.domain === 'electronics');
  // The build guide only exists for circuits.
  const TABS = electronics ? (['agents', 'build', 'usage'] as const) : (['agents', 'usage'] as const);
  const tab = (TABS as readonly string[]).includes(stored) ? stored : 'agents';
  const usage = useStore((s) => s.usage.length);
  const set = useStore((s) => s.set);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKey = (e: KeyboardEvent) => {
    const i = (TABS as readonly string[]).indexOf(tab);
    const next =
      e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    set({ tab: TABS[next] });
    refs.current[TABS[next]]?.focus();
  };
  const label = { agents: 'Agents', build: 'Build', usage: `Usage${usage ? ` (${usage})` : ''}` };
  return (
    <aside className="panel right">
      <div className="tabs" role="tablist" aria-label="Run details" onKeyDown={onKey}>
        {TABS.map((id) => (
          <button
            key={id}
            ref={(el) => {
              refs.current[id] = el;
            }}
            id={`tab-${id}`}
            role="tab"
            aria-selected={tab === id}
            aria-controls={`tabpanel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => set({ tab: id })}
          >
            {label[id]}
          </button>
        ))}
      </div>
      <div className="tabpanel" id={`tabpanel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={0}>
        {tab === 'agents' ? <Agents /> : tab === 'build' ? <BuildGuidePanel /> : <UsageLedger />}
      </div>
    </aside>
  );
}
