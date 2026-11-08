import { SchemaRun, SystemRun } from '@tv/core';
import { runner } from './runner';
import { useStore } from './store';

export interface ExportFile {
  /** What the file is, for the panel's title: "SQL" */
  format: string;
  /** Where it runs, for the panel's note: "Postgres 13 or newer" */
  runsOn: string;
  /** The download's file name */
  filename: string;
  mime: string;
  text: string;
  /** A short count of what is in it: "4 tables · 3 foreign keys · 2 indexes" */
  summary: string;
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'design';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Which kinds of system can be exported as a file. */
export const exportable = (domain: string | undefined) => domain === 'database' || domain === 'software';

/** The running design as a file, with every fix applied so far, or null when this kind of system has no file format. */
export function exportFile(): ExportFile | null {
  const environment = useStore.getState().environment;
  const run = runner.run;
  if (!environment || !run) return null;
  if (run instanceof SchemaRun) {
    const text = run.toSql(environment.name);
    const keys = (text.match(/\bREFERENCES\b/g) ?? []).length;
    const indexes = (text.match(/^CREATE INDEX\b/gm) ?? []).length;
    return {
      format: 'SQL',
      runsOn: 'Postgres 13 or newer.',
      filename: `${slug(environment.name)}.sql`,
      mime: 'application/sql',
      text,
      summary: [plural(run.spec.tables.length, 'table'), plural(keys, 'foreign key'), plural(indexes, 'index').replace(/indexs$/, 'indexes')].join(' · '),
    };
  }
  if (run instanceof SystemRun) {
    const text = run.toCompose(environment.name);
    const services = run.spec.nodes.filter((n) => n.kind !== 'client' && n.kind !== 'external').length;
    const outside = run.spec.nodes.filter((n) => n.kind === 'external').length;
    const parts = [plural(services, 'service'), plural(run.spec.edges.filter((e) => e.from !== e.to).length, 'connection')];
    if (outside) parts.push(plural(outside, 'outside API'));
    return {
      format: 'Docker Compose',
      runsOn: 'Run it with docker compose up; your own services use placeholder images.',
      filename: 'docker-compose.yml',
      mime: 'application/yaml',
      text,
      summary: parts.join(' · '),
    };
  }
  return null;
}

/** Saves the file through the browser. */
export function download(file: ExportFile) {
  const url = URL.createObjectURL(new Blob([file.text], { type: `${file.mime};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
