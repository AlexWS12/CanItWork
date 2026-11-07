import { networkDomain } from '../network/domain';
import type { NetSpec } from '../network/schema';

function template(): NetSpec {
  return {
    nodes: [
      { id: 'inbound', label: 'Inbound flights', kind: 'arrivals' },
      { id: 'approach', label: 'Approach control', kind: 'approach' },
      { id: 'rwy27L', label: 'Runway 27L', kind: 'runway' },
      { id: 'rwy27R', label: 'Runway 27R', kind: 'runway' },
      { id: 'taxi', label: 'Taxiways', kind: 'taxiway' },
      { id: 'terminalA', label: 'Terminal A gates', kind: 'gates', count: 18 },
      { id: 'terminalB', label: 'Terminal B gates', kind: 'gates', count: 14 },
      { id: 'rwy09', label: 'Departure runway 09', kind: 'runway', capacity: 0.8 },
      { id: 'departed', label: 'Departed', kind: 'departure' },
    ],
    edges: [
      { from: 'inbound', to: 'approach' },
      { from: 'approach', to: 'rwy27L' },
      { from: 'approach', to: 'rwy27R' },
      { from: 'rwy27L', to: 'taxi' },
      { from: 'rwy27R', to: 'taxi' },
      { from: 'taxi', to: 'terminalA', weight: 18 },
      { from: 'taxi', to: 'terminalB', weight: 14 },
      { from: 'terminalA', to: 'rwy09' },
      { from: 'terminalB', to: 'rwy09' },
      { from: 'rwy09', to: 'departed' },
    ],
  };
}

export const airport = networkDomain({
  id: 'airport',
  label: 'Airports',
  blurb: 'Runways, taxiways and gates turning flights around',
  capabilities:
    'Airport operations: inbound flights, approach control with a holding stack, arrival and departure runways, taxiways, terminal gates with turnaround times, and departures. Simulates runway closures, fog cutting runway rates, gate shortages, holding, diversions and holiday rushes.',
  limits: ['Flights are a flow, not individual schedules', 'No weather other than slowing a runway', 'No crew, baggage or passenger connections'],
  examples: ['An airport with two arrival runways, a departure runway, approach control, taxiways and two terminals of gates'],
  suggestions: ['What happens if runway 27L closes?', 'What if fog halves the runway rate?', 'How many gates do we need?'],
  keywords: /airport|runways?|air traffic|flights?|aircraft|airline|\bgates?\b|terminal|taxiway|\batc\b|airfield/i,
  kinds: {
    arrivals: { role: 'source', rate: 0.55, buffer: 0, doc: 'inbound flights, rate = flights per minute (default 0.55); diverted when the holding stack is full' },
    approach: { role: 'stage', capacity: 1.5, buffer: 12, doc: 'approach control, 1.5 flights a minute, buffer = holding stack' },
    runway: { role: 'stage', capacity: 0.5, buffer: 4, doc: 'runway, 0.5 movements a minute per runway' },
    taxiway: { role: 'stage', capacity: 2, buffer: 8, doc: 'taxiway system, 2 aircraft a minute' },
    gates: { role: 'stage', capacity: 0.022, buffer: 3, doc: 'gate, 0.022 turnarounds a minute (45 minute turn); count = gates' },
    departure: { role: 'sink', doc: 'flights that have taken off' },
  },
  mode: 'flow',
  unit: 'flights',
  tick: 'one minute',
  scoreLabel: '% of flights turned around',
  lostLabel: 'flights diverted',
  guidance: 'Use count for gates and separate nodes for each runway. Departures need their own runway node so flow stays one way.',
  council: [
    { name: 'TowerSupervisor', brief: 'runway use and sequencing' },
    { name: 'RampController', brief: 'gates, turnarounds and taxi flow' },
    { name: 'FlowManager', brief: 'ground stops, holding and diversions' },
  ],
  surge: {
    label: 'Holiday rush +50%',
    value: 1.5,
    keywords: ['holiday', 'rush', 'surge', 'peak', 'spike', 'busy'],
    claim: 'A holiday rush 50% above schedule overflows the holding stack, and flights start diverting.',
  },
  downVerb: 'Close',
  words: {
    restore: (n) => `Reopen ${n} with reduced spacing`,
    reroute: (n, to) => `Move ${n} traffic to ${to}`,
    scale: (n) => `Add capacity at ${n}`,
    shed: 'Ground stop: hold 25% of inbound flights at origin',
    buffer: (n) => `Extend the holding stack before ${n}`,
  },
  template,
});
