import type { DomainId } from '@tv/core';
import type { PropId } from './props';

export interface KindStyle {
  /** The model drawn for this kind, or a placeholder when it has none. */
  prop: PropId | 'unknown';
  /** Accent colour for the model's trim. */
  color: string;
}

/** What travels along a domain's links: energy and water as glowing beads, goods as boxes, people as people. */
export type Carrier = 'bead' | 'box' | 'person';

export interface NetStyle {
  /** Colour of what flows along the links. */
  flow: string;
  carrier: Carrier;
  kinds: Record<string, KindStyle>;
}

// A kind with no look of its own is drawn as a placeholder, so it never passes for a real machine
const fallback: KindStyle = { prop: 'unknown', color: '#5b6b8c' };

export const NET_STYLES: Partial<Record<DomainId, NetStyle>> = {
  power: {
    flow: '#ffd166',
    carrier: 'bead',
    kinds: {
      coal: { prop: 'coal', color: '#b9473a' },
      gas: { prop: 'gas', color: '#4a6fa5' },
      nuclear: { prop: 'nuclear', color: '#8fa3bf' },
      solar: { prop: 'solar', color: '#2a4d8f' },
      wind: { prop: 'wind', color: '#d8e1ee' },
      substation: { prop: 'substation', color: '#5c6676' },
      feeder: { prop: 'feeder', color: '#6c7a92' },
      city: { prop: 'city', color: '#8a4f3c' },
      industry: { prop: 'industry', color: '#6f7a88' },
    },
  },
  water: {
    flow: '#4cc3ff',
    carrier: 'bead',
    kinds: {
      reservoir: { prop: 'reservoir', color: '#1f6f9f' },
      well: { prop: 'well', color: '#3f7f9f' },
      treatment: { prop: 'treatment', color: '#3b6e8f' },
      pump: { prop: 'pump', color: '#2f6f9f' },
      tank: { prop: 'waterTower', color: '#3f86c9' },
      district: { prop: 'houses', color: '#8a4f3c' },
      industry: { prop: 'industry', color: '#6f7a88' },
    },
  },
  supply: {
    flow: '#ffb347',
    carrier: 'box',
    kinds: {
      supplier: { prop: 'industry', color: '#7a6a9b' },
      factory: { prop: 'industry', color: '#5f6f9b' },
      port: { prop: 'port', color: '#e0a22f' },
      dc: { prop: 'distribution', color: '#6b7f9b' },
      store: { prop: 'store', color: '#c9573b' },
    },
  },
  hospital: {
    flow: '#ff7a8a',
    carrier: 'person',
    kinds: {
      ambulance: { prop: 'ambulance', color: '#d43c3c' },
      walkin: { prop: 'entrance', color: '#4f86c6' },
      triage: { prop: 'triage', color: '#5f8fbf' },
      er: { prop: 'beds', color: '#bf5f6f' },
      imaging: { prop: 'scanner', color: '#4f86c6' },
      ward: { prop: 'beds', color: '#6f8fbf' },
      icu: { prop: 'icu', color: '#bf8f5f' },
      discharge: { prop: 'exit', color: '#3f9f5f' },
    },
  },
  factory: {
    flow: '#a3e635',
    carrier: 'box',
    kinds: {
      material: { prop: 'pallets', color: '#7c5a3a' },
      machine: { prop: 'machine', color: '#3f6fa8' },
      welding: { prop: 'welding', color: '#e0a22f' },
      paint: { prop: 'paint', color: '#a8443a' },
      assembly: { prop: 'assembly', color: '#3f6fa8' },
      inspection: { prop: 'inspection', color: '#5f9f8f' },
      packing: { prop: 'packing', color: '#9f8f6f' },
      shipping: { prop: 'shipping', color: '#6f7f9f' },
    },
  },
  airport: {
    flow: '#e8eef6',
    carrier: 'person',
    kinds: {
      arrivals: { prop: 'entrance', color: '#4f86c6' },
      approach: { prop: 'controlTower', color: '#8fa3bf' },
      runway: { prop: 'runway', color: '#e2b43c' },
      taxiway: { prop: 'taxiway', color: '#e2b43c' },
      gates: { prop: 'gates', color: '#4f86c6' },
      departure: { prop: 'exit', color: '#3f9f5f' },
    },
  },
  callcenter: {
    flow: '#5eead4',
    carrier: 'bead',
    kinds: {
      callers: { prop: 'entrance', color: '#4f86c6' },
      ivr: { prop: 'serverRack', color: '#4f86c6' },
      agents: { prop: 'desks', color: '#4f86c6' },
      specialists: { prop: 'desks', color: '#8f5fbf' },
      resolved: { prop: 'exit', color: '#3f9f5f' },
    },
  },
};

export const styleOf = (domain: DomainId, kind: string): KindStyle => NET_STYLES[domain]?.kinds[kind] ?? fallback;
