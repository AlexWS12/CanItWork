import { DOMAINS, domainList, type DomainId } from '@tv/core';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { buildEnvironment } from '../actions';
import { useStore } from '../store';
import { Building } from './Building';
import { MicButton } from './Dictation';
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

// The title intro plays once per page load. While it runs, the root carries data-intro="playing" and the
// CSS animations in Landing.css and TopBar.css apply; removing it shows every element in its end state.
const INTRO_MS = 4350;
let introStarted = false;

function playIntro() {
  if (introStarted) return;
  introStarted = true;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.documentElement.dataset.intro = 'playing';
  setTimeout(endIntro, INTRO_MS);
}

function endIntro() {
  delete document.documentElement.dataset.intro;
}

const TAGLINE = ['Describe a system.', 'Run it.', 'Break it.', 'Fix it.'];

// The wordmark on a circuit trace. The intro asks "Can it?", then "Work?", slides the words together into
// "CanItWork?", runs current from the amber power dot through the node under "It" to the teal output,
// and the "?" lifts away once it arrives. W is the width of "CanIt" (where the node sits), TW of the word.
function CircuitTitle() {
  const canIt = useRef<HTMLSpanElement>(null);
  const word = useRef<HTMLSpanElement>(null);
  const [{ w, tw }, setSize] = useState({ w: 310, tw: 560 });
  useLayoutEffect(() => {
    playIntro();
    const measure = () => {
      if (canIt.current && word.current) {
        setSize({ w: canIt.current.getBoundingClientRect().width, tw: word.current.getBoundingClientRect().width });
      }
    };
    measure();
    void document.fonts.ready.then(measure);
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  return (
    <div className="wm" style={{ '--w': `${w}px`, '--tw': `${tw}px` } as CSSProperties}>
      <h1 aria-label="CanItWork" className="wm-title">
        <span className="wm-q wm-q1" aria-hidden>
          Can it?
        </span>
        <span className="wm-q wm-q2" aria-hidden>
          Work<span className="wm-amber">?</span>
        </span>
        <span ref={word} className="wm-word" aria-hidden>
          <span ref={canIt} className="wm-canit">
            Can<span className="wm-it">It</span>
          </span>
          <span className="wm-work">Work</span>
        </span>
        {/* The wrapper rides with "Work" during the merge; the inner "?" lifts away on its own */}
        <span className="wm-qm" aria-hidden>
          <span className="wm-qm-glyph">?</span>
        </span>
      </h1>
      <svg className="wm-trace" width={tw} height="24" viewBox={`0 0 ${tw} 24`} aria-hidden>
        <line className="wm-seg wm-seg-a" x1="6" y1="12" x2={w} y2="12" pathLength={1} />
        <line className="wm-seg wm-seg-b" x1={w} y1="12" x2={tw - 6} y2="12" pathLength={1} />
        <circle className="wm-dot wm-d0" cx="6" cy="12" r="6" />
        <circle className="wm-dot wm-d1" cx={w} cy="12" r="5" />
        <circle className="wm-dot wm-d2" cx={tw - 6} cy="12" r="6" />
      </svg>
    </div>
  );
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
  // Examples build straight away; typing in the box is how to change one first
  const use = (example: string) => {
    endIntro();
    setText(example);
    submit(example);
  };
  const domain = selected ? DOMAINS[selected] : null;
  // A domain's verified designs come first: they open instantly with no model calls
  const ready = domain ? verified.filter((v) => v.domain === domain.id).map((v) => v.prompt) : [];
  const examples = domain ? [...ready, ...domain.examples.filter((e) => !ready.includes(e))].slice(0, 4) : [];
  if (building) return <Building />;
  return (
    <div className="landing">
      <header className="landing-head">
        <CircuitTitle />
        <p className="tagline">
          {TAGLINE.map((phrase, i) => (
            <span key={phrase} className="phrase" style={{ '--i': i } as CSSProperties}>
              {`${phrase} `}
            </span>
          ))}
        </p>
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
            onChange={(e) => {
              endIntro();
              setText(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit(text);
              }
            }}
          />
          <div className="hero-actions">
            <MicButton text={text} onText={setText} />
            <button type="submit" disabled={!text.trim()}>
              Build
            </button>
          </div>
        </form>
        <Refusal />
        {last?.role === 'app' && <p className="landing-note">{last.text}</p>}
        <section className="prompts" aria-labelledby="prompts-title">
          <h2 id="prompts-title">Try</h2>
          <ul className="prompt-list">
            {featured.map((example, i) => (
              <li key={example} style={{ '--i': i } as CSSProperties}>
                <button onClick={() => use(example)}>{example}</button>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <section className="landing-domains" aria-labelledby="domains-title" style={{ '--n': domainList().length } as CSSProperties}>
        <h2 id="domains-title">What it can build · {domainList().length} kinds of system</h2>
        <div className="domain-groups">
          {grouped().map((group, i) =>
            group.length ? (
              <div className="domain-group" key={GROUPS[i]}>
                <h3>{GROUPS[i]}</h3>
                <ul className="domain-chips">
                  {group.map((d) => (
                    <li key={d.id} style={{ '--i': domainList().findIndex((x) => x.id === d.id) } as CSSProperties}>
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
          // Keyed by domain so choosing another chip remounts the card and replays its reveal
          <div key={domain.id} className="domain-detail">
            <p>{domain.blurb}</p>
            <ul className="prompt-list">
              {examples.map((example, i) => (
                <li key={example} style={{ '--i': i } as CSSProperties}>
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
