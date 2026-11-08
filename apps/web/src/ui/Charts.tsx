import type { Point, RecoveryReport } from '@tv/core';
import './Charts.css';

const SW = 80;
const SH = 30;

export function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return <svg className="spark" viewBox={`0 0 ${SW} ${SH}`} aria-hidden />;
  const max = Math.max(...values, 1);
  const points = values.map((v, i) => `${((i / (values.length - 1)) * SW).toFixed(1)},${(SH - 1 - (v / max) * (SH - 2)).toFixed(1)}`).join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${SW} ${SH}`} role="img" aria-label={label}>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const W = 460;
const H = 170;
const PAD = { top: 8, right: 118, bottom: 22, left: 30 };
const LABEL_CHARS = 13;

const short = (text: string) => (text.length > LABEL_CHARS ? `${text.slice(0, LABEL_CHARS - 1).trimEnd()}…` : text);

export function RecoveryChart({ report }: { report: RecoveryReport }) {
  const winner = report.candidates.find((c) => c.id === report.winnerId);
  const others = report.candidates.filter((c) => c.id !== report.winnerId);
  const all = [report.reference, report.unmitigated, ...report.candidates.map((c) => c.evaluation)];
  const maxT = Math.max(1, ...all.flatMap((e) => e.series.map((p) => p.t)));
  const values = all.flatMap((e) => e.series.map((p) => p.value));
  const top = Math.max(1, ...values);
  const low = Math.min(...values);
  // Zoom in when every line sits near the top, so a 99.9 against 100 is visible rather than one flat line
  const minY = low > top * 0.5 ? Math.max(0, Math.floor(low - Math.max(1, (top - low) * 0.25))) : 0;
  const maxY = top === minY ? top + 1 : top;
  const x = (t: number) => PAD.left + (t / maxT) * (W - PAD.left - PAD.right);
  const y = (v: number) => H - PAD.bottom - ((v - minY) / (maxY - minY)) * (H - PAD.top - PAD.bottom);
  const line = (series: Point[]) => series.map((p) => `${x(p.t).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const finish = (series: Point[]) => series[series.length - 1]?.value ?? 0;

  const labels = [
    { text: 'Nothing wrong', value: report.reference.score, end: finish(report.reference.series), cls: 'ref' },
    winner && { text: short(winner.title), value: winner.evaluation.score, end: finish(winner.evaluation.series), cls: 'win' },
    { text: 'Do nothing', value: report.unmitigated.score, end: finish(report.unmitigated.series), cls: 'bad' },
  ].filter(Boolean) as Array<{ text: string; value: number; end: number; cls: string }>;

  // The band between the winner and doing nothing is what the recovery saved
  const after = (series: Point[]) => series.filter((p) => p.t >= report.tick);
  const won = winner ? after(winner.evaluation.series) : [];
  const lost = after(report.unmitigated.series);
  const saved = winner ? Math.round((winner.evaluation.score - report.unmitigated.score) * 10) / 10 : 0;
  const band = won.length > 1 && lost.length > 1 ? `${line(won)} ${line([...lost].reverse())}` : null;
  const mid = won[Math.floor(won.length * 0.6)];
  const near = mid && lost.reduce((best, p) => (Math.abs(p.t - mid.t) < Math.abs(best.t - mid.t) ? p : best), lost[0]);

  const placed = labels.map((l) => ({ ...l, yPos: y(l.end) })).sort((a, b) => a.yPos - b.yPos);
  for (let i = 1; i < placed.length; i++) {
    if (placed[i].yPos - placed[i - 1].yPos < 16) placed[i].yPos = placed[i - 1].yPos + 16;
  }

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${report.reference.scoreLabel} for each outcome`}>
      {[0, 0.5, 1].map((f) => {
        const v = minY + (maxY - minY) * f;
        return (
          <g key={f}>
            <line className="axis" x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />
            <text className="tick-label" x={PAD.left - 6} y={y(v) + 3} textAnchor="end">
              {Math.round(v * 10) / 10}
            </text>
          </g>
        );
      })}
      <line className="incident" x1={x(report.tick)} x2={x(report.tick)} y1={PAD.top} y2={H - PAD.bottom} />
      <text className="tick-label incident-label" x={x(report.tick)} y={H - 6} textAnchor="middle">
        incident
      </text>
      {band && <polygon className="band" points={band} />}
      <polyline className="ref" points={line(report.reference.series)} />
      {others.map((c) => (
        <polyline key={c.id} className="alt" points={line(c.evaluation.series)} />
      ))}
      <polyline className="bad" points={line(report.unmitigated.series)} />
      {winner && <polyline className="win" points={line(winner.evaluation.series)} />}
      {band && saved > 0 && mid && near && (
        <text className="saved" x={x(mid.t)} y={(y(mid.value) + y(near.value)) / 2 + 4} textAnchor="middle">
          +{saved} saved
        </text>
      )}
      {placed.map((l) => (
        <text key={l.text} className={`end-label ${l.cls}`} x={W - PAD.right + 8} y={l.yPos + 4}>
          <tspan fontWeight="600">{l.value}</tspan> {l.text}
        </text>
      ))}
    </svg>
  );
}
