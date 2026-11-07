import { DOMAINS, domainList } from '@tv/core';
import { useState } from 'react';
import { buildEnvironment } from '../actions';
import { useStore } from '../store';
import './Landing.css';

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
