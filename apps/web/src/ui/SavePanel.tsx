import { useEffect, useRef, useState } from 'react';
import { saveRun, shareRun, type Visibility } from '../actions';
import { useAuth } from '../auth';
import { useStore } from '../store';
import { VISIBILITY_LABEL, signInKeepingRun } from './Account';
import './SharePanel.css';
import './SavePanel.css';

const SAVED_FOR: Record<Visibility, string> = {
  public: 'Anyone with the link can open it.',
  listed: 'Anyone can open it, and it is listed on the landing page.',
  private: 'Only you can open it.',
  people: 'You and the people you named can open it.',
};

// Save sits beside Share: name the system and keep it in My systems, private unless you choose otherwise.
// Each save keeps the run as it is now, so saving again later keeps a second copy rather than overwriting the first.
export function SaveButton() {
  const { enabled, account } = useAuth();
  const systemName = useStore((s) => s.environment?.name ?? '');
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [people, setPeople] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ name: string; url: string; thumb: string | null; visibility: Visibility } | null>(null);
  const [copied, setCopied] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  // Without a sign-in tenant there is no account to save to, so the button stays out of the way.
  if (!enabled) return null;

  const toggle = () => {
    if (open) return setOpen(false);
    setName(systemName);
    setSaved(null);
    setError(null);
    setCopied(false);
    setOpen(true);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const shared = await shareRun();
      if (!shared) throw new Error('There is no running system to save yet');
      const emails = people
        .split(/[\s,;]+/)
        .map((e) => e.trim())
        .filter(Boolean);
      const title = name.trim() || systemName;
      const result = await saveRun(shared.run, visibility, emails, title);
      setSaved({ name: title, url: result.url, thumb: result.thumb, visibility });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The system could not be saved');
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    if (!saved) return;
    try {
      await navigator.clipboard.writeText(saved.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="share-wrap" ref={wrap}>
      <button className="new-system share" onClick={toggle} aria-expanded={open} title="Name this system and save it to your account">
        Save
      </button>
      {open && (
        <div className="share-panel" role="dialog" aria-label="Save this system">
          {!saved && <p className="share-title">Save this system</p>}
          {!account ? (
            <p className="share-note">
              <button className="share-link" onClick={() => void signInKeepingRun()}>
                Sign in
              </button>{' '}
              to name this system and keep it in My systems.
            </p>
          ) : saved ? (
            <>
              {saved.thumb && (
                <figure className="saved-shot">
                  <img src={saved.thumb} alt={`Snapshot of ${saved.name}`} width={480} height={360} />
                  <figcaption>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M5 12l5 5L19 7" />
                    </svg>
                    Saved
                  </figcaption>
                </figure>
              )}
              <div className="saved-said">
                <b>{saved.name}</b>
                <p className="share-note">
                  {saved.thumb ? 'In My systems with this picture.' : 'In My systems.'} {SAVED_FOR[saved.visibility]}
                </p>
              </div>
              <div className="share-actions">
                <button className="share-primary" onClick={() => void copy()}>
                  {copied ? 'Link copied' : 'Copy link'}
                </button>
                <button
                  onClick={() => {
                    setOpen(false);
                    useAuth.setState({ mySystems: true });
                  }}
                >
                  My systems
                </button>
              </div>
            </>
          ) : (
            <form
              className="share-save save-form"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <label className="save-name">
                <span className="share-note">Name</span>
                <input className="share-people" value={name} maxLength={120} autoFocus onChange={(e) => setName(e.target.value)} placeholder={systemName} />
              </label>
              <fieldset>
                <legend className="share-note">Who can open it</legend>
                {(Object.keys(VISIBILITY_LABEL) as Visibility[]).map((v) => (
                  <label key={v}>
                    <input type="radio" name="save-visibility" value={v} checked={visibility === v} onChange={() => setVisibility(v)} />
                    {VISIBILITY_LABEL[v]}
                  </label>
                ))}
              </fieldset>
              {visibility === 'people' && (
                <input
                  className="share-people"
                  aria-label="Emails that can open it"
                  placeholder="Emails, separated by commas"
                  value={people}
                  onChange={(e) => setPeople(e.target.value)}
                />
              )}
              <button type="submit" className="share-primary" disabled={saving || (visibility === 'people' && !people.trim())}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              {error && <p className="share-warn">{error}</p>}
            </form>
          )}
        </div>
      )}
    </div>
  );
}
