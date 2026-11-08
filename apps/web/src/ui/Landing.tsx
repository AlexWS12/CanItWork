import { DOMAINS, domainList, type DomainId } from '@tv/core';
import { useEffect, useState, type CSSProperties } from 'react';
import { buildEnvironment, showHero } from '../actions';
import { reducedMotion } from '../motion';
import { preloadModels, type ModelId } from '../scene/Model';
import { useStore } from '../store';
import { SignInButton } from './Account';
import { Building } from './Building';
import { SystemPanel } from './SystemPanel';
import { Wordmark } from './Wordmark';
import './Landing.css';

type Verified = { prompt: string; domain: DomainId };

const GROUPS = ['Hardware', 'Software', 'Operations', 'Robots and drones'] as const;

// The agents behind every build, in every domain. Agents propose; the simulator decides.
const TEAM = [
  { name: 'Understands your request', engine: 'Jev + Gemini', does: 'works out what kind of system you mean, or says honestly that it can’t model it' },
  { name: 'Designs it', engine: 'Gemini', does: 'draws up the parts and how they connect; it can ask three designers and keep the best version' },
  { name: 'Tests it', engine: 'Simulator', does: 'runs the design in a real simulator and sends it back with whatever failed, until everything passes' },
  { name: 'Reviewer', engine: 'Gemini', does: 'checks the design against what you asked for and sends back anything it shrank or left out' },
  { name: 'Looks for weak spots', engine: 'Swarms', does: 'imagines how it could go wrong, like a rush of visitors or a part failing, and the simulator tries each one' },
  { name: 'Finds fixes', engine: 'Swarms', does: 'when something breaks, suggests ways to recover, ranked by how well each one actually works' },
];
const groupOf = (id: DomainId) => (id === 'electronics' ? 0 : id === 'software' || id === 'database' ? 1 : id === 'fleet' ? 3 : 2);

