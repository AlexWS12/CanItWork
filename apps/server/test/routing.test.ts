import { domainList, type DomainId } from '@tv/core';
import { describe, expect, it } from 'vitest';
import { routePrompt } from '../src/fallback';

describe('keyless routing', () => {
  it.each(domainList().map((d) => [d.id, d.examples[0]] as [DomainId, string]))('sends the %s preset to its own domain', (id, example) => {
    expect(routePrompt(example)).toBe(id);
  });

  it.each([
    ['power', 'Simulate a city power grid with substations and a gas power plant'],
    ['power', 'What causes a blackout when a transmission line fails?'],
    ['water', 'A water distribution system with a reservoir and a water tower'],
    ['supply', 'Our supply chain ships from a supplier in China through a port to our stores'],
    ['hospital', 'An emergency room with triage, an ICU and patients arriving by ambulance'],
    ['factory', 'A production line with CNC machining, welding and a paint booth'],
    ['airport', 'An airport with two runways, a terminal and 30 gates'],
    ['callcenter', 'A call center with 50 support agents and an IVR'],
    // Prompts the older domains must keep, even with the new keywords around.
    ['electronics', 'An Arduino with a servo, a sensor on a serial port and an LED'],
    ['software', 'A distributed payment system with a load balancer and microservices'],
    ['database', 'A database schema with tables for patients, doctors and appointments'],
    ['warehouse', 'A warehouse with robots, conveyor belts and shelves'],
  ] as Array<[DomainId, string]>)('routes to %s: %s', (id, prompt) => {
    expect(routePrompt(prompt)).toBe(id);
  });

  it('routes nothing when no domain fits', () => {
    expect(routePrompt('A recipe for sourdough bread')).toBeNull();
    expect(routePrompt('')).toBeNull();
  });
});
