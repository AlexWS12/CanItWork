import { DOMAINS, type DomainId } from '@tv/core';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { buildEnvironment, openSavedRun, openVerified, type Visibility } from '../actions';
import { authFetch, useAuth } from '../auth';
import { SignInButton, VISIBILITY_LABEL } from './Account';
import './SystemPanel.css';

// A kind of system, opened from its tile on the landing: what the simulator models, a prompt to build a new one,
// every verified design of that kind (each opens as is, free), the runs people chose to list, and your own saved ones.

type Verified = { prompt: string; name: string; summary: string };
type Listed = { id: string; name: string; ownerName: string | null; updatedAt: string };
type Mine = { id: string; name: string; domain: string; visibility: Visibility; updatedAt: string };

// The preview pictures made by `npm run capture -- --thumbs`, by the prompt each design answers
let thumbs: Promise<Record<string, string>> | null = null;
const thumbIndex = () =>
  (thumbs ??= fetch('/thumbs/index.json')
    .then((r) => (r.ok ? (r.json() as Promise<Record<string, string>>) : {}))
    .catch(() => ({})));

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

function useSystems(domain: DomainId) {
  const { account } = useAuth();
  const [verified, setVerified] = useState<Verified[] | null>(null);
  const [listed, setListed] = useState<Listed[]>([]);
  const [mine, setMine] = useState<Mine[] | null>(null);
  const [pictures, setPictures] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    setVerified(null);
    fetch(`/api/systems/${domain}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ verified: Verified[]; listed: Listed[] }>) : { verified: [], listed: [] }))
      .then((body) => {
        if (!live) return;
        setVerified(body.verified);
        setListed(body.listed);
      })
      .catch(() => live && setVerified([]));
    void thumbIndex().then((index) => live && setPictures(index));
    return () => {
      live = false;
    };
  }, [domain]);
  useEffect(() => {
    let live = true;
    setMine(null);
    if (!account) return;
    authFetch('/api/runs')
      .then((r) => (r.ok ? (r.json() as Promise<{ runs: Mine[] }>) : { runs: [] }))
      .then((body) => live && setMine(body.runs.filter((r) => r.domain === domain)))
      .catch(() => live && setMine([]));
    return () => {
      live = false;
    };
  }, [domain, account]);
  return { verified, listed, mine, pictures, signedIn: Boolean(account) };
}

export function SystemPanel({ domain, onClose }: { domain: DomainId; onClose: () => void }) {
  const info = DOMAINS[domain];
  const { verified, listed, mine, pictures, signedIn } = useSystems(domain);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const panel = useRef<HTMLElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  // Escape closes it, and focus starts inside it so keyboard users land where the content is
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    panel.current?.focus();
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const build = () => text.trim() && void buildEnvironment(text.trim());
  const shown = (verified ?? []).filter((v) => !query.trim() || `${v.name} ${v.summary} ${v.prompt}`.toLowerCase().includes(query.trim().toLowerCase()));

  // On the body, so it sits above the page header rather than inside the landing's own layer
  return createPortal(
    <div className="system-sheet" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="system-panel" ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="system-title">
        <header className="system-head">
          <div>
            <span className="eyebrow">Kind of system</span>
            <h2 id="system-title">{info.label}</h2>
          </div>
          <button className="system-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <p className="system-blurb">{info.blurb}.</p>
        <details className="system-capabilities">
          <summary>What it can model</summary>
          <p>{info.capabilities}</p>
        </details>

        <section className="system-build" aria-label={`Build a new ${info.label.toLowerCase()} system`}>
          <form
            className="hero-input"
            onSubmit={(e) => {
              e.preventDefault();
              build();
            }}
          >
            <label htmlFor="system-prompt" className="sr-only">
              Describe a new one
            </label>
            <textarea
              id="system-prompt"
              ref={box}
              rows={1}
              value={text}
              placeholder={`Describe a new one: ${info.examples[0]?.toLowerCase() ?? ''}`}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  build();
                }
              }}
            />
            <button type="submit" disabled={!text.trim()}>
              Build it
            </button>
          </form>
          {/* Ideas fill the box rather than build, so they can be changed first */}
          <div className="system-ideas">
            {info.examples.slice(0, 4).map((example) => (
              <button
                key={example}
                onClick={() => {
                  setText(example);
                  box.current?.focus();
                }}
              >
                {example}
              </button>
            ))}
          </div>
        </section>

        <section className="system-list" aria-labelledby="verified-title">
          <div className="system-list-head">
            <h3 id="verified-title">
              Verified designs <span>{verified ? verified.length : ''}</span>
            </h3>
            <span className="system-free">Open instantly · no AI spend</span>
          </div>
          {verified && verified.length > 6 && (
            <input
              className="system-search"
              type="search"
              placeholder={`Search ${verified.length} designs`}
              aria-label="Search verified designs"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          {!verified ? (
            <p className="system-empty">Loading…</p>
          ) : shown.length ? (
            <ul className="system-cards">
              {shown.map((v) => (
                <li key={v.prompt}>
                  <button onClick={() => void openVerified(v.prompt)}>
                    <span className="system-thumb">{pictures[v.prompt] ? <img src={`/thumbs/${pictures[v.prompt]}`} alt="" loading="lazy" width={480} height={360} /> : null}</span>
                    <span className="system-card-text">
                      <b>{v.name}</b>
                      <span>{v.summary || v.prompt}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="system-empty">
              {query ? 'No verified design matches that.' : 'No verified designs of this kind yet. Describe one above and it joins this list once it passes every check.'}
            </p>
          )}
        </section>

        <section className="system-list" aria-labelledby="listed-title">
          <div className="system-list-head">
            <h3 id="listed-title">
              Listed by people <span>{listed.length || ''}</span>
            </h3>
          </div>
          {listed.length ? (
            <ul className="system-rows">
              {listed.map((r) => (
                <li key={r.id}>
                  <button onClick={() => void openSavedRun(r.id)}>
                    <b>{r.name}</b>
                    <span>
                      {r.ownerName ? `${r.ownerName} · ` : ''}
                      {when(r.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="system-empty">Nobody has listed one yet. Save a run as “{VISIBILITY_LABEL.listed}” and it shows up here.</p>
          )}
        </section>

        <section className="system-list" aria-labelledby="mine-title">
          <div className="system-list-head">
            <h3 id="mine-title">
              Your saved {info.label.toLowerCase()} <span>{mine?.length || ''}</span>
            </h3>
          </div>
          {!signedIn ? (
            <div className="system-signin">
              <p className="system-empty">Sign in to see the {info.label.toLowerCase()} you saved.</p>
              <SignInButton />
            </div>
          ) : !mine ? (
            <p className="system-empty">Loading…</p>
          ) : mine.length ? (
            <ul className="system-rows">
              {mine.map((r) => (
                <li key={r.id}>
                  <button onClick={() => void openSavedRun(r.id)}>
                    <b>{r.name}</b>
                    <span>
                      {VISIBILITY_LABEL[r.visibility]} · {when(r.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="system-empty">You haven’t saved one of these yet. Open a design, then Share › Save.</p>
          )}
        </section>
      </aside>
    </div>,
    document.body,
  );
}
