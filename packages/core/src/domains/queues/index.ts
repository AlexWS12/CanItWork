import { networkDomain } from '../network/domain';
import type { NetSpec } from '../network/schema';

// Everyday queueing systems: people, cars or jobs arriving, waiting in line, and being served at stations.
// Security lines, checkouts, toll plazas, elevator banks, intersections, coffee shops, clinics' front desks, ticket gates.

function template(prompt: string): NetSpec {
  if (/elevator|lift/i.test(prompt)) {
    return {
      nodes: [
        { id: 'lobby', label: 'Lobby arrivals', kind: 'arrivals', rate: 9 },
        { id: 'cars', label: 'Elevator cars', kind: 'elevator', count: 4 },
        { id: 'floors', label: 'Upper floors', kind: 'exit' },
      ],
      edges: [
        { from: 'lobby', to: 'cars' },
        { from: 'cars', to: 'floors' },
      ],
    };
  }
  if (/intersection|traffic light|junction|crossroad/i.test(prompt)) {
    return {
      nodes: [
        { id: 'north', label: 'Northbound cars', kind: 'arrivals', rate: 9 },
        { id: 'east', label: 'Eastbound cars', kind: 'arrivals', rate: 7 },
        { id: 'nsGreen', label: 'North-south green', kind: 'lane', count: 2 },
        { id: 'ewGreen', label: 'East-west green', kind: 'lane', count: 2 },
        { id: 'through', label: 'Through the junction', kind: 'exit' },
      ],
      edges: [
        { from: 'north', to: 'nsGreen' },
        { from: 'east', to: 'ewGreen' },
        { from: 'nsGreen', to: 'through' },
        { from: 'ewGreen', to: 'through' },
      ],
    };
  }
  return {
    nodes: [
      { id: 'travellers', label: 'Travellers', kind: 'arrivals', rate: 8 },
      { id: 'idCheck', label: 'ID check', kind: 'check', count: 3 },
      { id: 'scanners', label: 'Scanners', kind: 'station', count: 6, capacity: 1.5 },
      { id: 'bagSearch', label: 'Bag search', kind: 'station', count: 2, capacity: 0.8 },
      { id: 'airside', label: 'Airside', kind: 'exit' },
    ],
    edges: [
      { from: 'travellers', to: 'idCheck' },
      { from: 'idCheck', to: 'scanners' },
      { from: 'scanners', to: 'airside', weight: 9 },
      { from: 'scanners', to: 'bagSearch', weight: 1 },
      { from: 'bagSearch', to: 'airside' },
    ],
  };
}

export const queues = networkDomain({
  id: 'queues',
  label: 'Queues and service',
  blurb: 'Lines, counters, checkpoints, elevators and intersections serving arrivals',
  capabilities:
    'Any system where people, vehicles or jobs arrive, wait in line and are served at stations: airport security, supermarket checkouts, toll plazas, ticket gates, coffee shops, front desks, elevator banks and signalised intersections. Simulates arrival rates, servers per station, service rates, queue lengths and waiting-room limits, people giving up when lines are full, a station or lane closing, slowdowns and rush hours.',
  limits: [
    'Arrivals and service are flows with average times, not individuals',
    'An intersection is modelled as lanes served during their green share, not individual cars',
    'No priority lanes beyond separate stations',
  ],
  examples: ['A supermarket with eight checkouts, four self-service tills and a customer service desk during the Saturday rush'],
  suggestions: ['What happens if two scanners close?', 'What if a rush doubles arrivals?', 'How many servers keep the wait short?'],
  keywords:
    /queues?|\blines?\b.*\b(wait|long|security|checkout)|checkouts?|security (line|checkpoint|screening)|toll|tellers?|elevators?|\blifts?\b|intersection|traffic lights?|junction|coffee shop|cashiers?|counters?|\bdmv\b|booths?|turnstiles?|ticket (gate|office)|front desk|waiting room|supermarket|tills?|self-service|scanners?|bag search|rush hour/i,
  kinds: {
    arrivals: { role: 'source', rate: 6, buffer: 0, doc: 'people, cars or jobs arriving, rate = arrivals per minute (default 6)' },
    check: { role: 'stage', capacity: 3, buffer: 30, doc: 'quick check such as ID, tickets or a turnstile, 3 a minute per server; count = servers, buffer = line length' },
    station: {
      role: 'stage',
      capacity: 1,
      buffer: 40,
      doc: 'service station such as a scanner, cashier, teller, toll booth or barista, 1 a minute per server by default (set capacity); count = servers, buffer = line length',
    },
    lane: {
      role: 'stage',
      capacity: 6,
      buffer: 25,
      doc: 'traffic lane at a signal, about 6 cars a minute per lane during its green share; count = lanes, buffer = queue of waiting cars',
    },
    elevator: { role: 'stage', capacity: 2.5, buffer: 60, doc: 'elevator car, about 2.5 people a minute on round trips; count = cars, buffer = people waiting in the lobby' },
    exit: { role: 'sink', doc: 'served and gone' },
  },
  mode: 'flow',
  unit: 'arrivals',
  tick: 'one minute',
  scoreLabel: '% of arrivals served',
  lostLabel: 'left the line',
  guidance:
    "Use count for servers, lanes or elevator cars, capacity for each one's service rate, and weights to split arrivals between stations. Keep every station under 85% busy at normal arrivals unless the user describes long lines.",
  council: [
    { name: 'OperationsLead', brief: 'opening stations, moving staff and reshaping lines' },
    { name: 'CapacityPlanner', brief: 'servers, service rates and space to wait' },
    { name: 'FlowEngineer', brief: 'routing arrivals and smoothing rushes' },
  ],
  surge: {
    label: 'Rush ×2',
    value: 2,
    keywords: ['rush', 'peak', 'surge', 'spike', 'double', 'crowd', 'busy'],
    claim: 'A rush that doubles arrivals fills the lines and people start giving up.',
  },
  downVerb: 'Close',
  words: {
    restore: (n) => `Reopen ${n}`,
    reroute: (n, to) => `Send ${n}'s line to ${to}`,
    scale: (n) => `Open more of ${n}`,
    shed: 'Turn away a quarter of arrivals at the door',
    buffer: (n) => `Give ${n} more room to queue`,
  },
  template,
});
