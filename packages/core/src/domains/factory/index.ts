import { networkDomain } from '../network/domain';
import type { NetSpec } from '../network/schema';

function template(): NetSpec {
  return {
    nodes: [
      { id: 'stock', label: 'Raw stock', kind: 'material' },
      { id: 'cutting', label: 'Cutting', kind: 'machine', count: 3 },
      { id: 'weldA', label: 'Welding cell A', kind: 'welding' },
      { id: 'weldB', label: 'Welding cell B', kind: 'welding' },
      { id: 'paint', label: 'Paint booth', kind: 'paint' },
      { id: 'assembly', label: 'Assembly', kind: 'assembly', count: 2 },
      { id: 'qa', label: 'Quality check', kind: 'inspection' },
      { id: 'packing', label: 'Packing', kind: 'packing' },
      { id: 'dock', label: 'Shipping dock', kind: 'shipping' },
    ],
    edges: [
      { from: 'stock', to: 'cutting' },
      { from: 'cutting', to: 'weldA' },
      { from: 'cutting', to: 'weldB' },
      { from: 'weldA', to: 'paint' },
      { from: 'weldB', to: 'paint' },
      { from: 'paint', to: 'assembly' },
      { from: 'assembly', to: 'qa' },
      { from: 'qa', to: 'packing' },
      { from: 'packing', to: 'dock' },
    ],
  };
}

export const factory = networkDomain({
  id: 'factory',
  label: 'Factory lines',
  blurb: 'Machines, buffers and stations on a production line',
  capabilities:
    'Manufacturing lines: raw material, machining, welding, painting, assembly, inspection and packing stations with parallel machines, work-in-progress buffers between them and a shipping dock. Simulates machine breakdowns, slow stations, starved and blocked stations, and rush orders.',
  limits: ['Units are identical, no product mix or changeovers', 'Breakdowns are injected, not random wear', 'No scrap or rework loops'],
  examples: ['A factory line with cutting machines, two welding cells, a paint booth, assembly, quality check and packing'],
  suggestions: ['What happens if welding cell A breaks down?', 'Where is the bottleneck?', 'What if we get a rush order for 50% more?'],
  keywords: /factory|manufactur|assembly line|production line|work ?stations?|machining|cnc|welding|paint booth|\bwip\b|throughput/i,
  kinds: {
    material: { role: 'source', rate: 9, buffer: 60, doc: 'raw material feed, rate = units per minute (default 9)' },
    machine: { role: 'stage', monthly: 15_000, capacity: 4, buffer: 20, doc: 'machining or cutting, 4 units a minute per machine' },
    welding: { role: 'stage', monthly: 12_000, capacity: 5, buffer: 20, doc: 'welding cell, 5 units a minute' },
    paint: { role: 'stage', monthly: 20_000, capacity: 11, buffer: 20, doc: 'paint booth, 11 units a minute' },
    assembly: { role: 'stage', monthly: 9_000, capacity: 6, buffer: 20, doc: 'assembly station, 6 units a minute per station' },
    inspection: { role: 'stage', monthly: 7_000, capacity: 12, buffer: 20, doc: 'quality check, 12 units a minute' },
    packing: { role: 'stage', monthly: 6_000, capacity: 12, buffer: 20, doc: 'packing, 12 units a minute' },
    shipping: { role: 'sink', doc: 'shipping dock' },
  },
  mode: 'flow',
  unit: 'units',
  tick: 'one minute',
  scoreLabel: '% of planned output',
  lostLabel: 'units not started',
  guidance: 'Use count for parallel machines and buffer for work-in-progress space between stations. Keep every station under 90% load at the planned rate.',
  council: [
    { name: 'LineSupervisor', brief: 'moving work between machines and stations' },
    { name: 'MaintenanceLead', brief: 'repairing machines and spare capacity' },
    { name: 'ProductionPlanner', brief: 'buffers, overtime and the release rate' },
  ],
  surge: {
    label: 'Rush order +50%',
    value: 1.5,
    keywords: ['rush', 'order', 'demand', 'surge', 'spike', 'overtime'],
    claim: 'A rush order 50% above plan overruns the slowest station, and work piles up in front of it.',
  },
  downVerb: 'Break down',
  words: {
    restore: (n) => `Repair ${n}`,
    reroute: (n, to) => `Move ${n}'s work to ${to}`,
    scale: (n) => `Add a machine at ${n}`,
    shed: 'Release 25% less work',
    buffer: (n) => `Add buffer space before ${n}`,
  },
  template,
});
