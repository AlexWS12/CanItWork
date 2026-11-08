import type { Finding, StepEvent, Usage } from '@tv/core';
import { BuildGuidePanel } from './BuildGuide';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { scrollBehavior } from '../motion';
import { breakThing } from '../actions';
import { plainFinding } from '../explain';
import { useStore } from '../store';
import { AGENT_LABEL, ENGINE_LABEL, engineLine } from './labels';
import { PruneShowcase, compact, usd } from './PruneSavings';
import './RightPanel.css';

// The Red Team's attacks, as tests a non-engineer can read and replay
function StressTests({ findings }: { findings: Finding[] }) {
  const explanation = useStore((s) => s.explanation);
  const recovering = useStore((s) => s.recovering);
  const [about, setAbout] = useState(false);
  const broke = findings.filter((f) => f.verdict === 'confirmed').length;
  // Weak points first: they are what someone would act on
  const ordered = [...findings].sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === 'confirmed' ? -1 : 1));
  return (
    <section className="stress" aria-labelledby="stress-title">
      <header className="stress-head">
        <span className="kicker" id="stress-title">
          Stress tests · Red Team
        </span>
        <button className="stress-about" aria-expanded={about} onClick={() => setAbout(!about)}>
          {about ? 'Close' : 'What is this?'}
        </button>
      </header>
      <p className="stress-verdict" data-broke={broke > 0}>
        We tried to break your design {findings.length} {findings.length === 1 ? 'way' : 'ways'}. <b>{broke ? `${broke} found a weak spot.` : 'It held up every time.'}</b>
      </p>
      {about && (
        <p className="stress-explain">
          An AI agent plays the attacker and guesses how your design could fail. The simulator then runs each guess for real, so only failures it actually sees count as weak spots.
        </p>
      )}
      <ul className="stress-list">
        {ordered.map((f) => {
          const plain = plainFinding(f, explanation);
          const weak = f.verdict === 'confirmed';
          return (
            <li key={f.claim} className="stress-card" data-weak={weak}>
              <span className="stress-badge">{weak ? 'Weak spot' : 'Held up'}</span>
              <b className="stress-title">{plain.title}</b>
              <p className="stress-impact">{plain.impact}</p>
              <p className="stress-advice">{plain.advice}</p>
              <div className="stress-actions">
                <button className="stress-run" disabled={recovering} onClick={() => void breakThing(f.incident)}>
                  {weak ? 'Watch it happen, then fix it' : 'Try it yourself'}
                </button>
                <details>
                  <summary>Technical detail</summary>
                  <small>
                    {f.claim}
                    <br />
                    {f.evidence}
                  </small>
                </details>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
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
      {findings.length > 0 && <StressTests findings={findings} />}
      <ol className="trace" aria-label="Agent steps">
        {steps.map((step) => (
          <TraceLine key={step.id} step={step} />
        ))}
      </ol>
      <div ref={end} />
    </div>
  );
}

function UsageRow({ usage }: { usage: Usage }) {
  const [open, setOpen] = useState(false);
  const saved = usage.costSavedUsd ?? 0;
  return (
    <>
      <button className="usage-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>{usage.feature}</span>
        <span className="tag" data-engine={usage.engine} data-via={usage.via}>
          {usage.via === 'prune' ? 'Prune' : ENGINE_LABEL[usage.engine]}
        </span>
        <span className="num">{compact(usage.inputTokens + usage.outputTokens)}</span>
        <span className="num" data-saved={saved > 0}>
          {saved > 0 ? `−${usd(saved)}` : usage.costUsd !== null ? usd(usage.costUsd) : '—'}
        </span>
      </button>
      {open && (
        <pre className="receipt">
          {JSON.stringify(
            {
              model: usage.model,
              via: usage.via,
              routedModel: usage.routedModel,
              tokensSaved: usage.tokensSaved,
              costWithoutPrune: usage.costWithoutUsd,
              saved: usage.costSavedUsd,
              cacheHit: usage.cacheHit,
              optimizations: usage.optimizations,
              receipt: usage.receipt,
            },
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
  return (
    <div className="ledger">
      <PruneShowcase />
      {usage.length ? (
        <>
          <div className="usage-head" aria-hidden>
            <span>Agent call</span>
            <span>Route</span>
            <span className="num">Tokens</span>
            <span className="num">Cost</span>
          </div>
          {usage.map((u, i) => (
            <UsageRow key={i} usage={u} />
          ))}
        </>
      ) : (
        <p className="empty">No model calls yet. Every Gemini and Swarms call appears here with its tokens, cost and Prune receipt.</p>
      )}
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
