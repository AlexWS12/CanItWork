import { DOMAINS, domainList, type DomainId } from '@tv/core';
import { useEffect, useRef, useState } from 'react';
import { buildEnvironment } from '../actions';
import { useStore } from '../store';
import { Building } from './Building';
import './Landing.css';

const pick = <T,>(items: T[]) => items[Math.floor(Math.random() * items.length)];

type Verified = { prompt: string; domain: DomainId };

const GROUPS = ['Hardware', 'Software', 'Operations', 'Robots and drones'] as const;

// The agents behind every build, in every domain. Agents propose; the simulator decides.
const TEAM = [
  { name: 'Interpreter', engine: 'Jev + Gemini', does: 'works out which simulator fits what you described, or says none does' },
  { name: 'Architect', engine: 'Gemini', does: 'designs the system; with the Design Council on, three Swarms architects compete and the simulator picks the winner' },
  { name: 'Validator', engine: 'Simulator', does: 'runs the design and sends it back with what failed until it passes' },
  { name: 'Reviewer', engine: 'Gemini', does: 'checks the design against what you asked for and sends back anything it shrank or left out' },
  { name: 'Red Team', engine: 'Swarms', does: 'predicts how the design breaks; the simulator confirms or refutes every claim' },
  { name: 'Recovery Council', engine: 'Swarms', does: 'proposes fixes after a failure; the simulator ranks them by what they actually do' },
];
const groupOf = (id: DomainId) => (id === 'electronics' ? 0 : id === 'software' || id === 'database' ? 1 : id === 'fleet' ? 3 : 2);
const grouped = () => {
  const groups: Array<ReturnType<typeof domainList>> = GROUPS.map(() => []);
  for (const d of domainList()) groups[groupOf(d.id)].push(d);
  return groups;
};

// One example from each group, so four prompts still show the whole range
function featuredExamples() {
  return grouped()
    .filter((group) => group.length)
    .map((group) => pick(pick(group).examples));
}

// The server lists prompts it can rebuild from verified designs: they open instantly and cost no model calls, so they are featured when there is one for each group.
function useFeatured() {
  const [featured, setFeatured] = useState(featuredExamples);
  const [verified, setVerified] = useState<Verified[]>([]);
  useEffect(() => {
    let live = true;
    fetch('/api/examples')
      .then((res) => (res.ok ? (res.json() as Promise<{ examples?: Array<{ prompt: string; domain: DomainId }> }>) : null))
      .then((body) => {
        const verified = (body?.examples ?? []).filter((v) => v.domain in DOMAINS);
        if (!live || !verified.length) return;
        setVerified(verified);
        const fallback = featuredExamples();
        setFeatured(
          GROUPS.map((_, group) => group)
            .map((group, i) => {
              const options = verified.filter((v) => v.domain in DOMAINS && groupOf(v.domain) === group);
              return options.length ? pick(options).prompt : fallback[i];
            })
            .filter(Boolean),
        );
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return { featured, verified };
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
  const { featured, verified } = useFeatured();
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
  // A domain's verified designs come first: they open instantly with no model calls
  const ready = domain ? verified.filter((v) => v.domain === domain.id).map((v) => v.prompt) : [];
  const examples = domain ? [...ready, ...domain.examples.filter((e) => !ready.includes(e))].slice(0, 4) : [];
  if (building) return <Building />;
  return (
    <div className="landing">
      <header className="landing-head">
        <h1>CanItWork</h1>
        <p className="tagline">Describe a system. Run it. Break it. Fix it.</p>
        <div className="agent-team">
          <p>A team of AI agents designs, attacks and repairs every system you describe. The simulator settles every argument.</p>
          <ol aria-label="The agents behind every build">
            {TEAM.map((agent) => (
              <li key={agent.name} title={`${agent.name} (${agent.engine}) ${agent.does}`}>
                <span className="agent-pill" data-engine={agent.engine === 'Swarms' ? 'swarms' : undefined}>
                  <b>{agent.name}</b>
                  <small>{agent.engine}</small>
                </span>
              </li>
            ))}
          </ol>
        </div>
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
        <h2 id="domains-title">What it can build · {domainList().length} kinds of system</h2>
        <div className="domain-groups">
          {grouped().map((group, i) =>
            group.length ? (
              <div className="domain-group" key={GROUPS[i]}>
                <h3>{GROUPS[i]}</h3>
                <ul className="domain-chips">
                  {group.map((d) => (
                    <li key={d.id}>
                      <button aria-pressed={selected === d.id} onClick={() => setSelected(selected === d.id ? null : d.id)}>
                        {d.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
        </div>
        <p className="landing-honest">If it can't model what you describe, it says so instead of guessing.</p>
        {domain && (
          <div className="domain-detail">
            <p>{domain.blurb}</p>
            <ul className="prompt-list">
              {examples.map((example) => (
                <li key={example}>
                  <button onClick={() => use(example)}>
                    {example}
                    {ready.includes(example) && (
                      <span className="ready" title="Passed every check before: opens instantly with no model calls">
                        verified
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
