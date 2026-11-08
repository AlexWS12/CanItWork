import { DOMAINS, buildGuide, guideText, type CircuitSpec } from '@tv/core';
import { useMemo, useState } from 'react';
import { useStore } from '../store';
import './BuildGuide.css';

// What a person needs to build the circuit for real: parts to buy and steps that name breadboard holes.
export function BuildGuidePanel() {
  const environment = useStore((s) => s.environment);
  const [copied, setCopied] = useState(false);
  const guide = useMemo(() => (environment?.domain === 'electronics' ? buildGuide(DOMAINS.electronics.compile(environment.spec) as CircuitSpec) : null), [environment]);
  if (!environment || !guide) return <p className="guide-empty">Build an electronics circuit to get its parts list and wiring steps.</p>;
  const text = guideText(environment.name, guide);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${environment.name.replace(/[^\w-]+/g, '-').toLowerCase() || 'circuit'}-build-guide.md`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const unresolved = environment.unmodelled.some((u) => u.startsWith('Still failing'));
  return (
    <div className="guide">
      <div className="guide-actions">
        <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        <button onClick={download}>Download .md</button>
      </div>
      {unresolved && <p className="guide-warning">This design still fails some checks, so build it only to see the failure.</p>}
      <h3>Parts</h3>
      <ul className="guide-bom">
        {guide.bom.map((line) => (
          <li key={line.item}>
            <b>{line.qty}×</b> {line.item}
          </li>
        ))}
      </ul>
      <h3>Steps</h3>
      <ol className="guide-steps">
        {guide.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
    </div>
  );
}
