import type { DomainId } from '@tv/core';

export type Shape = 'stack' | 'panel' | 'turbine' | 'pylon' | 'tank' | 'houses' | 'plant' | 'box' | 'crowd' | 'beds' | 'strip' | 'desk' | 'dock' | 'tower' | 'ship';

export interface KindStyle {
  shape: Shape;
  color: string;
}

export interface NetStyle {
  /** Packet colour for flow along the links. */
  flow: string;
  kinds: Record<string, KindStyle>;
}

const fallback: KindStyle = { shape: 'box', color: '#5b6b8c' };

export const NET_STYLES: Partial<Record<DomainId, NetStyle>> = {
  power: {
    flow: '#ffd166',
    kinds: {
      coal: { shape: 'stack', color: '#5a5f6b' },
      gas: { shape: 'stack', color: '#4a6fa5' },
      nuclear: { shape: 'tower', color: '#8fa3bf' },
      solar: { shape: 'panel', color: '#2a4d8f' },
      wind: { shape: 'turbine', color: '#d8e1ee' },
      substation: { shape: 'pylon', color: '#8b98ad' },
      feeder: { shape: 'pylon', color: '#6c7a92' },
      city: { shape: 'houses', color: '#c9a66b' },
      industry: { shape: 'plant', color: '#9b6b4f' },
    },
  },
  water: {
    flow: '#4cc3ff',
    kinds: {
      reservoir: { shape: 'tank', color: '#1f6f9f' },
      well: { shape: 'tower', color: '#3f7f9f' },
      treatment: { shape: 'plant', color: '#3b6e8f' },
      pump: { shape: 'box', color: '#4b5d7a' },
      tank: { shape: 'tower', color: '#7fa7c9' },
      district: { shape: 'houses', color: '#c9a66b' },
      industry: { shape: 'plant', color: '#9b6b4f' },
    },
  },
  supply: {
    flow: '#ffb347',
    kinds: {
      supplier: { shape: 'plant', color: '#7a6a9b' },
      factory: { shape: 'plant', color: '#5f6f9b' },
      port: { shape: 'ship', color: '#3d6b8f' },
      dc: { shape: 'dock', color: '#6b7f9b' },
      store: { shape: 'houses', color: '#c98b6b' },
    },
  },
  hospital: {
    flow: '#ff7a8a',
    kinds: {
      ambulance: { shape: 'box', color: '#e8eef6' },
      walkin: { shape: 'crowd', color: '#9fb3d4' },
      triage: { shape: 'desk', color: '#5f8fbf' },
      er: { shape: 'beds', color: '#bf5f6f' },
      imaging: { shape: 'tank', color: '#8f9fbf' },
      ward: { shape: 'beds', color: '#6f8fbf' },
      icu: { shape: 'beds', color: '#bf8f5f' },
      discharge: { shape: 'crowd', color: '#7fbf8f' },
    },
  },
  factory: {
    flow: '#a3e635',
    kinds: {
      material: { shape: 'dock', color: '#7c5a3a' },
      machine: { shape: 'box', color: '#5f7f9f' },
      welding: { shape: 'box', color: '#bf7f3f' },
      paint: { shape: 'plant', color: '#7f5fbf' },
      assembly: { shape: 'desk', color: '#5f9f8f' },
      inspection: { shape: 'desk', color: '#9fbf5f' },
      packing: { shape: 'box', color: '#9f8f6f' },
      shipping: { shape: 'dock', color: '#6f7f9f' },
    },
  },
  airport: {
    flow: '#e8eef6',
    kinds: {
      arrivals: { shape: 'crowd', color: '#9fb3d4' },
      approach: { shape: 'tower', color: '#8fa3bf' },
      runway: { shape: 'strip', color: '#3a4152' },
      taxiway: { shape: 'strip', color: '#4a5266' },
      gates: { shape: 'dock', color: '#6b7f9b' },
      departure: { shape: 'crowd', color: '#7fbf8f' },
    },
  },
  callcenter: {
    flow: '#5eead4',
    kinds: {
      callers: { shape: 'crowd', color: '#9fb3d4' },
      ivr: { shape: 'tower', color: '#6f7f9f' },
      agents: { shape: 'desk', color: '#5f8fbf' },
      specialists: { shape: 'desk', color: '#9f6fbf' },
      resolved: { shape: 'crowd', color: '#7fbf8f' },
    },
  },
};

export const styleOf = (domain: DomainId, kind: string): KindStyle => NET_STYLES[domain]?.kinds[kind] ?? fallback;
