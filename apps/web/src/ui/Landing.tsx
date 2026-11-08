import { DOMAINS, domainList, type DomainId } from '@tv/core';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { buildEnvironment } from '../actions';
import { useStore } from '../store';
import { Building } from './Building';
import './Landing.css';

const pick = <T,>(items: T[]) => items[Math.floor(Math.random() * items.length)];

const HARDWARE: DomainId[] = ['electronics'];
const SOFTWARE: DomainId[] = ['software', 'database'];
const groupOf = (id: DomainId) => (HARDWARE.includes(id) ? 0 : SOFTWARE.includes(id) ? 1 : 2);

// One example each from hardware, software and operations, so three prompts still show the range
function featuredExamples() {
  const groups: Array<ReturnType<typeof domainList>> = [[], [], []];
  for (const d of domainList()) groups[groupOf(d.id)].push(d);
  return groups.filter((group) => group.length).map((group) => pick(pick(group).examples));
}

// The server lists prompts it can rebuild from verified designs: they open instantly and cost no model calls, so they are featured when there is one for each group.
function useFeatured() {
  const [featured, setFeatured] = useState(featuredExamples);
  useEffect(() => {
    let live = true;
    fetch('/api/examples')
      .then((res) => (res.ok ? (res.json() as Promise<{ examples?: Array<{ prompt: string; domain: DomainId }> }>) : null))
      .then((body) => {
        const verified = body?.examples ?? [];
        if (!live || !verified.length) return;
        const fallback = featuredExamples();
        setFeatured(
          [0, 1, 2]
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
  return featured;
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

// "Can it?", then "Work?", then the two words slide together into the wordmark
function IntroTitle() {
  const canIt = useRef<HTMLSpanElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    playIntro();
    const measure = () => canIt.current && setW(canIt.current.getBoundingClientRect().width);
    measure();
    void document.fonts.ready.then(measure);
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  return (
    <h1 aria-label="CanItWork" className="intro-title" style={{ '--canit-w': `${w}px` } as CSSProperties}>
      <span className="intro-q intro-can" aria-hidden>
        Can it?
      </span>
      <span className="intro-q intro-work" aria-hidden>
        Work?
      </span>
      <span className="intro-merged" aria-hidden>
        <span ref={canIt} className="intro-canit">
          CanIt
        </span>
        <span className="intro-worked">Work</span>
      </span>
    </h1>
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
  const featured = useFeatured();
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
  if (building) return <Building />;
  return (
    <div className="landing">
      <header className="landing-head">
        <IntroTitle />
        <p className="tagline">
          {TAGLINE.map((phrase, i) => (
            <span key={phrase} className="phrase" style={{ '--i': i } as CSSProperties}>
              {`${phrase} `}
            </span>
          ))}
        </p>
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
          <button type="submit" disabled={!text.trim()}>
            Build
          </button>
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
        <h2 id="domains-title">What it can build</h2>
        <ul className="domain-chips">
          {domainList().map((d, i) => (
            <li key={d.id} style={{ '--i': i } as CSSProperties}>
              <button aria-pressed={selected === d.id} onClick={() => setSelected(selected === d.id ? null : d.id)}>
                {d.label}
              </button>
            </li>
          ))}
        </ul>
        <p className="landing-honest">If it can't model what you describe, it says so instead of guessing.</p>
        {domain && (
          // Keyed by domain so choosing another chip remounts the card and replays its reveal
          <div key={domain.id} className="domain-detail">
            <p>{domain.blurb}</p>
            <ul className="prompt-list">
              {domain.examples.map((example, i) => (
                <li key={example} style={{ '--i': i } as CSSProperties}>
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
