import { useEffect, useRef, useState } from 'react';
import { saveRun, shareRun, type Visibility } from '../actions';
import { useAuth } from '../auth';
import { shortHash, type SharedRun } from '../share';
import { liveLink, startLive, useLive } from '../live';
import { VISIBILITY_LABEL, signInKeepingRun } from './Account';
import './SharePanel.css';

const SAVED_NOTE: Record<Visibility, string> = {
  public: 'Anyone with this short link can open it.',
  private: 'Only you can open this short link.',
  people: 'Only you and the people you named can open this short link, once signed in.',
};

// A QR code holds about 2.9 KB at its lowest error correction; past that a phone camera can't read it reliably.
const QR_LIMIT = 2900;
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/;

// Share opens a small panel: copy the link that replays this exact run, or show it as a QR code to open on a phone.
// The QR code is drawn in the browser, so the run in the link never goes to an outside service.
export function ShareButton() {
  const [open, setOpen] = useState(false);
  const [shared, setShared] = useState<{ url: string; hash: string; run: SharedRun } | null>(null);
  const [saved, setSaved] = useState<{ url: string; visibility: Visibility } | null>(null);
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [people, setPeople] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const { enabled, account } = useAuth();
  const liveId = useLive((s) => s.id);
  const [starting, setStarting] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  const toggle = async () => {
    if (open) return setOpen(false);
    const next = await shareRun();
    if (!next) return;
    setShared(next);
    setSaved(null);
    setSaveError(null);
    setQr(null);
    setShowQr(true);
    setCopied(false);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !panel.current?.parentElement?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  // An invite to a live session, or a saved run's short link, makes a far smaller QR code than a link that carries the whole run.
  const link = liveId ? liveLink(liveId) : (saved?.url ?? shared?.url ?? '');
  useEffect(() => {
    if (!showQr || !link || link.length > QR_LIMIT) return;
    let live = true;
    // The QR library only loads when someone asks for a code.
    import('qrcode')
      .then(({ default: QRCode }) => QRCode.toString(link, { type: 'svg', errorCorrectionLevel: 'L', margin: 2, color: { dark: '#0b0f17', light: '#ffffff' } }))
      .then((svg) => live && setQr(svg))
      .catch(() => live && setQr(null));
    return () => {
      live = false;
    };
  }, [showQr, link]);

  const save = async () => {
    if (!shared) return;
    setSaving(true);
    setSaveError(null);
    try {
      const emails = people
        .split(/[\s,;]+/)
        .map((e) => e.trim())
        .filter(Boolean);
      const result = await saveRun(shared.run, visibility, emails);
      setSaved({ url: result.url, visibility });
      setQr(null);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'The run could not be saved');
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const tooLong = link.length > QR_LIMIT;
  const local = LOCAL.test(location.hostname);
  return (
    <div className="share-wrap">
      <button className="new-system share" onClick={toggle} aria-expanded={open} title="Share a link that replays this exact run">
        Share
      </button>
      {open && shared && (
        <div className="share-panel" ref={panel} role="dialog" aria-label="Share this run">
          <p className="share-title">Share this run</p>
          <p className="share-note">
            {liveId
              ? 'Anyone who opens this invite joins the live session: they see this run and every change anyone makes, as it happens.'
              : saved
                ? `Saved to your account. ${SAVED_NOTE[saved.visibility]}`
                : 'The link holds the whole run, so it replays tick by tick on any device and checks its proof hash.'}
          </p>
          <div className="share-actions">
            <button className="share-primary" onClick={copy}>
              {copied ? 'Link copied' : 'Copy link'}
            </button>
            <button onClick={() => setShowQr((v) => !v)} aria-pressed={showQr}>
              {showQr ? 'Hide QR code' : 'Show QR code'}
            </button>
          </div>
          {showQr &&
            (tooLong ? (
              <p className="share-warn">
                This run is too long for a QR code to hold ({(link.length / 1000).toFixed(1)} KB).{' '}
                {enabled ? 'Save it to your account for a short link, or copy the link instead.' : 'Copy the link instead.'}
              </p>
            ) : qr ? (
              <figure className="share-qr">
                <div aria-label="QR code for the share link" role="img" dangerouslySetInnerHTML={{ __html: qr }} />
                <figcaption>Scan to open this run on a phone</figcaption>
                {local && (
                  <p className="share-warn">
                    This link points at this computer ({location.host}), so a phone can only open it once the app runs at an address the phone can reach.
                  </p>
                )}
              </figure>
            ) : (
              <p className="share-note">Drawing the QR code…</p>
            ))}
          {!liveId && (
            <div className="share-save">
              <p className="share-title">Work on it together</p>
              <p className="share-note">Start a live session: everyone with the invite sees the same run, and every break, fix and switch flip shows up for all of them.</p>
              <button
                className="share-primary"
                disabled={starting}
                onClick={async () => {
                  setStarting(true);
                  setLiveError(null);
                  try {
                    await startLive();
                    setQr(null);
                  } catch (error) {
                    setLiveError(error instanceof Error ? error.message : 'The live session could not start');
                  } finally {
                    setStarting(false);
                  }
                }}
              >
                {starting ? 'Starting…' : 'Start a live session'}
              </button>
              {liveError && <p className="share-warn">{liveError}</p>}
            </div>
          )}
          {enabled && !saved && !liveId && (
            <div className="share-save">
              {account ? (
                <>
                  <p className="share-title">Save to your account</p>
                  <fieldset>
                    <legend className="share-note">Who can open it</legend>
                    {(Object.keys(VISIBILITY_LABEL) as Visibility[]).map((v) => (
                      <label key={v}>
                        <input type="radio" name="visibility" value={v} checked={visibility === v} onChange={() => setVisibility(v)} />
                        {VISIBILITY_LABEL[v]}
                      </label>
                    ))}
                  </fieldset>
                  {visibility === 'people' && <p className="share-note">They open it by signing in with that email, once it is verified (Google sign-ins are).</p>}
                  {visibility === 'people' && (
                    <input
                      className="share-people"
                      aria-label="Emails that can open it"
                      placeholder="Emails, separated by commas"
                      value={people}
                      onChange={(e) => setPeople(e.target.value)}
                    />
                  )}
                  <button className="share-primary" onClick={() => void save()} disabled={saving || (visibility === 'people' && !people.trim())}>
                    {saving ? 'Saving…' : 'Save and get a short link'}
                  </button>
                  {saveError && <p className="share-warn">{saveError}</p>}
                </>
              ) : (
                <p className="share-note">
                  <button className="share-link" onClick={() => void signInKeepingRun()}>
                    Sign in
                  </button>{' '}
                  to save this run and choose who can open it.
                </p>
              )}
            </div>
          )}
          <p className="share-hash">
            Proof hash <code>{shortHash(shared.hash)}</code>
          </p>
        </div>
      )}
    </div>
  );
}
