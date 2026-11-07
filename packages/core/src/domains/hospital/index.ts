import { networkDomain } from '../network/domain';
import type { NetSpec } from '../network/schema';

function template(): NetSpec {
  return {
    nodes: [
      { id: 'ambulances', label: 'Ambulance arrivals', kind: 'ambulance' },
      { id: 'walkins', label: 'Walk-ins', kind: 'walkin' },
      { id: 'triage', label: 'Triage', kind: 'triage', count: 2 },
      { id: 'erMain', label: 'Main ER', kind: 'er', count: 40 },
      { id: 'erFast', label: 'Fast track', kind: 'er', count: 20 },
      { id: 'imaging', label: 'Imaging', kind: 'imaging', count: 2 },
      { id: 'ward', label: 'General ward', kind: 'ward', count: 80 },
      { id: 'icu', label: 'ICU', kind: 'icu', count: 16 },
      { id: 'home', label: 'Discharged', kind: 'discharge' },
    ],
    edges: [
      { from: 'ambulances', to: 'triage' },
      { from: 'walkins', to: 'triage' },
      { from: 'triage', to: 'erMain', weight: 3 },
      { from: 'triage', to: 'erFast', weight: 2 },
      { from: 'erMain', to: 'imaging', weight: 3 },
      { from: 'erMain', to: 'home', weight: 4 },
      { from: 'erMain', to: 'icu', weight: 0.2 },
      { from: 'erFast', to: 'home', weight: 9 },
      { from: 'erFast', to: 'imaging', weight: 1 },
      { from: 'imaging', to: 'ward', weight: 1 },
      { from: 'imaging', to: 'home', weight: 2 },
      { from: 'ward', to: 'home' },
      { from: 'icu', to: 'home' },
    ],
  };
}

export const hospital = networkDomain({
  id: 'hospital',
  label: 'Hospitals',
  blurb: 'Patient flow from triage through the ER, imaging, wards and ICU',
  capabilities:
    'Hospital patient flow: ambulance and walk-in arrivals, triage, emergency and fast-track beds, imaging, general wards, ICU and discharge. Simulates waiting, boarding when wards are full, diversions, staff or bed shortages and mass-casualty surges.',
  limits: ['Patients are a flow, not individuals with diagnoses', 'Beds turn over at a fixed average length of stay', 'No staffing rosters or shift changes'],
  examples: ['A hospital emergency department with ambulance and walk-in arrivals, triage, a main ER and fast track, imaging, a general ward and an ICU'],
  suggestions: ['What happens if imaging goes down?', 'What if a mass-casualty event doubles arrivals?', 'Where do patients wait the longest?'],
  keywords: /hospital|emergency (room|department)|\ber\b|\bed\b|\bicu\b|patients?|triage|wards?\b|clinic|ambulances?/i,
  kinds: {
    ambulance: { role: 'source', rate: 1.2, buffer: 0, doc: 'ambulance arrivals, rate = patients per tick (default 1.2); turned away when triage is full' },
    walkin: { role: 'source', rate: 2.8, buffer: 10, doc: 'walk-in arrivals, rate = patients per tick (default 2.8), buffer = room to wait outside' },
    triage: { role: 'stage', capacity: 3, buffer: 30, doc: 'triage desk, 3 patients per tick per nurse, buffer = waiting room' },
    er: { role: 'stage', capacity: 0.1, buffer: 15, doc: 'emergency bed, 0.1 patients per tick (100 minute stay); count = beds' },
    imaging: { role: 'stage', capacity: 1.2, buffer: 15, doc: 'CT or X-ray room, 1.2 patients per tick; count = scanners' },
    ward: { role: 'stage', capacity: 0.012, buffer: 0, doc: 'ward bed, 0.012 patients per tick (14 hour stay); count = beds' },
    icu: { role: 'stage', capacity: 0.006, buffer: 0, doc: 'ICU bed, 0.006 patients per tick (28 hour stay); count = beds' },
    discharge: { role: 'sink', doc: 'patients leaving the hospital' },
  },
  mode: 'flow',
  unit: 'patients',
  tick: 'ten minutes',
  scoreLabel: '% of patients treated',
  lostLabel: 'patients diverted',
  guidance: 'Use count for beds, nurses and scanners, and weights to split patients between next steps. Size each step to run under 85% at normal arrivals.',
  council: [
    { name: 'ChargeNurse', brief: 'moving patients and opening overflow space' },
    { name: 'BedManager', brief: 'ward and ICU beds and discharges' },
    { name: 'IncidentCommander', brief: 'diverting ambulances and calling in staff' },
  ],
  surge: {
    label: 'Mass casualty ×2',
    value: 2,
    keywords: ['mass casualty', 'surge', 'outbreak', 'flu', 'spike', 'disaster', 'double'],
    claim: 'A mass-casualty event that doubles arrivals fills the ER, and ambulances start being diverted.',
  },
  downVerb: 'Close',
  words: {
    restore: (n) => `Reopen ${n} with backup staff`,
    reroute: (n, to) => `Send ${n} patients to ${to}`,
    scale: (n) => `Open more capacity in ${n}`,
    shed: 'Divert a quarter of ambulances',
    buffer: (n) => `Open overflow space for ${n}`,
  },
  template,
});
