import type { Engine, Finding, StepEvent, Usage } from '@tv/core';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { scrollBehavior } from '../motion';
import { useStore } from '../store';
import './RightPanel.css';

const ENGINE_LABEL: Record<Engine, string> = {
  gemini: 'Gemini',
  jev: 'Jev',
  swarms: 'Swarms',
  simulator: 'Simulator',
  rules: 'Local rules',
};

const AGENT_LABEL: Record<StepEvent['agent'], string> = {
  interpreter: 'Interpreter',
  architect: 'Architect',
  validator: 'Validator',
  simulator: 'Simulator',
  redteam: 'Red Team',
  council: 'Recovery Council',
  editor: 'Editor',
  analyst: 'Analyst',
};

const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

function Scoreline({ finding }: { finding: Finding }) {
  return (
    <div className="finding" data-verdict={finding.verdict}>
      <span className="verdict">{finding.verdict === 'confirmed' ? 'Confirmed' : 'Refuted'}</span>
      <p>{finding.claim}</p>
      <span className="delta">{finding.evidence}</span>
    </div>
  );
}

function Trace() {
  const steps = useStore((s) => s.steps);
  const findings = useStore((s) => s.findings);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: scrollBehavior(), block: 'end' });
  }, [steps, findings]);
  return (
    <div className="trace">
      {steps.map((step) => (
        <div className="step" key={step.id} data-status={step.status}>
          <div className="step-head">
            <span className="step-agent">{AGENT_LABEL[step.agent]}</span>
            {step.ms !== undefined && <span className="step-ms">{seconds(step.ms)}</span>}
            <span className="tag" data-engine={step.engine}>
              {ENGINE_LABEL[step.engine]}
            </span>
          </div>
          <p>{step.title}</p>
          {step.detail && <small>{step.detail}</small>}
        </div>
      ))}
      {findings.length > 0 && <h3>Claims tested in the simulator</h3>}
      {findings.map((f) => (
        <Scoreline key={f.claim} finding={f} />
      ))}
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

const TABS = ['agents', 'usage'] as const;

export function RightPanel() {
  const tab = useStore((s) => s.tab);
  const usage = useStore((s) => s.usage.length);
  const set = useStore((s) => s.set);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKey = (e: KeyboardEvent) => {
    const i = TABS.indexOf(tab);
    const next =
      e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    set({ tab: TABS[next] });
    refs.current[TABS[next]]?.focus();
  };
  const label = { agents: 'Agents', usage: `Usage${usage ? ` (${usage})` : ''}` };
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
        {tab === 'agents' ? <Trace /> : <UsageLedger />}
      </div>
    </aside>
  );
}
