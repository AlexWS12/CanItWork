import { money, type Candidate, type RecoveryReport } from '@tv/core';
import { useEffect, useState, type CSSProperties } from 'react';
import { applyCandidate } from '../actions';
import { useStore } from '../store';
import { RecoveryChart } from './Charts';
import { AGENT_LABEL, ENGINE_LABEL } from './labels';
import './RecoveryCard.css';

const STAGGER_MS = 80;

const EFFORT_LABEL = { low: 'Low effort', medium: 'Medium effort', high: 'High effort' } as const;

const AI_ESTIMATE = 'Written by the AI from what the fix changes. The simulator does not check it.';

// What a fix adds to the monthly bill, shaded like effort: free or saving, a modest addition, or a big one.
function Monthly({ usd }: { usd: number | undefined }) {
  if (usd === undefined) return null;
  return (
    <span className="effort" data-effort={usd <= 0 ? 'low' : usd < 200 ? 'medium' : 'high'} title="From the price list: what this fix adds to the monthly running cost">
      {money(usd, true)}
    </span>
  );
}

// Proposals race as score bars against the "no incident" and "do nothing" markers
function Race({ report, chosen, picking, onPick }: { report: RecoveryReport; chosen: Candidate | undefined; picking: boolean; onPick: (c: Candidate) => void }) {
  const { candidates } = report;
  const max = Math.max(1, report.reference.score, report.unmitigated.score, ...candidates.map((c) => c.evaluation.score));
  const at = (score: number) => ({ ['--at' as string]: score / max }) as CSSProperties;
  // Close markers put their labels on two lines so they don't collide
  const close = Math.abs(report.reference.score - report.unmitigated.score) / max < 0.3;
  return (
    <div className="race" data-close={close}>
      <span className="race-mark" data-kind="reference" style={at(report.reference.score)} aria-hidden />
      <span className="race-label" data-kind="reference" style={at(report.reference.score)}>
        nothing wrong {report.reference.score}
      </span>
      <span className="race-mark" data-kind="unmitigated" style={at(report.unmitigated.score)} aria-hidden />
      <span className="race-label" data-kind="unmitigated" style={at(report.unmitigated.score)}>
        do nothing {report.unmitigated.score}
      </span>
      {candidates.map((c, i) => {
        const row = (
          <>
            <span className="race-name">
              <b>{c.title}</b>
              <small>
                {c.effort && (
                  <span className="effort" data-effort={c.effort}>
                    {EFFORT_LABEL[c.effort]}
                  </span>
                )}
                <Monthly usd={c.monthly} />
                {c.cost ? <span title={AI_ESTIMATE}>{c.cost}</span> : c.author}
              </small>
            </span>
            <span className="race-track">
              <span
                className="race-fill"
                style={{
                  width: `${(c.evaluation.score / max) * 100}%`,
                  // Rows are sorted best first, so the winner lands last
                  animationDelay: `${(candidates.length - 1 - i) * STAGGER_MS}ms`,
                }}
              />
            </span>
            <span className="race-score">{c.evaluation.score}</span>
          </>
        );
        const props = { className: 'race-row', 'data-winner': c.id === (report.valueId ?? report.winnerId), 'data-chosen': c.id === chosen?.id };
        return picking ? (
          <button key={c.id} {...props} aria-pressed={c.id === chosen?.id} onClick={() => onPick(c)}>
            {row}
          </button>
        ) : (
          <div key={c.id} {...props}>
            {row}
          </div>
        );
      })}
    </div>
  );
}

