import type { SpendSummary, Usage } from '@tv/core';
import { useState } from 'react';
import { useStore } from '../store';
import './PruneSavings.css';

// Small amounts read best in cents with enough digits to show they aren't zero
export const usd = (n: number) => (n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(5)}` : n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
export const compact = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString('en-US'));

// Flash-Lite list prices per million tokens, for calls that carry no receipt (they went direct)
const PRICE = { input: 0.1, output: 0.4 };
const estimate = (u: Usage) => u.costUsd ?? (u.inputTokens * PRICE.input + u.outputTokens * PRICE.output) / 1e6;

// This page's Gemini calls in the same shape as the server's lifetime summary
export function sessionSummary(usage: Usage[], bypass: string | null): SpendSummary {
  const out: SpendSummary = { calls: 0, viaPrune: 0, direct: 0, tokens: 0, tokensSaved: 0, costUsd: 0, costWithoutUsd: 0, savedUsd: 0, cacheHits: 0, routed: 0, bypass };
  for (const u of usage) {
    if (u.engine !== 'gemini') continue;
    const cost = estimate(u);
    const saved = u.costSavedUsd ?? 0;
    out.calls++;
    out.tokens += u.inputTokens + u.outputTokens;
    out.tokensSaved += u.tokensSaved ?? 0;
    out.costUsd += cost;
    out.savedUsd += saved;
    out.costWithoutUsd += u.costWithoutUsd ?? cost + saved;
    if (u.via === 'prune') out.viaPrune++;
    else out.direct++;
    if (u.cacheHit) out.cacheHits++;
    if (u.routedModel) out.routed++;
  }
  return out;
}

function optimizationsOf(usage: Usage[]) {
  const counts = new Map<string, number>();
  for (const u of usage) for (const o of u.optimizations ?? []) counts.set(o, (counts.get(o) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// Prune's optimisation codes in words a judge can read
const OPTIMIZATION_LABEL: Record<string, string> = {
  template_opt: 'Prompt cleanup',
  output_cap: 'Output cap',
  route: 'Cheaper model',
  cache: 'Cache',
};
const optimizationLabel = (code: string) => {
  const [name, arg] = code.split(':');
  return `${OPTIMIZATION_LABEL[name] ?? name.replace(/_/g, ' ')}${arg ? ` ${arg}` : ''}`;
};

export function PruneShowcase() {
  const usage = useStore((s) => s.usage);
  const lifetime = useStore((s) => s.spend);
  const [scope, setScope] = useState<'session' | 'lifetime'>('session');
  const session = sessionSummary(usage, lifetime?.bypass ?? null);
  const s = scope === 'lifetime' && lifetime ? lifetime : session;
  const pct = s.costWithoutUsd > 0 ? Math.round((s.savedUsd / s.costWithoutUsd) * 100) : 0;
  const tokenPct = s.tokens + s.tokensSaved > 0 ? Math.round((s.tokensSaved / (s.tokens + s.tokensSaved)) * 100) : 0;
  const bypassed = s.calls > 0 && s.viaPrune === 0;
  const optimizations = optimizationsOf(usage);
  const signed = usage.filter((u) => u.signed).length;
  // Fractions of a cent per call add up: the same saving across a production workload
  const per10k = s.viaPrune > 0 ? (s.savedUsd / s.viaPrune) * 10_000 : 0;
  return (
    <section className="prune" aria-labelledby="prune-title">
      <header className="prune-head">
        <h3 id="prune-title" className="kicker">
          Prune AI · token savings
        </h3>
        <div className="prune-scope" role="group" aria-label="Savings period">
          <button aria-pressed={scope === 'session'} onClick={() => setScope('session')}>
            This session
          </button>
          <button aria-pressed={scope === 'lifetime'} onClick={() => setScope('lifetime')} disabled={!lifetime}>
            All time
          </button>
        </div>
      </header>

      {s.calls === 0 ? (
        <p className="prune-note">
          Every Gemini call goes through Prune, which trims prompts, caps outputs and routes simple requests to cheaper models. Savings show here as soon as an agent makes a call.
        </p>
      ) : (
        <>
          <div className="prune-hero">
            <b data-zero={pct === 0}>{pct}%</b>
            <span>
              cheaper than calling Gemini directly
              <small>
                {usd(s.savedUsd)} saved on {s.viaPrune} of {s.calls} calls
              </small>
            </span>
          </div>
          <div className="prune-bars" aria-hidden>
            <div className="prune-bar">
              <span>Without Prune</span>
              <span className="prune-track">
                <span data-kind="without" style={{ width: '100%' }} />
              </span>
              <span className="num">{usd(s.costWithoutUsd)}</span>
            </div>
            <div className="prune-bar">
              <span>With Prune</span>
              <span className="prune-track">
                <span data-kind="with" style={{ width: `${s.costWithoutUsd > 0 ? Math.max(2, (s.costUsd / s.costWithoutUsd) * 100) : 100}%` }} />
              </span>
              <span className="num">{usd(s.costUsd)}</span>
            </div>
          </div>
          <dl className="prune-stats">
            <div>
              <dt>Tokens saved</dt>
              <dd>
                {compact(s.tokensSaved)}
                {tokenPct > 0 && <small> · {tokenPct}%</small>}
              </dd>
            </div>
            <div>
              <dt>Tokens used</dt>
              <dd>{compact(s.tokens)}</dd>
            </div>
            <div>
              <dt>Sent to a cheaper model</dt>
              <dd>{s.routed}</dd>
            </div>
            <div>
              <dt>Signed receipts</dt>
              <dd>{scope === 'session' ? signed : s.viaPrune}</dd>
            </div>
          </dl>
          {per10k > 0 && (
            <p className="prune-scale">
              At this rate Prune saves <b>{usd(per10k)}</b> every 10,000 agent calls.
            </p>
          )}
          {scope === 'session' && optimizations.length > 0 && (
            <ul className="prune-ops" aria-label="What Prune did">
              {optimizations.map(([code, n]) => (
                <li key={code}>
                  {optimizationLabel(code)} <span>×{n}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {(bypassed || s.bypass) && (
        <p className="prune-warn">
          {s.bypass ?? 'Calls went straight to Gemini'}, so these calls skipped Prune and saved nothing. Store a working Gemini key in the Prune dashboard under Connect →
          Providers.
        </p>
      )}
    </section>
  );
}

// Always-on savings counter in the top bar; it opens the Usage tab
export function PrunePill() {
  const usage = useStore((s) => s.usage);
  const lifetime = useStore((s) => s.spend);
  const prune = useStore((s) => s.status?.prune);
  const set = useStore((s) => s.set);
  if (!prune) return null;
  const session = sessionSummary(usage, null);
  const s = session.viaPrune > 0 ? session : lifetime;
  const live = Boolean(s && s.viaPrune > 0);
  return (
    <button className="prune-pill" data-live={live} onClick={() => set({ tab: 'usage', view: 'agents' })} title="Token usage and Prune AI savings">
      <span className="prune-dot" aria-hidden />
      Prune
      {live && s ? (
        <>
          <b>{usd(s.savedUsd)}</b> saved · {compact(s.tokensSaved)} tokens
        </>
      ) : (
        <span className="prune-idle">{session.calls ? 'bypassed' : 'ready'}</span>
      )}
    </button>
  );
}
