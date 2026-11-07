// Finds the words in a prompt that name parts of the environment built from it,
// so the build screen can light them up as the design comes back.

const NAME_KEYS = ['label', 'name', 'id', 'type', 'kind'] as const;

function termsOf(spec: unknown): string[] {
  if (!spec || typeof spec !== 'object') return [];
  const terms: string[] = [];
  for (const [key, value] of Object.entries(spec)) {
    // Counts like { robots: 6, conveyors: 1 } name their parts by key
    if (typeof value === 'number') terms.push(key);
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      for (const k of NAME_KEYS) {
        const text = (item as Record<string, unknown>)[k];
        if (typeof text === 'string') terms.push(text);
      }
      const custom = (item as { custom?: { label?: unknown } }).custom;
      if (typeof custom?.label === 'string') terms.push(custom.label);
    }
  }
  return terms;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function matchEntities(prompt: string, spec: unknown): string[] {
  const ranges: Array<[number, number]> = [];
  const seen = new Set<string>();
  for (const raw of termsOf(spec)) {
    const term = raw.replace(/[_-]+/g, ' ').trim().toLowerCase();
    // Skip short words and part codes like R1 or C2
    if (term.length < 3 || /^[a-z]\d+$/.test(term) || seen.has(term)) continue;
    seen.add(term);
    const stem = term.length > 3 ? term.replace(/e?s$/, '') : term;
    const pattern = new RegExp(`\\b${escape(stem).replace(/ /g, '[\\s_-]+')}(?:e?s)?\\b`, 'gi');
    for (const m of prompt.matchAll(pattern)) ranges.push([m.index!, m.index! + m[0].length]);
  }
  // Longest first, then drop anything overlapping a range already kept
  ranges.sort((a, b) => b[1] - b[0] - (a[1] - a[0]));
  const kept: Array<[number, number]> = [];
  for (const r of ranges) {
    if (!kept.some(([s, e]) => r[0] < e && s < r[1])) kept.push(r);
  }
  return kept.sort((a, b) => a[0] - b[0]).map(([s, e]) => prompt.slice(s, e));
}

export type Piece = { text: string; entity: number | null };

// Splits the prompt into plain runs and the entities, in order
export function splitPrompt(prompt: string, entities: string[]): Piece[] {
  const pieces: Piece[] = [];
  let at = 0;
  entities.forEach((entity, i) => {
    const start = prompt.indexOf(entity, at);
    if (start < 0) return;
    if (start > at) pieces.push({ text: prompt.slice(at, start), entity: null });
    pieces.push({ text: entity, entity: i });
    at = start + entity.length;
  });
  if (at < prompt.length) pieces.push({ text: prompt.slice(at), entity: null });
  return pieces;
}
