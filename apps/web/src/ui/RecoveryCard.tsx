import { applyCandidate } from '../actions';
import { useStore } from '../store';
import { RecoveryChart } from './Charts';
import './RecoveryCard.css';

export function RecoveryCard() {
  const report = useStore((s) => s.report);
  const recovering = useStore((s) => s.recovering);
  const appliedId = useStore((s) => s.appliedId);
  const open = useStore((s) => s.reportOpen);
  const set = useStore((s) => s.set);
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
            <div key={c.id} className="candidate" data-winner={c.id === report.winnerId}>
              <div className="candidate-text">
                <b>{c.title}</b>
                <small>{c.author}</small>
                <p className="candidate-why">{c.rationale}</p>
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
