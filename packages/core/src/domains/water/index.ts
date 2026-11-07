import { networkDomain } from '../network/domain';
import type { NetSpec } from '../network/schema';

function template(): NetSpec {
  return {
    nodes: [
      { id: 'reservoir', label: 'Reservoir', kind: 'reservoir' },
      { id: 'well', label: 'Well field', kind: 'well' },
      { id: 'plant', label: 'Treatment plant', kind: 'treatment', count: 2 },
      { id: 'pumpEast', label: 'East pump station', kind: 'pump' },
      { id: 'pumpWest', label: 'West pump station', kind: 'pump' },
      { id: 'tankEast', label: 'East water tower', kind: 'tank' },
      { id: 'tankWest', label: 'West water tower', kind: 'tank' },
      { id: 'oldTown', label: 'Old Town', kind: 'district', rate: 140 },
      { id: 'riverside', label: 'Riverside', kind: 'district', rate: 120 },
      { id: 'hills', label: 'The Hills', kind: 'district', rate: 110 },
      { id: 'park', label: 'Industrial park', kind: 'industry', rate: 180 },
    ],
    edges: [
      { from: 'reservoir', to: 'plant' },
      { from: 'well', to: 'plant' },
      { from: 'plant', to: 'pumpEast', capacity: 400 },
      { from: 'plant', to: 'pumpWest', capacity: 400 },
      { from: 'pumpEast', to: 'tankEast' },
      { from: 'pumpWest', to: 'tankWest' },
      { from: 'tankEast', to: 'oldTown' },
      { from: 'tankEast', to: 'riverside' },
      { from: 'tankWest', to: 'hills' },
      { from: 'tankWest', to: 'park' },
    ],
  };
}

export const water = networkDomain({
  id: 'water',
  label: 'Water networks',
  blurb: 'Reservoirs, treatment, pumps and towers supplying a town',
  capabilities:
    'Water distribution: reservoirs and wells, treatment plants, pump stations, storage tanks and water towers, mains with capacities, and districts with demand. Simulates how storage buys time when a pump or main fails, and demand peaks such as heat waves.',
  limits: ['Flow volumes only, no pressure or hydraulics', 'No water quality or contamination', 'Mains carry flow one way'],
  examples: ['A town water network with a reservoir, a treatment plant, two pump stations, two water towers and four districts'],
  suggestions: ['What happens if the east pump station fails?', 'How long do the water towers last?', 'What if demand jumps 50% in a heat wave?'],
  keywords: /water (network|system|supply|distribution|utility|main)|reservoir|water tower|pump(ing)? station|treatment plant|aquifer|wells?\b/i,
  kinds: {
    reservoir: { role: 'source', capacity: 600, doc: 'reservoir or river intake, 600 m³ per unit' },
    well: { role: 'source', capacity: 150, doc: 'well field, 150 m³' },
    treatment: { role: 'stage', capacity: 400, doc: 'treatment plant, 400 m³ per unit' },
    pump: { role: 'stage', capacity: 350, doc: 'pump station, 350 m³ per unit' },
    tank: { role: 'stage', capacity: 600, buffer: 3000, doc: 'storage tank or water tower, releases 600 m³ and holds 3000 m³ (buffer)' },
    district: { role: 'sink', rate: 120, doc: 'residential district, rate = demand in m³ (default 120)' },
    industry: { role: 'sink', rate: 200, doc: 'industrial customer, rate = demand in m³ (default 200)' },
  },
  mode: 'demand',
  unit: 'm³',
  tick: 'ten minutes',
  scoreLabel: '% of demand supplied',
  lostLabel: 'm³ short',
  guidance: 'Put a tank or tower between pumps and districts so storage covers outages; size sources about 30% above total demand.',
  council: [
    { name: 'NetworkOperator', brief: 'valves, rerouting and backup pumps' },
    { name: 'StorageManager', brief: 'tank levels and how long storage lasts' },
    { name: 'DemandManager', brief: 'water restrictions and cutting demand' },
  ],
  surge: {
    label: 'Heat wave +50%',
    value: 1.5,
    keywords: ['heat', 'heatwave', 'demand', 'surge', 'drought', 'peak'],
    claim: 'A heat wave that lifts demand 50% drains the towers faster than the pumps can refill them.',
  },
  downVerb: 'Fail',
  words: {
    restore: (n) => `Start the standby pump at ${n}`,
    reroute: (n, to) => `Open the valve to feed around ${n} from ${to}`,
    scale: (n) => `Add capacity at ${n}`,
    shed: 'Impose water restrictions (25% less use)',
    buffer: (n) => `Add storage at ${n}`,
  },
  template,
});
