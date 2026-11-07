import { DOMAINS, domainList, type DomainId } from '@tv/core';
import { useRef, useState } from 'react';
import { buildEnvironment } from '../actions';
import { useStore } from '../store';
import { Building } from './Building';
import './Landing.css';

const pick = <T,>(items: T[]) => items[Math.floor(Math.random() * items.length)];

// One example each from hardware, software and operations, so three prompts still show the range
function featuredExamples() {
  const hardware = domainList().filter((d) => d.id === 'electronics');
  const software = domainList().filter((d) => d.id === 'software' || d.id === 'database');
  const operations = domainList().filter((d) => !hardware.includes(d) && !software.includes(d));
  return [hardware, software, operations].filter((group) => group.length).map((group) => pick(pick(group).examples));
}

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
  const [featured] = useState(featuredExamples);
  const [selected, setSelected] = useState<DomainId | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const building = useStore((s) => s.building);
  const messages = useStore((s) => s.messages);
  const last = messages[messages.length - 1];
  const submit = (prompt: string) => {
    if (prompt.trim() && !building) void buildEnvironment(prompt.trim());
  };
  // Examples fill the input rather than building, so they can be edited first
  const use = (example: string) => {
    setText(example);
    input.current?.focus();
  };
  const domain = selected ? DOMAINS[selected] : null;
  if (building) return <Building />;
  return (
    <div className="landing">
      <header className="landing-head">
        <h1>tv</h1>
        <p className="tagline">Describe a system. Run it. Break it. Fix it.</p>
      </header>
      <div className="landing-main">
        <form
          className="hero-input"
          onSubmit={(e) => {
            e.preventDefault();
            submit(text);
          }}
        >
          <textarea
            ref={input}
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
          <button type="submit" disabled={!text.trim()}>
            Build
          </button>
        </form>
        <Refusal />
        {last?.role === 'app' && <p className="landing-note">{last.text}</p>}
        <section className="prompts" aria-labelledby="prompts-title">
          <h2 id="prompts-title">Try</h2>
          <ul className="prompt-list">
            {featured.map((example) => (
              <li key={example}>
                <button onClick={() => use(example)}>{example}</button>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <section className="landing-domains" aria-labelledby="domains-title">
        <h2 id="domains-title">What it can build</h2>
        <ul className="domain-chips">
          {domainList().map((d) => (
            <li key={d.id}>
              <button aria-pressed={selected === d.id} onClick={() => setSelected(selected === d.id ? null : d.id)}>
                {d.label}
              </button>
            </li>
          ))}
        </ul>
        <p className="landing-honest">If it can't model what you describe, it says so instead of guessing.</p>
        {domain && (
          <div className="domain-detail">
            <p>{domain.blurb}</p>
            <ul className="prompt-list">
              {domain.examples.map((example) => (
                <li key={example}>
                  <button onClick={() => use(example)}>{example}</button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
