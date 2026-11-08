import { DOMAINS, type DomainId } from '@tv/core';
import { useEffect, useRef, useState } from 'react';
import { openSavedRun, shareRun, type Visibility } from '../actions';
import { authFetch, signIn, signOut, useAuth } from '../auth';
import { useOwnKeys } from '../ownKeys';
import { savedRunLink } from '../share';
import { useStore } from '../store';
import { LogoMark } from './Wordmark';
import './Account.css';

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  public: 'Anyone with the link',
  listed: 'Public, listed on the landing',
  private: 'Only me',
  people: 'People I choose',
};

/**
 * Signs in, keeping any open run in the link so it comes back after Auth0's page. The landing's live hero is not the user's
 * run, so on the landing nothing is kept and signing in comes back to the landing.
 */
export async function signInKeepingRun() {
  const { environment, showcase } = useStore.getState();
  if (environment && !showcase) await shareRun();
  await signIn();
}

/** Offered where the server turned a build away until someone signs in. Hidden when there is nothing to sign in to. */
export function SignInButton() {
  const { enabled, account } = useAuth();
  if (!enabled || account) return null;
  return (
    <button className="sign-in-inline" onClick={() => void signInKeepingRun()}>
      Sign in
    </button>
  );
}

const initials = (name?: string, email?: string) =>
  (name ?? email ?? '?')
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