// The server lists prompts it can rebuild from verified designs: they open instantly and cost no model calls
function useVerified() {
  const [verified, setVerified] = useState<Verified[]>([]);
  useEffect(() => {
    let live = true;
    fetch('/api/examples')
      .then((res) => (res.ok ? (res.json() as Promise<{ examples?: Verified[] }>) : null))
      .then((body) => {
        const found = (body?.examples ?? []).filter((v) => v.domain in DOMAINS);
        if (live && found.length) setVerified(found);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return verified;
}

// The live hero: real showcase designs take turns behind the page, each a simulation running, not a picture
const HERO: Array<{ id: DomainId; label: string }> = [
  { id: 'electronics', label: 'Breadboard' },
  { id: 'power', label: 'Power grid' },
  { id: 'supply', label: 'Supply chain' },
  { id: 'airport', label: 'Airport' },
  { id: 'queues', label: 'Supermarket' },
];
const HERO_SECONDS = 14;

// A small line icon per kind of system, drawn on a 24 by 24 grid
const ICON: Record<DomainId, string> = {
  electronics: 'M7 7h10v10H7z M10 4v3 M14 4v3 M10 17v3 M14 17v3 M4 10h3 M4 14h3 M17 10h3 M17 14h3',
  software: 'M3 5h7v5H3z M14 14h7v5h-7z M14 5h7v5h-7z M6.5 10v6.5H14 M10 7.5h4',
  database: 'M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3z M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6 M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3',
  warehouse: 'M3 20V4h18v16 M3 10h18 M3 15h18 M8 4v6 M14 10v5',
  power: 'M13 2L5 14h6l-1 8 8-12h-6z',
  water: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z',
  supply: 'M3 7h11v9H3z M14 10h4l3 3v3h-7 M6.5 18.5a1.5 1.5 0 1 0 0-.1 M17.5 18.5a1.5 1.5 0 1 0 0-.1',
  hospital: 'M9 3h6v6h6v6h-6v6H9v-6H3V9h6z',
  factory: 'M3 21V10l6 4V10l6 4V5h6v16z M7 17h2 M12 17h2',
  airport: 'M2 16l20-6-2-2-7 2-5-6H6l3 7-5 1-2-2H1z M3 21h18',
  callcenter: 'M4 14v-2a8 8 0 0 1 16 0v2 M4 14h3v6H4z M17 14h3v6h-3z',
  queues: 'M5 8a2 2 0 1 0 0-.1 M12 8a2 2 0 1 0 0-.1 M19 8a2 2 0 1 0 0-.1 M3 20v-4a2 2 0 0 1 4 0v4 M10 20v-4a2 2 0 0 1 4 0v4 M17 20v-4a2 2 0 0 1 4 0v4',
  fleet: 'M9 9h6v6H9z M9 9L5 5 M15 9l4-4 M9 15l-4 4 M15 15l4 4 M3 5a2 2 0 1 0 4 0a2 2 0 1 0-4 0 M17 5a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
};

// Every tool the app is built on, and what each one does here
const BUILT_WITH = [
  ['Gemini', 'designs and reviews'],
  ['TypeSafe Jev', 'picks the simulator'],
  ['Prune', 'routes the Gemini calls'],
  ['Swarms', 'weak spots and fixes'],
  ['Tiger Data', 'saves every run'],
  ['Auth0', 'sign-in and sharing'],
  ['Solana', 'proves when each run existed'],
  ['Vultr', 'hosting'],
  ['Kenney', 'CC0 3D models'],
] as const;

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1) + '.';

/** Which showcase runs behind the page: it moves on by itself until someone picks one, or not at all with reduced motion. */
function useHero() {
  const [turn, setTurn] = useState(0);
  const [held, setHeld] = useState(false);
  const current = HERO[turn % HERO.length];
  // One system fades out and the next fades in, rather than cutting from one to the other
  useEffect(() => {
    const stage = document.querySelector<HTMLElement>('canvas.stage, .stage');
    let live = true;
    const swap = async () => {
      if (stage && !reducedMotion()) {
        stage.style.opacity = '0';
        await new Promise((resolve) => setTimeout(resolve, 380));
      }
      if (!live) return;
      await showHero(current.id);
      // Gives the new view a moment to mount and start its glide before it shows
      setTimeout(() => stage && (stage.style.opacity = '1'), 220);
    };
    void swap();
    return () => {
      live = false;
      if (stage) stage.style.opacity = '1';
    };
  }, [current.id]);
  // Every pack model loads while the page is idle, so nothing pops in when its scene comes round
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 2000));
    idle(() => {
      void fetch('/models/manifest.json')
        .then((r) => (r.ok ? (r.json() as Promise<ModelId[]>) : []))
        .then(preloadModels)
        .catch(() => undefined);
    });
  }, []);
  useEffect(() => {
    if (held || reducedMotion()) return;
    const timer = setTimeout(() => setTurn((t) => t + 1), HERO_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [turn, held]);
  const choose = (i: number) => {
    setHeld(true);
    setTurn(i);
  };
  return { current, held, choose };
}

/** What is running behind the page, in the top right corner. */
function LiveReadout({ hero }: { hero: ReturnType<typeof useHero> }) {
  const name = useStore((s) => (s.showcase ? s.environment?.name : null));
  return (
    <aside className="stage-live" aria-label="Live simulation" aria-live="polite">
      <span className="now-kicker">
        <span className="now-dot" aria-hidden />
        Running live
      </span>
      <b>{name ?? 'Loading the scene'}</b>
      <span>{DOMAINS[hero.current.id].label} · every check passes</span>
    </aside>
  );
}

/** The row under the prompt that picks which system runs behind the page; the running one's underline fills as its turn runs out. */
function StageSwitch({ hero, total }: { hero: ReturnType<typeof useHero>; total: number }) {
  return (
    <nav className="stage-switch" aria-label="Pick a system to watch">
      {HERO.map((h, i) => (
        <button
          key={h.id}
          aria-pressed={hero.current.id === h.id}
          data-run={!hero.held && hero.current.id === h.id}
          style={{ '--hero': `${HERO_SECONDS}s` } as CSSProperties}
          onClick={() => hero.choose(i)}
        >
          {h.label}
        </button>
      ))}
      <a href="#systems">All {total} →</a>
    </nav>
  );
}

// The story under the hero, each beside a real capture of the app; the agents and the kinds of system sit between the chapters
const CHAPTERS = [
  {
    kicker: 'Describe it',
    title: 'Say what you want, in your own words.',
    body: 'A circuit, an app, a hospital on a busy night. One agent works out what kind of system you mean, and another draws a first blueprint while you watch.',
    by: 'Understands your request · Designs it',
    image: '/landing/draft.jpg',
    alt: 'A first draft of an emergency room drawn as a blue blueprint while it is checked',
  },
  {
    kicker: 'The simulator settles it',
    title: 'Nothing reaches you until it runs.',
    body: 'A real simulator runs every draft and sends it back with what failed. Only a design that passes every check turns solid.',
    by: 'Tests it · Checks it matches',
    image: '/landing/verified.jpg',
    alt: 'The verified emergency room running, with ambulances, beds, a scanner and people',
  },
  {
    kicker: 'Break it on purpose',
    title: 'Then break it, and see what recovers.',
    body: 'Knock out a part while it runs, or send a rush of people through it. One agent suggests ways to recover, and the simulator ranks them by what they actually do.',
    by: 'Looks for weak spots · Finds fixes',
    image: '/landing/break.jpg',
    alt: 'A power grid running: a solar field, a substation and a city',
  },
];

function Chapter({ index }: { index: number }) {
  const c = CHAPTERS[index];
  return (
    <section className="chapter" data-flip={index % 2 === 1} aria-labelledby={`chapter-${index}`}>
      <figure className="chapter-figure">
        <img src={c.image} alt={c.alt} width={760} height={520} loading="lazy" />
      </figure>
      <div className="chapter-copy">
        <span className="eyebrow">
          {String(index + 1).padStart(2, '0')} · {c.kicker}
        </span>
        <h2 id={`chapter-${index}`}>{c.title}</h2>
        <p>{c.body}</p>
        <span className="chapter-by">{c.by}</span>
      </div>
    </section>
  );
}

/** The prompt, in the hero and again at the end of the page; both share one draft. */
function PromptForm({ id, text, setText, submit, autoFocus }: { id: string; text: string; setText: (text: string) => void; submit: (text: string) => void; autoFocus?: boolean }) {
  return (
    <form
      className="hero-input"
      onSubmit={(e) => {
        e.preventDefault();
        submit(text);
      }}
    >
      <label htmlFor={id} className="sr-only">
        Describe a system
      </label>
      <textarea
        id={id}
        autoFocus={autoFocus}
        rows={1}
        value={text}
        placeholder="Describe a circuit, a warehouse, an app…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit(text);
          }
        }}
      />
      <button type="submit" disabled={!text.trim()}>
        Build it
      </button>
    </form>
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
      {refusal.signIn && <SignInButton />}
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
  const verified = useVerified();
  // The kind of system whose panel is open, from its tile
  const [panel, setPanel] = useState<DomainId | null>(null);
  const hero = useHero();
  const building = useStore((s) => s.building);
  const messages = useStore((s) => s.messages);
  const last = messages[messages.length - 1];
  const submit = (prompt: string) => {
    if (prompt.trim() && !building) void buildEnvironment(prompt.trim());
  };
  const kinds = domainList();
  // Each tile names one design of its kind; the panel it opens lists them all
  const exampleOf = (id: DomainId) => verified.find((v) => v.domain === id)?.prompt ?? DOMAINS[id].examples[0];
  if (building) return <Building />;
  return (
    <div className="landing">
      <section className="hero" id="top">
        <div className="stage-copy">
          <h1 className="hero-title">
            Describe a system.
            <br />
            Watch it run.
          </h1>
          <p className="hero-lede">Every scene here is a real design, running live and checked by the simulator.</p>
        </div>
        <LiveReadout hero={hero} />
        <div className="stage-prompt">
          <Refusal />
          {last?.role === 'app' && <p className="landing-note">{last.text}</p>}
          <PromptForm id="describe" text={text} setText={setText} submit={submit} autoFocus />
          <StageSwitch hero={hero} total={kinds.length} />
        </div>
      </section>

      <Chapter index={0} />
      <Chapter index={1} />

      <section className="landing-section" id="how" aria-labelledby="how-title">
        <div className="section-head">
          <div>
            <span className="eyebrow eyebrow-green">How it works</span>
            <h2 id="how-title">
              Six AI helpers check each other.
              <br />A simulator has the last word.
            </h2>
          </div>
          <p>They suggest; the simulator decides. Nothing reaches you until it has run and every test passes.</p>
        </div>
        <div className="relay">
          <ol className="agent-cards">
            {TEAM.map((agent, i) => (
              <li key={agent.name} style={{ '--i': i } as CSSProperties}>
                <span className="agent-top">
                  <span className="agent-n">{String(i + 1).padStart(2, '0')}</span>
                  <span className="agent-engine">{agent.engine}</span>
                </span>
                <b>{agent.name}</b>
                <span className="agent-does">{sentence(agent.does)}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <Chapter index={2} />

      <section className="landing-section landing-kinds" id="systems" aria-labelledby="systems-title">
        <div className="section-head">
          <div>
            <span className="eyebrow">What it can build</span>
            <h2 id="systems-title">
              {kinds.length === 13 ? 'Thirteen' : kinds.length} kinds of system.
              <br />
              <span className="hero-muted">From a breadboard to a power grid.</span>
            </h2>
          </div>
        </div>
        <ul className="kind-tiles">
          {kinds.map((d) => (
            <li key={d.id}>
              <button onClick={() => setPanel(d.id)} aria-haspopup="dialog">
                <span className="kind-top">
                  <span className="kind-icon" data-group={groupOf(d.id)} aria-hidden>
                    <svg width="24" height="24" viewBox="0 0 24 24">
                      <path d={ICON[d.id]} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <span className="kind-group">{GROUPS[groupOf(d.id)]}</span>
                </span>
                <b>{d.label}</b>
                <span className="kind-example">{exampleOf(d.id)}</span>
                <span className="kind-ready">See designs →</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="landing-band" aria-labelledby="close-title">
        <h2 id="close-title">Can it work? Find out.</h2>
        <PromptForm id="describe-again" text={text} setText={setText} submit={submit} />
        <p>If it can’t model what you describe, it says so instead of guessing.</p>
      </section>

      {panel && <SystemPanel domain={panel} onClose={() => setPanel(null)} />}

      <footer className="landing-footer">
        <Wordmark />
        <ul className="built-with" aria-label="Built with">
          {BUILT_WITH.map(([name, role]) => (
            <li key={name}>
              <b>{name}</b> {role}
            </li>
          ))}
        </ul>
      </footer>
    </div>
  );
}
