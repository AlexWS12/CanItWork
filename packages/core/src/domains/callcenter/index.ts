import { networkDomain } from '../network/domain';
import type { NetSpec } from '../network/schema';

function template(): NetSpec {
  return {
    nodes: [
      { id: 'callers', label: 'Incoming calls', kind: 'callers' },
      { id: 'ivr', label: 'Phone menu', kind: 'ivr' },
      { id: 'tier1', label: 'Support agents', kind: 'agents', count: 60 },
      { id: 'billing', label: 'Billing team', kind: 'agents', count: 14 },
      { id: 'specialists', label: 'Specialists', kind: 'specialists', count: 16 },
      { id: 'resolved', label: 'Resolved', kind: 'resolved' },
    ],
    edges: [
      { from: 'callers', to: 'ivr' },
      { from: 'ivr', to: 'resolved', weight: 4 },
      { from: 'ivr', to: 'tier1', weight: 5 },
      { from: 'ivr', to: 'billing', weight: 1 },
      { from: 'tier1', to: 'resolved', weight: 85 },
      { from: 'tier1', to: 'specialists', weight: 15 },
      { from: 'billing', to: 'resolved' },
      { from: 'specialists', to: 'resolved' },
    ],
  };
}

export const callcenter = networkDomain({
  id: 'callcenter',
  label: 'Call centres',
  blurb: 'Phone menus, agent teams and escalations handling calls',
  capabilities:
    'Contact centres: incoming calls, a self-service phone menu, agent teams, specialist escalation and resolution, with hold queues. Simulates abandoned calls, an outage of the phone menu or a team, slow systems and call spikes.',
  limits: ['Calls are a flow with average handling times', 'No agent skills routing beyond teams', 'Callers abandon only when the hold queue is full'],
  examples: ['A call centre with a phone menu, a support team of 60 agents, a billing team and specialists for escalations'],
  suggestions: ['What happens if the phone menu goes down?', 'What if a product outage triples calls?', 'How many agents do we need?'],
  keywords: /call cent(er|re)|contact cent(er|re)|customer support|support (line|team|agents)|callers?|helpdesk|help desk|hold queue|\bivr\b/i,
  kinds: {
    callers: { role: 'source', rate: 12, buffer: 0, doc: 'incoming calls, rate = calls per minute (default 12)' },
    ivr: { role: 'stage', capacity: 30, buffer: 0, doc: 'phone menu, 30 calls a minute' },
    agents: { role: 'stage', capacity: 0.12, buffer: 40, doc: 'agent, 0.12 calls a minute (8 minute calls); count = agents, buffer = hold queue' },
    specialists: { role: 'stage', capacity: 0.08, buffer: 20, doc: 'specialist, 0.08 calls a minute; count = specialists' },
    resolved: { role: 'sink', doc: 'resolved calls' },
  },
  mode: 'flow',
  unit: 'calls',
  tick: 'one minute',
  scoreLabel: '% of calls answered',
  lostLabel: 'calls abandoned',
  guidance: 'Use count for agents and weights to split calls between self-service, teams and escalation. Keep teams under 85% occupancy.',
  council: [
    { name: 'WorkforceManager', brief: 'staffing, overtime and moving agents between teams' },
    { name: 'RoutingLead', brief: 'phone menu routing and callbacks' },
    { name: 'OperationsManager', brief: 'outages, messaging and deflection' },
  ],
  surge: {
    label: 'Call spike ×3',
    value: 3,
    keywords: ['spike', 'surge', 'outage', 'storm', 'triple', 'flood'],
    claim: 'A product outage that triples calls swamps the support agents, and callers start hanging up.',
  },
  downVerb: 'Take down',
  words: {
    restore: (n) => `Bring ${n} back on the backup system`,
    reroute: (n, to) => `Route ${n} calls to ${to}`,
    scale: (n) => `Add agents to ${n}`,
    shed: 'Play a status message that deflects a quarter of calls',
    buffer: (n) => `Offer callbacks instead of hold for ${n}`,
  },
  template,
});
