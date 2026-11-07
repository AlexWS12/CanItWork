import type { Point, RecoveryReport } from '@tv/core';
import './Charts.css';

export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <svg className="spark" viewBox="0 0 120 34" aria-hidden />;
  const max = Math.max(...values, 1);
  const points = values.map((v, i) => `${(i / (values.length - 1)) * 120},${32 - (v / max) * 30}`).join(' ');
  return (
    <svg className="spark" viewBox="0 0 120 34" role="img" aria-label="Score over time">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const W = 460;
const H = 150;
const PAD = { top: 8, right: 118, bottom: 18, left: 30 };

export function RecoveryChart({ report }: { report: RecoveryReport }) {
  const winner = report.candidates.find((c) => c.id === report.winnerId);
  const others = report.candidates.filter((c) => c.id !== report.winnerId);
  const all = [report.reference, report.unmitigated, ...report.candidates.map((c) => c.evaluation)];
  const maxT = Math.max(1, ...all.flatMap((e) => e.series.map((p) => p.t)));
  const maxY = Math.max(1, ...all.flatMap((e) => e.series.map((p) => p.value)));
  const x = (t: number) => PAD.left + (t / maxT) * (W - PAD.left - PAD.right);
  const y = (v: number) => H - PAD.bottom - (v / maxY) * (H - PAD.top - PAD.bottom);
  const line = (series: Point[]) => series.map((p) => `${x(p.t).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const finish = (series: Point[]) => series[series.length - 1]?.value ?? 0;

  const labels = [
    { text: 'No incident', value: report.reference.score, end: finish(report.reference.series), cls: 'ref' },
    winner && { text: 'Best recovery', value: winner.evaluation.score, end: finish(winner.evaluation.series), cls: 'win' },
    { text: 'Do nothing', value: report.unmitigated.score, end: finish(report.unmitigated.series), cls: 'bad' },
  ].filter(Boolean) as Array<{ text: string; value: number; end: number; cls: string }>;

  const placed = labels.map((l) => ({ ...l, yPos: y(l.end) })).sort((a, b) => a.yPos - b.yPos);
  for (let i = 1; i < placed.length; i++) {
    if (placed[i].yPos - placed[i - 1].yPos < 16) placed[i].yPos = placed[i - 1].yPos + 16;
  }

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${report.reference.scoreLabel} for each outcome`}>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line className="axis" x1={PAD.left} x2={W - PAD.right} y1={y(maxY * f)} y2={y(maxY * f)} />
          <text className="tick-label" x={PAD.left - 6} y={y(maxY * f) + 3} textAnchor="end">
            {Math.round(maxY * f)}
          </text>
        </g>
      ))}
      <line className="incident" x1={x(report.tick)} x2={x(report.tick)} y1={PAD.top} y2={H - PAD.bottom} />
      <text className="tick-label" x={x(report.tick)} y={H - 6} textAnchor="middle">
        incident
      </text>
      <polyline className="ref" points={line(report.reference.series)} />
      {others.map((c) => (
        <polyline key={c.id} className="alt" points={line(c.evaluation.series)} />
      ))}
      <polyline className="bad" points={line(report.unmitigated.series)} />
      {winner && <polyline className="win" points={line(winner.evaluation.series)} />}
      {placed.map((l) => (
        <text key={l.text} className={`end-label ${l.cls}`} x={W - PAD.right + 8} y={l.yPos + 4}>
          <tspan fontWeight="600">{l.value}</tspan> {l.text}
        </text>
      ))}
    </svg>
  );
}
