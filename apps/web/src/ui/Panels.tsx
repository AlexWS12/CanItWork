import { DOMAINS, domainList, type Engine, type Finding, type StepEvent, type Usage } from '@tv/core';
import { useEffect, useRef, useState } from 'react';
import { applyCandidate, breakThing, buildEnvironment, sendChat, startOver } from '../actions';
import { runner } from '../runner';
import { useStore } from '../store';
import { RecoveryChart, Sparkline } from './Charts';

const ENGINE_LABEL: Record<Engine, string> = {
  gemini: 'Gemini',
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

const EXAMPLES = domainList().map((d) => d.examples[0]);

function Refusal() {
  const refusal = useStore((s) => s.refusal);
  if (!refusal) return null;
  const closest = refusal.closest ? DOMAINS[refusal.closest] : null;
  return (
    <div className="refusal">
      <b>Nothing was built</b>
      <p>{refusal.reason}</p>
      {closest && (
        <p>
          The closest fit is {closest.label.toLowerCase()}: {closest.blurb.toLowerCase()}.
        </p>
      )}
      <ul>
        {domainList().map((d) => (
          <li key={d.id}>
            {d.label}: {d.blurb.toLowerCase()}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Landing() {
  const [text, setText] = useState('');
  const building = useStore((s) => s.building);
  const steps = useStore((s) => s.steps);
  const messages = useStore((s) => s.messages);
  const last = messages[messages.length - 1];
  const submit = (prompt: string) => {
    if (prompt.trim() && !building) void buildEnvironment(prompt.trim());
  };
  return (
    <div className="landing">
      <h1>tv</h1>
      <p className="tagline">Describe a system. Run it. Break it. Fix it.</p>
      <form
        className="hero-input"
        onSubmit={(e) => {
          e.preventDefault();
          submit(text);
        }}
      >
        <textarea
          aria-label="Describe a system"
          autoFocus
          rows={2}
          value={text}
          placeholder="Describe a system in your own words"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit(text);
            }
          }}
        />
        <button type="submit" disabled={building || !text.trim()}>
          {building ? 'Building' : 'Build'}
        </button>
      </form>
      {building ? (
        <ol className="hero-steps">
          {steps.map((s) => (
            <li key={s.id} data-status={s.status}>
              {s.title}
            </li>
          ))}
        </ol>
      ) : (
        <>
          <Refusal />
          {last?.role === 'app' && <p className="landing-note">{last.text}</p>}
          <div className="domain-chips">
            {domainList().map((d) => (
              <span key={d.id} className="domain-chip" title={d.blurb}>
                {d.label}
              </span>
            ))}
          </div>
          <div className="examples">
            {EXAMPLES.map((example) => (
              <button key={example} onClick={() => submit(example)}>
                {example}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

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
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [steps, findings]);
  return (
    <div className="trace">
      {steps.map((step) => (
        <div className="step" key={step.id} data-status={step.status}>
          <div className="step-head">
            <span className="step-agent">{AGENT_LABEL[step.agent]}</span>
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

export function RightPanel() {
  const tab = useStore((s) => s.tab);
  const usage = useStore((s) => s.usage.length);
  const set = useStore((s) => s.set);
  return (
    <aside className="panel right">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'agents'} onClick={() => set({ tab: 'agents' })}>
          Agents
        </button>
        <button role="tab" aria-selected={tab === 'usage'} onClick={() => set({ tab: 'usage' })}>
          Usage{usage ? ` (${usage})` : ''}
        </button>
      </div>
      {tab === 'agents' ? <Trace /> : <UsageLedger />}
    </aside>
  );
}

export function ChatPanel() {
  const messages = useStore((s) => s.messages);
  const chatting = useStore((s) => s.chatting);
  const environment = useStore((s) => s.environment);
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);
  if (!environment) return null;
  const domain = DOMAINS[environment.domain];
  const submit = (message: string) => {
    if (!message.trim() || chatting) return;
    setText('');
    void sendChat(message.trim());
  };
  return (
    <aside className="panel left">
      <header>
        <div className="head-row">
          <span className="domain-tag">{domain.label}</span>
          <button onClick={startOver}>New system</button>
        </div>
        <h2>{environment.name}</h2>
        <p>{environment.summary}</p>
        {environment.unmodelled.length > 0 ? (
          <details className="limits">
            <summary>Not modelled in this design ({environment.unmodelled.length})</summary>
            <ul>
              {environment.unmodelled.map((item) => (
                <li key={item} className="unmodelled">
                  {item}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <p className="limits" title={domain.limits.join('\n')}>
          {domain.label} simulator limits
        </p>
      </header>
      <div className="messages">
        {messages.map((m, i) => (
          <div key={i} className="message" data-role={m.role}>
            {m.text}
          </div>
        ))}
        {chatting && (
          <div className="message" data-role="app" data-pending="true">
            Working
          </div>
        )}
        <div ref={end} />
      </div>
      <div className="suggestions">
        {domain.suggestions.map((s) => (
          <button key={s} onClick={() => submit(s)} disabled={chatting}>
            {s}
          </button>
        ))}
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          submit(text);
        }}
      >
        <input aria-label="Ask or change something" value={text} placeholder="Ask, change or break something" onChange={(e) => setText(e.target.value)} />
        <button type="submit" disabled={chatting || !text.trim()}>
          Send
        </button>
      </form>
    </aside>
  );
}

export function StatusBar() {
  const status = useStore((s) => s.status);
  const chips: Array<[string, boolean, string]> = status
    ? [
        ['Gemini', status.gemini !== 'off', status.gemini],
        ['Swarms', status.swarms, status.swarms ? 'hosted' : 'off'],
        ['Prune', status.prune, status.prune ? 'gateway' : 'off'],
      ]
    : [];
  const live = chips.some(([, on]) => on);
  return (
    <div className="status">
      <span className="wordmark">tv</span>
      {status && !live && <span className="offline">Local rules, no AI connected</span>}
      {!status && <span className="offline">Server offline</span>}
      {chips.map(([name, on, how]) => (
        <span key={name} className="chip" data-on={on} title={`${name}: ${how}`}>
          {name}
        </span>
      ))}
    </div>
  );
}

export function Transport() {
  const t = useStore((s) => s.telemetry);
  const environment = useStore((s) => s.environment);
  if (!environment) return null;
  return (
    <footer className="transport">
      <div className="controls">
        <button className="play" onClick={() => runner.toggle()} aria-label={t.running ? 'Pause' : 'Play'}>
          {t.running ? 'Pause' : 'Play'}
        </button>
        {[1, 2, 4].map((speed) => (
          <button key={speed} aria-pressed={t.speed === speed} onClick={() => runner.setSpeed(speed)}>
            {speed}x
          </button>
        ))}
        <span className="tick">t {t.tick}</span>
      </div>
      <div className="stats">
        {t.stats.map((stat) => (
          <div key={stat.label} className="stat" data-tone={stat.tone}>
            <b>{stat.value}</b>
            <span>{stat.label}</span>
          </div>
        ))}
        <Sparkline values={t.history} />
      </div>
      <div className="breakers">
        <span>Break</span>
        {t.breakables.map((option) => (
          <button key={option.label} title={option.label} onClick={() => void breakThing(option.incident)}>
            {option.label}
          </button>
        ))}
      </div>
    </footer>
  );
}

export function Inspector() {
  const selected = useStore((s) => s.selected);
  useStore((s) => s.telemetry.tick);
  const set = useStore((s) => s.set);
  const view = selected ? runner.run?.inspect(selected) : null;
  if (!view) return null;
  return (
    <div className="inspector">
      <header>
        <h3>{view.title}</h3>
        <button aria-label="Close" onClick={() => set({ selected: null })}>
          ×
        </button>
      </header>
      <dl>
        {view.rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {view.actions.map((action) => (
        <button
          key={action.label}
          className={action.destructive ? 'action danger' : 'action'}
          onClick={() => (action.destructive ? void breakThing(action.incident) : runner.inject(action.incident))}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

export function RecoveryCard() {
  const report = useStore((s) => s.report);
  const recovering = useStore((s) => s.recovering);
  const appliedId = useStore((s) => s.appliedId);
  const open = useStore((s) => s.reportOpen);
  const set = useStore((s) => s.set);
  if (!report) {
    return recovering ? <div className="recovery slim">Agents are working on a recovery plan</div> : null;
  }
  const applied = report.candidates.find((c) => c.id === appliedId);
  if (!open && applied) {
    return (
      <div className="recovery slim applied">
        <span>
          {applied.title}: {applied.evaluation.score}, against {report.unmitigated.score} doing nothing
        </span>
        <button onClick={() => set({ reportOpen: true })}>Compare</button>
        <button aria-label="Dismiss" onClick={() => set({ report: null })}>
          ×
        </button>
      </div>
    );
  }
  return (
    <section className="recovery">
      <header>
        <div>
          <span className="eyebrow">Incident at t {report.tick}</span>
          <h3>{report.incident}</h3>
        </div>
        <button aria-label="Dismiss" onClick={() => set({ report: null })}>
          ×
        </button>
      </header>
      <div className="recovery-body">
        <RecoveryChart report={report} />
        <div className="candidates">
          {report.candidates.map((c) => (
            <div key={c.id} className="candidate" data-winner={c.id === report.winnerId} title={c.rationale}>
              <div className="candidate-text">
                <b>{c.title}</b>
                <small>{c.author}</small>
              </div>
              <span className="score">{c.evaluation.score}</span>
              <button onClick={() => applyCandidate(c)} disabled={appliedId !== null}>
                {appliedId === c.id ? 'Applied' : 'Apply'}
              </button>
            </div>
          ))}
          {!report.candidates.length && <p className="summary">No recovery options for this incident.</p>}
          <p className="summary">{report.summary}</p>
        </div>
      </div>
    </section>
  );
}
