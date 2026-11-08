import { useEffect, useState } from 'react';
import { authFetch } from '../auth';
import { SERVICES, masked, saveOwnKey, useOwnKeys, type KeyService } from '../ownKeys';
import './ApiKeys.css';

type Test = { state: 'testing' } | { state: 'ok' | 'bad'; message: string };

// The account menu's API keys panel: bring your own Gemini, Swarms or Jev key, and the agents run on it for your requests.
export function ApiKeys() {
  const open = useOwnKeys((s) => s.open);
  const keys = useOwnKeys((s) => s.keys);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && useOwnKeys.setState({ open: false });
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [open]);
  if (!open) return null;
  const close = () => useOwnKeys.setState({ open: false });
  const count = Object.keys(keys).length;
  return (
    <div className="systems-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <section className="api-keys" role="dialog" aria-label="Your API keys">
        <header>
          <div>
            <h2>Your API keys</h2>
            <p className="api-keys-lede">Run the agents on your own accounts. Your builds then don't count against the hourly limit.</p>
          </div>
          <button className="api-keys-close" onClick={close} aria-label="Close">
            ×
          </button>
        </header>
        <ul className="api-keys-list">
          {SERVICES.map((s) => (
            <KeyRow key={s.id} service={s} value={keys[s.id]} />
          ))}
        </ul>
        <p className="api-keys-privacy">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            <path d="M4 7V5a4 4 0 0 1 8 0v2 M3 7h10v7H3z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
          <span>
            Kept only in this browser and deleted when you sign out. Each key goes with your own requests over HTTPS, is used for that request alone, and is never saved on our
            servers. {count ? `${count === 1 ? 'One key is' : `${count} keys are`} in use.` : 'Without one, CanItWork’s own keys are used.'}
          </span>
        </p>
      </section>
    </div>
  );
}

function KeyRow({ service, value }: { service: (typeof SERVICES)[number]; value?: string }) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(!value);
  const [shown, setShown] = useState(false);
  const [test, setTest] = useState<Test | null>(null);
  useEffect(() => setEditing(!value), [value]);

  const run = async (key: string) => {
    setTest({ state: 'testing' });
    try {
      const res = await authFetch('/api/keys/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service: service.id, key }) });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
      setTest({ state: body.ok ? 'ok' : 'bad', message: body.message ?? body.error ?? 'The key could not be tested' });
      return Boolean(body.ok);
    } catch {
      setTest({ state: 'bad', message: 'The key could not be tested' });
      return false;
    }
  };

  const save = async () => {
    const key = draft.trim();
    if (!key) return;
    // A key is kept only once its provider accepts it, so a typo never silently breaks the agents
    if (await run(key)) {
      saveOwnKey(service.id as KeyService, key);
      setDraft('');
      setShown(false);
    }
  };

  return (
    <li className="api-key" data-set={Boolean(value)}>
      <div className="api-key-head">
        <b>{service.name}</b>
        <span className="api-key-state">{value ? 'Your key' : 'CanItWork’s key'}</span>
      </div>
      <p className="api-key-powers">{service.powers}</p>
      {value && !editing ? (
        <div className="api-key-saved">
          <code>{masked(value)}</code>
          <button onClick={() => void run(value)}>Test</button>
          <button onClick={() => setEditing(true)}>Replace</button>
          <button
            className="api-key-remove"
            onClick={() => {
              saveOwnKey(service.id as KeyService, null);
              setTest(null);
            }}
          >
            Remove
          </button>
        </div>
      ) : (
        <form
          className="api-key-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            type={shown ? 'text' : 'password'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={service.placeholder}
            aria-label={`${service.name} API key`}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" className="api-key-eye" onClick={() => setShown((v) => !v)} aria-label={shown ? 'Hide the key' : 'Show the key'}>
            {shown ? 'Hide' : 'Show'}
          </button>
          <button type="submit" className="api-key-save" disabled={!draft.trim() || test?.state === 'testing'}>
            {test?.state === 'testing' ? 'Testing…' : 'Test and save'}
          </button>
          {value && (
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          )}
        </form>
      )}
      <div className="api-key-foot">
        {test && test.state !== 'testing' ? (
          <span className="api-key-test" data-ok={test.state === 'ok'}>
            {test.state === 'ok' ? '✓ ' : ''}
            {test.message}
          </span>
        ) : (
          <a href={service.getUrl} target="_blank" rel="noreferrer">
            Get a {service.name} key ↗
          </a>
        )}
      </div>
    </li>
  );
}
