import { useEffect, useRef, useState } from 'react';
import { checkOnPostgres, download, exportable, exportFile, type ExportFile, type PostgresCheck } from '../exporting';
import { useStore } from '../store';
import './SharePanel.css';
import './ExportPanel.css';

// Export sits beside Save and Share for kinds of system that have a real file format. The file is written by code from the
// design as it runs now, fixes included, so it is exactly what the simulator tested.
export function ExportButton() {
  const domain = useStore((s) => s.environment?.domain);
  useStore((s) => s.structure);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<ExportFile | null>(null);
  const [copied, setCopied] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // The chat asked for the file: open the panel with it ready
  const asked = useStore((s) => s.exportOpen);
  useEffect(() => {
    if (!asked) return;
    useStore.getState().set({ exportOpen: false });
    if (!exportable(useStore.getState().environment?.domain)) return;
    setFile(exportFile());
    setCopied(false);
    setOpen(true);
  }, [asked]);

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

  if (!exportable(domain)) return null;

  const toggle = () => {
    if (open) return setOpen(false);
    setFile(exportFile());
    setCopied(false);
    setOpen(true);
  };

  const copy = async () => {
    if (!file) return;
    try {
      await navigator.clipboard.writeText(file.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="share-wrap" ref={wrap}>
      <button className="new-system share export-button" onClick={toggle} aria-expanded={open} aria-label="Export" title="Download this design as a file you can run">
        <svg className="export-icon" width="15" height="15" viewBox="0 0 16 16" aria-hidden>
          <path d="M8 2v8 M4.5 6.5 8 10l3.5-3.5 M3 13.5h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="export-label">Export</span>
      </button>
      {open && (
        <div className="share-panel export-panel" role="dialog" aria-label="Export this design">
          {file ? (
            <>
              <p className="share-title">Export as {file.format}</p>
              <p className="share-note">Written from the design the simulator tested, with every fix you applied. {file.runsOn}</p>
              <p className="export-summary">{file.summary}</p>
              {file.database && <TigerCheck file={file} />}
              <pre className="export-preview" aria-label={`${file.filename} preview`}>
                {file.text}
              </pre>
              <div className="share-actions">
                <button className="share-primary" onClick={() => download(file)}>
                  Download {file.filename}
                </button>
                <button onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
              </div>
            </>
          ) : (
            <p className="share-note">The design is still loading. Try again in a moment.</p>
          )}
        </div>
      )}
    </div>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : word.endsWith('x') ? 'es' : 's'}`;

// Tiger Data's Postgres runs the file before it is downloaded: a real database saying the SQL works
function TigerCheck({ file }: { file: ExportFile }) {
  const [state, setState] = useState<{ check?: PostgresCheck; skipped?: string } | null>(null);
  useEffect(() => {
    let live = true;
    setState(null);
    void checkOnPostgres(file.database!).then((r) => live && setState('skipped' in r ? { skipped: r.skipped } : { check: r }));
    return () => {
      live = false;
    };
  }, [file]);
  if (!state)
    return (
      <p className="tiger-check" data-state="running">
        <span className="tiger-dot" aria-hidden />
        Checking on Tiger Data's Postgres…
      </p>
    );
  if (state.skipped)
    return (
      <p className="tiger-check" data-state="skipped">
        Not checked on Postgres: {state.skipped.replace(/\.$/, '')}.
      </p>
    );
  const c = state.check!;
  if (!c.ok)
    return (
      <p className="tiger-check" data-state="refused">
        <b>Postgres refused it:</b> {c.error}
      </p>
    );
  return (
    <p className="tiger-check" data-state="ok" title="Run in a scratch schema on Tiger Data's Postgres, in a transaction that was rolled back, so nothing was kept">
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
        <path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>
        Tiger Data's Postgres {c.version} built {plural(c.tables ?? 0, 'table')}, {plural(c.foreignKeys ?? 0, 'foreign key')} and {plural(c.indexes ?? 0, 'index')}
      </span>
    </p>
  );
}
