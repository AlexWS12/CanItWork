import type { Candidate, RecoveryReport } from '@tv/core';
import { useEffect, useState, type CSSProperties } from 'react';
import { applyCandidate } from '../actions';
import { useStore } from '../store';
import { RecoveryChart } from './Charts';
import { AGENT_LABEL, ENGINE_LABEL } from './labels';
import './RecoveryCard.css';

const STAGGER_MS = 80;

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
        no incident {report.reference.score}
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
              <small>{c.author}</small>
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
        const props = { className: 'race-row', 'data-winner': c.id === report.winnerId, 'data-chosen': c.id === chosen?.id };
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
  useEffect(() => {
    setSelectedId(null);
    setPicking(false);
  }, [report]);
  if (!report) {
    return recovering ? <div className="recovery slim">Agents are working on a recovery plan…</div> : null;
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
  const winner = report.candidates.find((c) => c.id === report.winnerId);
  const chosen = applied ?? report.candidates.find((c) => c.id === selectedId) ?? winner;
  const latest = [...steps].reverse();
  const council = latest.find((s) => s.agent === 'council');
  const analyst = latest.find((s) => s.agent === 'analyst' && s.status === 'done');
  return (
    <section className="recovery sheet" aria-labelledby="recovery-title">
      <div className="sheet-chart">
        <span className="kicker">{report.reference.scoreLabel}</span>
        <RecoveryChart report={report} />
        <p className="sheet-summary">
          {analyst && (
            <span className="sheet-by">
              {AGENT_LABEL[analyst.agent]} · {ENGINE_LABEL[analyst.engine]} —{' '}
            </span>
          )}
          {report.summary}
        </p>
      </div>
      <div className="sheet-race">
        <header>
          <div>
            <span className="kicker">
              {AGENT_LABEL.council}
              {council && ` · ${ENGINE_LABEL[council.engine]}`}
            </span>
            <h3 id="recovery-title">{report.candidates.length ? 'The simulator picked a winner' : 'Nothing to recover with'}</h3>
          </div>
          <button className="sheet-close" aria-label="Dismiss" onClick={() => set({ report: null })}>
            ×
          </button>
        </header>
        {report.candidates.length ? (
          <Race
            report={report}
            chosen={chosen}
            picking={picking && !applied}
            onPick={(c) => {
              setSelectedId(c.id);
              setPicking(false);
            }}
          />
        ) : (
          <p className="sheet-empty">No recovery options for this incident.</p>
        )}
        {chosen && (
          <p className="sheet-why">
            <b>{chosen.title}</b> · {chosen.rationale}
          </p>
        )}
        {chosen && (
          <div className="sheet-actions">
            <button className="apply" onClick={() => applyCandidate(chosen)} disabled={appliedId !== null}>
              {applied ? 'Applied' : 'Apply'} {chosen.title} · {chosen.evaluation.score}
            </button>
            {report.candidates.length > 1 && !applied && (
              <button className="pick" aria-pressed={picking} onClick={() => setPicking(!picking)}>
                {picking ? 'Cancel' : 'Pick another'}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
