import { DOMAINS, type DomainId } from '@tv/core';
import { useEffect, useRef, useState } from 'react';
import { openSavedRun, shareRun, type Visibility } from '../actions';
import { authFetch, signIn, signOut, useAuth } from '../auth';
import { savedRunLink } from '../share';
import { useStore } from '../store';
import './Account.css';

export const VISIBILITY_LABEL: Record<Visibility, string> = { public: 'Anyone with the link', private: 'Only me', people: 'People I choose' };

/** Signs in, keeping any open run in the link so it comes back after Auth0's page. */
export async function signInKeepingRun() {
  if (useStore.getState().environment) await shareRun();
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
}

function SavedRow({ run, onChange, onDelete }: { run: Saved; onChange: (next: Saved) => void; onDelete: () => void }) {
  const [people, setPeople] = useState(run.people.join(', '));
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  return (
    <li className="saved-run">
      <div className="saved-head">
        <button className="saved-name" onClick={() => void openSavedRun(run.id)}>
          {run.name}
        </button>
        <span className="saved-meta">
          {DOMAINS[run.domain]?.label ?? run.domain} · {new Date(run.updatedAt).toLocaleDateString()}
        </span>
      </div>
      <div className="saved-actions">
        <select aria-label={`Who can open ${run.name}`} value={run.visibility} onChange={(e) => void update(e.target.value as Visibility, emails())}>
          {(Object.keys(VISIBILITY_LABEL) as Visibility[]).map((v) => (
            <option key={v} value={v}>
              {VISIBILITY_LABEL[v]}
            </option>
          ))}
        </select>
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(savedRunLink(run.id)).catch(() => undefined);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
        <button className="danger" onClick={onDelete}>
          Delete
        </button>
      </div>
      {run.visibility === 'people' && (
        <div className="saved-people">
          <input aria-label="Emails that can open it" placeholder="Emails, separated by commas" value={people} onChange={(e) => setPeople(e.target.value)} />
          <button onClick={() => void update('people', emails())}>Save</button>
        </div>
      )}
      {error && <p className="saved-error">{error}</p>}
    </li>
  );
}

// The signed-in user's saved runs: open one, copy its link, change who can open it, or delete it.
export function MySystems() {
  const show = useAuth((s) => s.mySystems);
  const [runs, setRuns] = useState<Saved[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!show) return;
    setRuns(null);
    setError(null);
    authFetch('/api/runs')
      .then(async (res) => (res.ok ? setRuns(((await res.json()) as { runs: Saved[] }).runs) : setError('Sign in again to see your systems')))
      .catch(() => setError('Your systems could not be loaded'));
  }, [show]);
  if (!show) return null;
  const close = () => useAuth.setState({ mySystems: false });
  const remove = async (run: Saved) => {
    if (!window.confirm(`Delete "${run.name}"? Its link stops working for everyone, and this can't be undone.`)) return;
    const res = await authFetch(`/api/runs/${run.id}`, { method: 'DELETE' });
    if (res.ok) setRuns((list) => list?.filter((r) => r.id !== run.id) ?? null);
  };
  return (
    <div className="systems-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <section className="systems" role="dialog" aria-label="My systems">
        <header>
          <h2>My systems</h2>
          <button onClick={close} aria-label="Close">
            ×
          </button>
        </header>
        {error ? (
          <p className="systems-note">{error}</p>
        ) : !runs ? (
          <p className="systems-note">Loading…</p>
        ) : !runs.length ? (
          <p className="systems-note">Nothing saved yet. Build a system, then use Share and save it to your account.</p>
        ) : (
          <ul>
            {runs.map((run) => (
              <SavedRow
                key={run.id}
                run={run}
                onChange={(next) => setRuns((list) => list?.map((r) => (r.id === next.id ? { ...r, ...next } : r)) ?? null)}
                onDelete={() => void remove(run)}
              />
            ))}
          </ul>
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
