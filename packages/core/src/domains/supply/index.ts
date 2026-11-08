import { networkDomain } from '../network/domain';
import type { NetSpec } from '../network/schema';

function template(): NetSpec {
  return {
    nodes: [
      { id: 'asia', label: 'Supplier in Vietnam', kind: 'supplier', capacity: 400 },
      { id: 'mexico', label: 'Supplier in Mexico', kind: 'supplier', capacity: 200 },
      { id: 'shenzhen', label: 'Shenzhen factory', kind: 'factory' },
      { id: 'monterrey', label: 'Monterrey factory', kind: 'factory', capacity: 200 },
      { id: 'portLA', label: 'Port of Los Angeles', kind: 'port' },
      { id: 'dallas', label: 'Dallas DC', kind: 'dc' },
      { id: 'atlanta', label: 'Atlanta DC', kind: 'dc' },
      { id: 'storeTX', label: 'Texas stores', kind: 'store', rate: 70 },
      { id: 'storeCO', label: 'Colorado stores', kind: 'store', rate: 50 },
      { id: 'storeGA', label: 'Georgia stores', kind: 'store', rate: 65 },
      { id: 'storeFL', label: 'Florida stores', kind: 'store', rate: 55 },
    ],
    edges: [
      { from: 'asia', to: 'shenzhen', delay: 2 },
      { from: 'mexico', to: 'monterrey', delay: 1 },
      { from: 'shenzhen', to: 'portLA', delay: 14 },
      { from: 'portLA', to: 'dallas', delay: 3 },
      { from: 'portLA', to: 'atlanta', delay: 4 },
      { from: 'monterrey', to: 'dallas', delay: 2 },
      { from: 'monterrey', to: 'atlanta', delay: 3 },
      { from: 'dallas', to: 'storeTX' },
      { from: 'dallas', to: 'storeCO' },
      { from: 'atlanta', to: 'storeGA' },
      { from: 'atlanta', to: 'storeFL' },
    ],
  };
}

export const supply = networkDomain({
  id: 'supply',
  label: 'Supply chains',
  blurb: 'Suppliers, factories, ports and DCs keeping shelves stocked',
  capabilities:
    'Supply chains: suppliers, factories, ports, distribution centres holding inventory, and stores with daily demand, linked by shipping lanes with transit times. Simulates port closures, factory and supplier outages, demand spikes and how inventory and second sources absorb them.',
  limits: ['One product family, measured in pallets', 'Fixed transit times with no cost or pricing', 'Inventory is reordered up to a target, no forecasting'],
  examples: ['A supply chain with suppliers in Vietnam and Mexico, factories, the Port of Los Angeles, two distribution centres and stores across four states'],
  suggestions: ['What happens if the Port of Los Angeles closes?', 'What if demand doubles for the holidays?', 'How much inventory do the DCs need?'],
  keywords: /supply chain|supplier|shipping lane|\bports?\b|freight|inventory|procurement|sourcing|retail stores|distribution cent(er|re)s?\b|stockout/i,
  kinds: {
    supplier: { role: 'source', capacity: 300, doc: 'supplier, 300 pallets a day per unit' },
    factory: { role: 'stage', monthly: 400_000, capacity: 300, doc: 'factory, 300 pallets a day per unit' },
    port: { role: 'stage', perUnit: 25, capacity: 500, doc: 'port or border crossing, 500 pallets a day' },
    dc: { role: 'stage', monthly: 150_000, perUnit: 10, capacity: 250, buffer: 1200, doc: 'distribution centre, ships 250 pallets a day and holds 1200 (buffer)' },
    store: { role: 'sink', rate: 60, doc: 'store or region, rate = daily demand in pallets (default 60)' },
  },
  mode: 'demand',
  unit: 'pallets',
  tick: 'one day',
  scoreLabel: '% of store demand filled',
  lostLabel: 'pallets short',
  guidance:
    'Give each shipping lane a delay in days (ocean 10-20, truck 1-4). Keep stores fed straight from a DC with no delay, and give DCs a buffer of a week or more of demand.',
  council: [
    { name: 'LogisticsLead', brief: 'rerouting freight and expediting' },
    { name: 'InventoryPlanner', brief: 'safety stock and where inventory sits' },
    { name: 'SourcingLead', brief: 'second suppliers and factory capacity' },
  ],
  surge: {
    label: 'Holiday rush ×2',
    value: 2,
    keywords: ['holiday', 'demand', 'rush', 'surge', 'spike', 'black friday'],
    claim: 'A holiday rush that doubles demand empties the DCs before new stock can arrive.',
  },
  downVerb: 'Close',
  words: {
    restore: (n) => `Reopen ${n} at reduced capacity`,
    reroute: (n, to) => `Reroute freight from ${n} through ${to}`,
    scale: (n) => `Add capacity at ${n}`,
    buffer: (n) => `Hold more safety stock at ${n}`,
  },
  template,
});