// Sign in, or the signed-in user's avatar with their saved systems and sign out.
export function AccountButton() {
  const { enabled, ready, account } = useAuth();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !menu.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const keyCount = useOwnKeys((st) => Object.keys(st.keys).length);
  if (!enabled || !ready) return null;
  if (!account)
    return (
      <button className="new-system" onClick={() => void signInKeepingRun()} title="Sign in to save runs and choose who can open them">
        Sign in
      </button>
    );
  return (
    <div className="account" ref={menu}>
      <button className="avatar" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={`Account: ${account.name ?? account.email}`}>
        {account.picture ? <img src={account.picture} alt="" referrerPolicy="no-referrer" /> : <span>{initials(account.name, account.email)}</span>}
      </button>
      {open && (
        <div className="account-menu" role="menu">
          <p className="account-who">
            <b>{account.name ?? 'Signed in'}</b>
            {account.email && <span>{account.email}</span>}
          </p>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              useAuth.setState({ mySystems: true });
            }}
          >
            My systems
          </button>
          <button
            role="menuitem"
            className="account-keys-item"
            onClick={() => {
              setOpen(false);
              useOwnKeys.setState({ open: true });
            }}
          >
            API keys
            {keyCount > 0 && <span className="account-keys-count">{keyCount}</span>}
          </button>
          <button role="menuitem" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

interface Saved {
  id: string;
  name: string;
  domain: DomainId;
  visibility: Visibility;
  people: string[];
  updatedAt: string;
  description?: string;
  ticks?: number;
  events?: number;
  hash?: string;
  /** The picture taken when it was saved; older saves have none */
  thumb?: string | null;
}

const savedOn = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const kindOf = (run: Saved) => DOMAINS[run.domain]?.label ?? run.domain;

// The saved picture, or for a save from before pictures, the logo's cube on the blueprint ground
function SavedPicture({ run, corners = false }: { run: Saved; corners?: boolean }) {
  return (
    <span className="saved-picture">
      {run.thumb ? (
        <img src={run.thumb} alt={`Snapshot of ${run.name}`} width={480} height={360} />
      ) : (
        <span className="saved-picture-none">
          <LogoMark size={44} />
          <span>{kindOf(run)}</span>
        </span>
      )}
      {corners && <span className="saved-corners" aria-hidden />}
    </span>
  );
}

// The chosen system up front: its picture, what it is, how far it ran, who can open it, and what to do with it
function Featured({ run, latest, onChange, onDelete }: { run: Saved; latest: boolean; onChange: (next: Saved) => void; onDelete: () => void }) {
  const [people, setPeople] = useState(run.people.join(', '));
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPeople(run.people.join(', '));
    setCopied(false);
    setError(null);
  }, [run.id, run.people]);
  const update = async (visibility: Visibility, list: string[]) => {
    setError(null);
    const res = await authFetch(`/api/runs/${run.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visibility, people: list }) });
    if (res.ok) onChange((await res.json()) as Saved);
    else setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Could not change who can open it');
  };
  const emails = () =>
    people
      .split(/[\s,;]+/)
      .map((e) => e.trim())
      .filter(Boolean);
  const events = run.events ?? 0;
  return (
    <section className="featured" aria-label={run.name}>
      <button className="featured-picture" onClick={() => void openSavedRun(run.id)} aria-label={`Open ${run.name}`}>
        <SavedPicture run={run} corners />
      </button>
      <div className="featured-text">
        <span className="featured-when">
          {latest ? 'Latest · ' : ''}Saved {savedOn(run.updatedAt)}
        </span>
        <h3>{run.name}</h3>
        {run.description && <p className="featured-about">{run.description}</p>}
        <dl>
          <div>
            <dt>Kind</dt>
            <dd>{kindOf(run)}</dd>
          </div>
          <div>
            <dt>
              <label htmlFor={`who-${run.id}`}>Who can open it</label>
            </dt>
            <dd>
              <select id={`who-${run.id}`} value={run.visibility} onChange={(e) => void update(e.target.value as Visibility, emails())}>
                {(Object.keys(VISIBILITY_LABEL) as Visibility[]).map((v) => (
                  <option key={v} value={v}>
                    {VISIBILITY_LABEL[v]}
                  </option>
                ))}
              </select>
            </dd>
          </div>
          {run.ticks !== undefined && (
            <div>
              <dt>Run</dt>
              <dd className="mono">
                {run.ticks.toLocaleString()} ticks · {events === 0 ? 'no events' : `${events} event${events === 1 ? '' : 's'}`}
              </dd>
            </div>
          )}
          {run.hash && (
            <div>
              <dt>Proof hash</dt>
              <dd className="mono">{run.hash.slice(0, 6)}</dd>
            </div>
          )}
        </dl>
        {run.visibility === 'people' && (
          <div className="saved-people">
            <input aria-label="Emails that can open it" placeholder="Emails, separated by commas" value={people} onChange={(e) => setPeople(e.target.value)} />
            <button onClick={() => void update('people', emails())}>Save</button>
          </div>
        )}
        {error && <p className="saved-error">{error}</p>}
        <div className="featured-actions">
          <button className="featured-open" onClick={() => void openSavedRun(run.id)}>
            Open
          </button>
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(savedRunLink(run.id)).catch(() => undefined);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? 'Link copied' : 'Copy link'}
          </button>
          <button className="danger" onClick={onDelete}>
            Delete
          </button>
        </div>
      </div>
    </section>
  );
}

// The signed-in user's saved systems: the latest (or the one picked) up front, the rest as cards to pick from.
export function MySystems() {
  const show = useAuth((s) => s.mySystems);
  const [runs, setRuns] = useState<Saved[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    if (!show) return;
    setRuns(null);
    setError(null);
    setPicked(null);
    authFetch('/api/runs')
      .then(async (res) => (res.ok ? setRuns(((await res.json()) as { runs: Saved[] }).runs) : setError('Sign in again to see your systems')))
      .catch(() => setError('Your systems could not be loaded'));
  }, [show]);
  useEffect(() => {
    if (!show) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && useAuth.setState({ mySystems: false });
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [show]);
  if (!show) return null;
  const close = () => useAuth.setState({ mySystems: false });
  const remove = async (run: Saved) => {
    if (!window.confirm(`Delete "${run.name}"? Its link stops working for everyone, and this can't be undone.`)) return;
    const res = await authFetch(`/api/runs/${run.id}`, { method: 'DELETE' });
    if (res.ok) {
      setRuns((list) => list?.filter((r) => r.id !== run.id) ?? null);
      setPicked(null);
    }
  };
  const featured = runs?.find((r) => r.id === picked) ?? runs?.[0] ?? null;
  const rest = runs?.filter((r) => r !== featured) ?? [];
  return (
    <div className="systems-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <section className="systems" role="dialog" aria-label="My systems">
        <header>
          <h2>My systems</h2>
          {runs && runs.length > 0 && <span className="systems-count">{runs.length} saved</span>}
          <button onClick={close} aria-label="Close">
            ×
          </button>
        </header>
        {error ? (
          <p className="systems-note">{error}</p>
        ) : !runs ? (
          <p className="systems-note">Loading…</p>
        ) : !featured ? (
          <p className="systems-note">Nothing saved yet. Build a system, then use Save to name it and keep it here.</p>
        ) : (
          <>
            <Featured
              run={featured}
              latest={featured === runs[0]}
              onChange={(next) => setRuns((list) => list?.map((r) => (r.id === next.id ? { ...r, ...next } : r)) ?? null)}
              onDelete={() => void remove(featured)}
            />
            {rest.length > 0 && (
              <section className="systems-rest">
                <h3>{featured === runs[0] ? 'Earlier' : 'Your other systems'}</h3>
                <ul>
                  {rest.map((run) => (
                    <li key={run.id}>
                      <button className="saved-card" onClick={() => setPicked(run.id)} title={`Show ${run.name} up front`}>
                        <SavedPicture run={run} />
                        <b>{run.name}</b>
                        <span>
                          {kindOf(run)} · {savedOn(run.updatedAt)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </section>
    </div>
  );
}

// Shown when a saved run's link can't be opened, or a sign-in didn't finish: why, and what to do about it.
export function LockedRunNotice() {
  const locked = useAuth((s) => s.locked);
  const account = useAuth((s) => s.account);
  const failure = useAuth((s) => s.failure);
  if (failure)
    return (
      <div className="locked-run" role="alert">
        <p>
          <b>Sign-in didn&apos;t finish.</b> Auth0 said: {failure}
        </p>
        <button onClick={() => useAuth.setState({ failure: null })}>Dismiss</button>
      </div>
    );
  if (!locked) return null;
  const dismiss = () => useAuth.setState({ locked: null });
  return (
    <div className="locked-run" role="status">
      {locked.reason === 'sign-in' ? (
        <>
          <p>
            <b>This run is private.</b> Sign in to open it if it was shared with you.
          </p>
          <button className="locked-primary" onClick={() => void signIn()}>
            Sign in
          </button>
        </>
      ) : locked.reason === 'private' ? (
        <p>
          <b>This run is private</b> and isn&apos;t shared with {account?.email ?? 'your account'}.{' '}
          {account?.emailVerified === false
            ? 'Your email isn’t verified yet, and runs shared by email only open for a verified address: confirm it from the email Auth0 sent, or sign in with Google.'
            : 'Ask its owner to add you.'}
        </p>
      ) : (
        <p>
          <b>No saved run at this link.</b> It may have been deleted.
        </p>
      )}
      <button onClick={dismiss}>Dismiss</button>
    </div>
  );
}
