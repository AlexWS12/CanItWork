import type { Finding, StepEvent, Usage } from '@tv/core';
import { BuildGuidePanel } from './BuildGuide';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { scrollBehavior } from '../motion';
import { breakThing } from '../actions';
import { plainFinding, struggling } from '../explain';
import { useStore } from '../store';
import { AGENT_LABEL, ENGINE_LABEL, engineLine, featureLabel, stepTitle } from './labels';
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
          Weak-spot check
        </span>
        <button className="stress-about" aria-expanded={about} onClick={() => setAbout(!about)}>
          {about ? 'Close' : 'What is this?'}
        </button>
      </header>
      <p className="stress-verdict" data-broke={broke > 0}>
        We tried to break your design {findings.length} {findings.length === 1 ? 'way' : 'ways'}.{' '}
        <b>
          {broke
            ? `${broke} found a weak spot.`
            : findings.some((f) => struggling(f) !== null)
              ? 'Nothing got worse, but it was already struggling before we started.'
              : 'It held up every time.'}
        </b>
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
              <span className="stress-badge">{weak ? 'Weak spot' : struggling(f) !== null ? 'No change' : 'Held up'}</span>
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
        <span className="trace-title">{stepTitle(step.title)}</span>
        <span className="trace-engine" data-engine={step.engine}>
          {step.status === 'running' ? `${ENGINE_LABEL[step.engine]} · running` : engineLine(step)}
        </span>
      </button>
      {/* What the step decided or found, shown without a click: it's the part that explains the result */}
      {step.detail && <p className="trace-detail">{step.detail}</p>}
      {open && (
        <div className="step" data-status={step.status}>
          <div className="step-head">
            <span className="step-agent">{AGENT_LABEL[step.agent]}</span>
            <span className="tag" data-engine={step.engine}>
              {ENGINE_LABEL[step.engine]}
            </span>
          </div>
          <p>{stepTitle(step.title)}</p>
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
      {steps.every((s) => s.agent === 'explainer') && (
        <p className="steps-empty">
          This design passed every test when it was first built, so it opened as it was, with no agents needed. Change something in the chat, or try a problem below, and each step
          will show here.
        </p>
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

// "red-team" reads as "Looking for weak spots"
const featureName = featureLabel;

/** What this system has cost so far, in plain words and one bar per agent; the receipts are a click further down. */
function CostSummary({ usage }: { usage: Usage[] }) {
  const byAgent = new Map<string, { cost: number; calls: number; saved: number }>();
  for (const u of usage) {
    const row = byAgent.get(u.feature) ?? { cost: 0, calls: 0, saved: 0 };
    row.cost += u.costUsd ?? 0;
    row.calls += 1;
    row.saved += u.costSavedUsd ?? 0;
    byAgent.set(u.feature, row);
  }
  const rows = [...byAgent].sort((a, b) => b[1].cost - a[1].cost);
  const total = rows.reduce((sum, [, r]) => sum + r.cost, 0);
  const saved = rows.reduce((sum, [, r]) => sum + r.saved, 0);
  const top = Math.max(...rows.map(([, r]) => r.cost), 1e-9);
  return (
    <section className="cost-summary" aria-labelledby="cost-title">
      <h3 id="cost-title">What this system cost</h3>
      <b className="cost-total">{usd(total)}</b>
      <p className="cost-line">
        {usage.length} model {usage.length === 1 ? 'call' : 'calls'}
        {saved > 0 && `, and Prune saved ${usd(saved)} on them`}.
      </p>
      <ul className="cost-agents">
        {rows.map(([feature, r]) => (
          <li key={feature}>
            <span className="cost-agent">
              {featureName(feature)}
              {r.calls > 1 && <span className="cost-calls"> · {r.calls} calls</span>}
            </span>
            <span className="num">{usd(r.cost)}</span>
            <span className="cost-bar" aria-hidden>
              <span style={{ width: `${Math.max(2, (r.cost / top) * 100)}%` }} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function UsageLedger() {
  const usage = useStore((s) => s.usage);
  if (!usage.length) {
    return (
      <div className="ledger">
        <p className="empty">Nothing spent yet. A design from the verified cache costs nothing; every model call made for this system will show here.</p>
        <PruneShowcase />
      </div>
    );
  }
  return (
    <div className="ledger">
      <CostSummary usage={usage} />
      <details className="dev-detail">
        <summary>Developer detail: Prune savings, tokens and receipts</summary>
        <PruneShowcase />
        <div className="usage-head" aria-hidden>
          <span>Agent call</span>
          <span>Route</span>
          <span className="num">Tokens</span>
          <span className="num">Cost</span>
        </div>
        {usage.map((u, i) => (
          <UsageRow key={i} usage={u} />
        ))}
      </details>
    </div>
  );
}

export function RightPanel() {
  const stored = useStore((s) => s.tab);
  const electronics = useStore((s) => s.environment?.domain === 'electronics');
  // The build guide only exists for circuits.
  const TABS = electronics ? (['agents', 'build', 'usage'] as const) : (['agents', 'usage'] as const);
  const tab = (TABS as readonly string[]).includes(stored) ? stored : 'agents';
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
  const label = { agents: 'Steps', build: 'Build it', usage: 'Cost' };
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
