import { useEffect, useRef, useState } from 'react';
import { client, leaveLive, liveLink, useLive } from '../live';
import './LivePill.css';

const initials = (name: string) =>
  name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

// While in a live session: who is here, the invite link, and a way out.
export function LivePill() {
  const { id, members, status } = useLive();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  if (!id) return null;
  const shown = members.slice(0, 4);
  return (
    <div className="live" ref={box}>
      <button className="live-pill" data-status={status} onClick={() => setOpen((v) => !v)} aria-expanded={open} title="Live session">
        <span className="live-dot" aria-hidden />
        {status === 'connecting' ? 'Reconnecting' : status === 'ended' ? 'Session ended' : 'Live'}
        <span className="live-faces" aria-label={`${members.length} in the session`}>
          {shown.map((m) => (
            <span key={m.client} className="live-face" style={{ background: m.color }} title={m.name}>
              {m.picture ? <img src={m.picture} alt="" referrerPolicy="no-referrer" /> : initials(m.name)}
            </span>
          ))}
          {members.length > shown.length && <span className="live-more">+{members.length - shown.length}</span>}
        </span>
      </button>
      {open && (
        <div className="live-menu" role="dialog" aria-label="Live session">
          <p className="live-title">In this session</p>
          <ul>
            {members.map((m) => (
              <li key={m.client}>
                <span className="live-face" style={{ background: m.color }}>
                  {m.picture ? <img src={m.picture} alt="" referrerPolicy="no-referrer" /> : initials(m.name)}
                </span>
                {m.name}
                {m.client === client && <span className="live-you">you</span>}
              </li>
            ))}
          </ul>
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(liveLink(id)).catch(() => undefined);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? 'Invite copied' : 'Copy invite link'}
          </button>
          <button
            onClick={() => {
              setOpen(false);
              leaveLive();
            }}
          >
            Leave session
          </button>
        </div>
      )}
    </div>
  );
}
