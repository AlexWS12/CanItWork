import { pinsOf, type CircuitSpec } from './parts';

// Which pins are joined by wires: find() gives each pin's net, members lists the pins in each net.
// One implementation shared by the validator's traces, the breadboard layout and the 3D view, so they never disagree about what is connected.
export function netsOf(spec: CircuitSpec) {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    if (!parent.has(k)) parent.set(k, k);
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  for (const w of spec.wires) parent.set(find(w.from), find(w.to));
  const members = new Map<string, string[]>();
  for (const part of spec.parts)
    for (const pin of pinsOf(part)) {
      const key = `${part.id}.${pin}`;
      const root = find(key);
      members.set(root, [...(members.get(root) ?? []), key]);
    }
  return { find, members };
}