export function RecoveryCard() {
  const report = useStore((s) => s.report);
  const recovering = useStore((s) => s.recovering);
  const appliedId = useStore((s) => s.appliedId);
  const open = useStore((s) => s.reportOpen);
  const steps = useStore((s) => s.steps);
  const set = useStore((s) => s.set);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [details, setDetails] = useState(false);
  useEffect(() => {
    setSelectedId(null);
    setPicking(false);
    setDetails(false);
  }, [report]);
  if (!report) {
    return recovering ? <div className="recovery slim">Agents are working on a recovery plan…</div> : null;
  }
  const applied = report.candidates.find((c) => c.id === appliedId);
  if (!open && applied) {
    return (
      <div className="recovery slim applied">
        <span>
          Applied {applied.title}: {applied.evaluation.score} against {report.unmitigated.score} if you'd done nothing
        </span>
        <button onClick={() => set({ reportOpen: true })}>Compare</button>
        <button aria-label="Dismiss" onClick={() => set({ report: null })}>
          ×
        </button>
      </div>
    );
  }
  const winner = report.candidates.find((c) => c.id === report.winnerId);
  // The recommendation is the cheapest fix that scores about as well as the best
  const recommended = report.candidates.find((c) => c.id === report.valueId) ?? winner;
  const chosen = applied ?? report.candidates.find((c) => c.id === selectedId) ?? recommended;
  const cheaper = recommended && winner && recommended.id !== winner.id ? winner : null;
  const latest = [...steps].reverse();
  const council = latest.find((s) => s.agent === 'council');
  const analyst = latest.find((s) => s.agent === 'analyst' && s.status === 'done');
  const unit = report.reference.scoreLabel.replace(/^%\s*/, '');
  const pct = report.reference.scoreLabel.startsWith('%') ? '%' : '';
  // How much the problem cost, against running with no problem at all
  const hurt = Math.round((report.reference.score - report.unmitigated.score) * 10) / 10;
  const minor = hurt <= Math.max(1, report.reference.score * 0.02);
  const title =
    report.headline ??
    (!report.candidates.length
      ? 'Nothing to recover with'
      : minor
        ? `This barely hurt: ${unit} only fell to ${report.unmitigated.score}${pct}`
        : `Best fix: ${recommended?.title}`);
  const showDetails = details || picking;
  return (
    <section className="recovery card" data-details={showDetails} aria-labelledby="recovery-title">
      <header className="rc-head">
        <span className="kicker">
          {report.incident} · {AGENT_LABEL.council}
          {council && ` · ${ENGINE_LABEL[council.engine]}`} · {report.candidates.length} {report.candidates.length === 1 ? 'fix' : 'fixes'} tested in the simulator
        </span>
        <div className="rc-tools">
          {report.candidates.length > 0 && (
            <button className="rc-toggle" aria-expanded={showDetails} onClick={() => setDetails(!showDetails)}>
              {showDetails ? 'Hide details' : 'Compare fixes'}
            </button>
          )}
          <button className="sheet-close" aria-label="Dismiss" onClick={() => set({ report: null })}>
            ×
          </button>
        </div>
      </header>
      <h3 id="recovery-title" className="rc-headline">
        {title}
      </h3>
      <div className="rc-outcomes" aria-label={`${report.reference.scoreLabel} by outcome`}>
        <div data-kind="reference">
          <b>
            {report.reference.score}
            {pct}
          </b>
          <span>if nothing went wrong</span>
        </div>
        <div data-kind="unmitigated">
          <b>
            {report.unmitigated.score}
            {pct}
          </b>
          <span>if you do nothing</span>
        </div>
        {chosen && (
          <div data-kind="fix">
            <b>
              {chosen.evaluation.score}
              {pct}
            </b>
            <span>with {chosen.title}</span>
          </div>
        )}
        <p className="rc-unit">Measured as {report.reference.scoreLabel}</p>
      </div>
      {minor && report.candidates.length > 0 && !report.headline && (
        <p className="rc-note">
          The simulator says this problem costs you {hurt > 0 ? `${hurt} points` : 'nothing'}, so a fix is optional. Try a bigger problem to see the agents earn their keep.
        </p>
      )}
      {chosen?.monthly !== undefined && (
        <p className="rc-cost">
          <Monthly usd={chosen.monthly} />
          <span className="rc-source" data-kind="price">
            Price list
          </span>
        </p>
      )}
      {chosen?.effort && (
        <p className="rc-cost">
          <span className="effort" data-effort={chosen.effort}>
            {EFFORT_LABEL[chosen.effort]}
          </span>
          {chosen.cost && <span className="rc-cost-text">{chosen.cost}</span>}
          <span className="rc-source" data-kind="ai" title={AI_ESTIMATE}>
            AI estimate
          </span>
        </p>
      )}
      {cheaper && chosen?.id === recommended?.id && (
        <p className="rc-why">
          Recommended over <b>{cheaper.title}</b> ({cheaper.evaluation.score}
          {pct}
          {cheaper.effort && `, ${EFFORT_LABEL[cheaper.effort].toLowerCase()}`}
          {cheaper.monthly !== undefined && `, ${money(cheaper.monthly, true)}`}): it gets nearly the same result for less.
        </p>
      )}
      {chosen && (
        <p className="rc-why">
          {!showDetails && (
            <>
              <b>Why it works:</b> {chosen.rationale}{' '}
            </>
          )}
          {report.tradeoff && chosen.id === recommended?.id && (
            <>
              <b>Trade-off:</b> {report.tradeoff}
            </>
          )}
        </p>
      )}
      {showDetails && (
        <div className="rc-details">
          <div className="rc-chart">
            <RecoveryChart report={report} />
            <p className="sheet-summary">
              {analyst && (
                <span className="sheet-by">
                  {AGENT_LABEL[analyst.agent]} · {ENGINE_LABEL[analyst.engine]}:{' '}
                </span>
              )}
              {report.summary}
            </p>
          </div>
          {report.candidates.length > 0 && (
            <Race
              report={report}
              chosen={chosen}
              picking={picking && !applied}
              onPick={(c) => {
                setSelectedId(c.id);
                setPicking(false);
              }}
            />
          )}
        </div>
      )}
      {chosen && (
        <div className="sheet-actions">
          <button className="apply" onClick={() => applyCandidate(chosen)} disabled={appliedId !== null}>
            {applied ? 'Applied' : 'Apply'} {chosen.title}
          </button>
          {report.candidates.length > 1 && !applied && (
            <button className="pick" aria-pressed={picking} onClick={() => setPicking(!picking)}>
              {picking ? 'Cancel' : 'Pick another'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
