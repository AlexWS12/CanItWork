import { useState } from 'react';
import './Attachment.css';

export interface PastedFile {
  /** What kind of file it is, in plain words */
  kind: string;
  /** The file itself */
  body: string;
  lines: number;
  /** Whatever the person wrote around the file, such as "a shop with this schema" */
  words: string;
}

// The same rules the server uses to import a file (apps/server/src/importers.ts): a fenced block if there is one, otherwise the
// whole message, and it counts only when it reads as SQL tables, a Compose file or a Kubernetes manifest
export function pastedFile(text: string): PastedFile | null {
  const fenced = text.match(/```[\w-]*\s*\n([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  let kind: string | null = null;
  if (/\bcreate\s+table\b[^;(]*\(/i.test(body)) kind = 'SQL schema';
  else if (/^\s*apiVersion\s*:/m.test(body)) kind = 'Kubernetes manifest';
  else if (/^\s*services\s*:/m.test(body)) kind = 'Compose file';
  if (!kind) return null;
  const words = fenced ? text.replace(fenced[0], ' ').replace(/\s+/g, ' ').trim() : '';
  return { kind, body, lines: body.split('\n').length, words };
}

/** A pasted file as a compact chip, which opens to show the file itself. */
export function Attachment({ file, expandable = true }: { file: PastedFile; expandable?: boolean }) {
  const [open, setOpen] = useState(false);
  const label = (
    <>
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
        <path d="M4 1.5h5.5L13 5v9.5H4z M9.5 1.5V5H13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
      <b>{file.kind}</b>
      <span>
        {file.lines} line{file.lines === 1 ? '' : 's'}
      </span>
    </>
  );
  return (
    <span className="attachment">
      {file.words && <span className="attachment-words">{file.words}</span>}
      {expandable ? (
        <button type="button" className="attachment-chip" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={open ? 'Hide the file' : 'Show the file'}>
          {label}
        </button>
      ) : (
        <span className="attachment-chip">{label}</span>
      )}
      {open && <pre className="attachment-body">{file.body}</pre>}
    </span>
  );
}
