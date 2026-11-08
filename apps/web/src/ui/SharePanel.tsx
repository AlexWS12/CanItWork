import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { shareRun } from '../actions';
import { shortHash } from '../share';
import './SharePanel.css';

type Shared = { url: string; hash: string; qr: string | null; copied: boolean };

const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

// A QR code holds about 2.9 KB at the lowest error correction, enough for most runs. Longer ones fall back to the link.
async function qrFor(url: string) {
  try {
    return await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'L', margin: 2, color: { dark: '#06090f', light: '#ffffff' } });
  } catch {
    return null;
  }
}

/** Share: copies a link that replays this exact run and shows it as a QR code to open on another device. */
export function ShareButton() {
  const [shared, setShared] = useState<Shared | null>(null);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onDown = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      return false;
    }
  };

  const share = async () => {
    if (open) return setOpen(false);
    const run = await shareRun();
    if (!run) return;
    // The clipboard can wait on a permission prompt, so the panel opens first and the copy lands when it does
    const copying = copy(run.url);
    setShared({ ...run, qr: await qrFor(run.url), copied: false });
    setOpen(true);
    const copied = await copying;
    setShared((current) => (current?.url === run.url ? { ...current, copied } : current));
  };

  const kb = shared ? (shared.url.length / 1024).toFixed(1) : '0';
  return (
    <div className="share-anchor" ref={root}>
      <button className="new-system share" onClick={share} aria-expanded={open} title="Share a link and QR code that replay this exact run">
        Share
      </button>
      {open && shared && (
        <div className="share-panel" role="dialog" aria-label="Share this run">
          <div className="share-qr">
            {shared.qr ? (
              <div className="qr" role="img" aria-label="QR code for the share link" dangerouslySetInnerHTML={{ __html: shared.qr }} />
            ) : (
              <p className="qr-missing">This run is too long for a QR code ({kb} KB). Share the link instead.</p>
            )}
          </div>
          <p className="share-lede">{shared.qr ? 'Scan to replay this exact run on another device.' : 'Anyone with the link replays this exact run.'}</p>
          <div className="share-link">
            <input readOnly value={shared.url} aria-label="Share link" onFocus={(e) => e.currentTarget.select()} />
            <button
              className="new-system"
              onClick={async () => {
                const copied = await copy(shared.url);
                setShared({ ...shared, copied });
              }}
            >
              {shared.copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="share-meta">
            Provenance hash <code>{shortHash(shared.hash)}</code>, checked when the link opens.
          </p>
          {local && (
            <p className="share-meta warn">This link points at {location.hostname}, so it only opens on this computer. Share from the deployed app to open it on a phone.</p>
          )}
        </div>
      )}
    </div>
  );
}
