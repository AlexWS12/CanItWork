import type { KeyCheck, ProviderStatus } from '@tv/core';
import { providerStatus, routeChecks } from './llm';
import { swarmsCheck } from './swarms';

// Checks still running after waitMs report 'unchecked'; they finish in the background and the next poll reads them from the cache.
export async function checkedStatus(waitMs = Infinity): Promise<ProviderStatus> {
  const within = <T>(work: Promise<T>, fallback: T) =>
    Number.isFinite(waitMs) ? Promise.race([work, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), waitMs))]) : work;
  const [routes, swarms] = await Promise.all([within(routeChecks(), {}), within(swarmsCheck(), 'unchecked' as KeyCheck)]);
  const results = Object.values(routes);
  const gemini: KeyCheck = results.includes('ok') ? 'ok' : results.includes('failing') ? 'failing' : 'unchecked';
  return { ...providerStatus(), checks: { gemini, swarms, prune: routes.prune ?? 'unchecked' } };
}
