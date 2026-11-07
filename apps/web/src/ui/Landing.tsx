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
    <div className="refusal" role="status">
      <b>Nothing was built</b>
      <p>{refusal.reason}</p>
      {closest && (
        <p>
          The closest fit is {closest.label.toLowerCase()}: {closest.blurb.toLowerCase()}.
        </p>
      )}
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
      <div className="landing-main">
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
            {building ? 'Building…' : 'Build'}
          </button>
        </form>
        {building ? (
          <ol className="hero-steps" aria-live="polite">
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
            <section className="prompts" aria-labelledby="prompts-title">
              <h2 id="prompts-title">Or start from one of these</h2>
              <ul>
                {EXAMPLES.map((example) => (
                  <li key={example}>
                    <button onClick={() => submit(example)}>{example}</button>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
      <aside className="landing-domains" aria-labelledby="domains-title">
        <h2 id="domains-title">What it can build</h2>
        <dl>
          {domainList().map((d) => (
            <div key={d.id}>
              <dt>{d.label}</dt>
              <dd>{d.blurb}</dd>
            </div>
          ))}
        </dl>
        <p className="landing-honest">If it can't model what you describe, it says so instead of guessing.</p>
      </aside>
    </div>
  );
}
