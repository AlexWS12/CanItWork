import { networkDomain } from '../network/domain';
import type { NetSpec } from '../network/schema';

function template(prompt: string): NetSpec {
  const text = prompt.toLowerCase();
  const wind = /wind/.test(text);
  return {
    nodes: [
      { id: 'coal', label: 'Coal plant', kind: 'coal' },
      { id: 'gas', label: 'Gas plant', kind: 'gas', count: 2 },
      wind ? { id: 'wind', label: 'Wind farm', kind: 'wind' } : { id: 'solar', label: 'Solar farm', kind: 'solar' },
      { id: 'north', label: 'North substation', kind: 'substation' },
      { id: 'south', label: 'South substation', kind: 'substation' },
      { id: 'downtownFeed', label: 'Downtown feeder', kind: 'feeder' },
      { id: 'industryFeed', label: 'Industrial feeder', kind: 'feeder' },
      { id: 'suburbFeed', label: 'Suburb feeder', kind: 'feeder' },
      { id: 'downtown', label: 'Downtown', kind: 'city', rate: 220 },
      { id: 'factories', label: 'Factories', kind: 'industry', rate: 260 },
      { id: 'suburbs', label: 'Suburbs', kind: 'city', rate: 180 },
      { id: 'harbour', label: 'Harbour', kind: 'city', rate: 120 },
    ],
    edges: [
      { from: 'coal', to: 'north', capacity: 450 },
      { from: 'gas', to: 'north', capacity: 300 },
      { from: 'gas', to: 'south', capacity: 600 },
      { from: wind ? 'wind' : 'solar', to: 'south', capacity: 200 },
      { from: 'north', to: 'downtownFeed', capacity: 300 },
      { from: 'north', to: 'industryFeed', capacity: 350 },
      { from: 'south', to: 'downtownFeed', capacity: 250 },
      { from: 'south', to: 'industryFeed', capacity: 250 },
      { from: 'south', to: 'suburbFeed', capacity: 400 },
      { from: 'downtownFeed', to: 'downtown' },
      { from: 'industryFeed', to: 'factories' },
      { from: 'suburbFeed', to: 'suburbs' },
      { from: 'suburbFeed', to: 'harbour' },
    ],
  };
}

export const power = networkDomain({
  id: 'power',
  label: 'Power grids',
  blurb: 'Plants, substations and lines keeping the lights on',
  capabilities:
    'Electric grids: coal, gas, solar and wind plants, transmission substations, distribution feeders, transmission lines with ratings, and towns and industry with demand. Simulates dispatch, line overloads that trip and cascade, plant outages, load shedding and demand surges.',
  limits: ['Power flows split by line, not by impedance or AC physics', 'No frequency, voltage or reactive power', 'Lines trip on sustained overload only'],
  examples: ['A regional power grid with a coal plant, two gas turbines, a solar farm, two substations and a city with factories and suburbs'],
  suggestions: ['What happens if the busiest line trips?', 'What if a heat wave pushes demand up 40%?', 'Where is the single point of failure?'],
  keywords: /power grid|electric(al|ity)? grid|substation|power plant|power station|transmission line|blackout|megawatt|\bmw\b|solar farm|wind farm|utility grid/i,
  kinds: {
    coal: { role: 'source', monthly: 1_330_000, perUnit: 0.42, capacity: 400, doc: 'coal plant, 400 MW per unit' },
    gas: { role: 'source', monthly: 312_000, perUnit: 0.58, capacity: 250, doc: 'gas turbine, 250 MW per unit' },
    solar: { role: 'source', monthly: 200_000, capacity: 120, doc: 'solar farm, 120 MW' },
    wind: { role: 'source', monthly: 500_000, capacity: 150, doc: 'wind farm, 150 MW' },
    nuclear: { role: 'source', monthly: 10_000_000, perUnit: 0.12, capacity: 1000, doc: 'nuclear plant, 1000 MW per reactor' },
    substation: { role: 'stage', monthly: 50_000, capacity: 900, doc: 'transmission substation, 900 MW' },
    feeder: { role: 'stage', monthly: 20_000, capacity: 500, doc: 'distribution feeder, 500 MW' },
    city: { role: 'sink', rate: 200, doc: 'town or district, rate = demand in MW (default 200)' },
    industry: { role: 'sink', rate: 300, doc: 'industrial load, rate = demand in MW (default 300)' },
  },
  mode: 'demand',
  trips: true,
  unit: 'MW',
  tick: 'one minute',
  scoreLabel: '% of demand served',
  lostLabel: 'MW·min unserved',
  guidance:
    'Give every line between plants, substations and feeders a capacity in MW; lines trip after three minutes over it. Keep plant capacity about 25% above total demand and normal line loading under 80%.',
  council: [
    { name: 'GridOperator', brief: 'rerouting power and restoring lines' },
    { name: 'DispatchLead', brief: 'which plants run and starting reserves' },
    { name: 'DemandManager', brief: 'shedding load to keep the rest of the grid up' },
  ],
  surge: {
    label: 'Heat wave +40%',
    value: 1.4,
    keywords: ['heat', 'heatwave', 'demand', 'surge', 'spike', 'peak'],
    claim: 'A heat wave that lifts demand 40% overloads the lines, and they trip one after another.',
  },
  downVerb: 'Trip',
  words: {
    restore: (n) => `Bring ${n} back on reserve`,
    reroute: (n, to) => `Back-feed around ${n} through ${to}`,
    scale: (n) => `Add capacity at ${n}`,
    shed: 'Shed a quarter of demand',
  },
  template,
});
