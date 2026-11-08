import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { shareRun } from '../actions';
import { shortHash } from '../share';
import './SharePanel.css';

// A QR code holds about 2.9 KB at its lowest error correction; past that a phone camera can't read it reliably.
const QR_LIMIT = 2900;
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/;

// Share opens a small panel: copy the link that replays this exact run, or show it as a QR code to open on a phone.
// The QR code is drawn in the browser, so the run in the link never goes to an outside service.
export function ShareButton() {
  const [open, setOpen] = useState(false);
  const [shared, setShared] = useState<{ url: string; hash: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  const toggle = async () => {
    if (open) return setOpen(false);
    const next = await shareRun();
    if (!next) return;
    setShared(next);
    setQr(null);
    setShowQr(false);
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

  useEffect(() => {
    if (!showQr || !shared || shared.url.length > QR_LIMIT) return;
    let live = true;
    QRCode.toString(shared.url, { type: 'svg', errorCorrectionLevel: 'L', margin: 2, color: { dark: '#0b0f17', light: '#ffffff' } })
      .then((svg) => live && setQr(svg))
      .catch(() => live && setQr(null));
    return () => {
      live = false;
    };
  }, [showQr, shared]);

  const copy = async () => {
    if (!shared) return;
    try {
      await navigator.clipboard.writeText(shared.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const tooLong = shared ? shared.url.length > QR_LIMIT : false;
  const local = LOCAL.test(location.hostname);
  return (
    <div className="share-wrap">
      <button className="new-system share" onClick={toggle} aria-expanded={open} title="Share a link that replays this exact run">
        Share
      </button>
      {open && shared && (
        <div className="share-panel" ref={panel} role="dialog" aria-label="Share this run">
          <p className="share-title">Share this run</p>
          <p className="share-note">The link holds the whole run, so it replays tick by tick on any device and checks its proof hash.</p>
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
              <p className="share-warn">This run is too long for a QR code to hold ({(shared.url.length / 1000).toFixed(1)} KB). Copy the link instead.</p>
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
          <p className="share-hash">
            Proof hash <code>{shortHash(shared.hash)}</code>
          </p>
        </div>
      )}
    </div>
  );
}
