import type { KeyCheck, ProviderStatus } from '@tv/core';
import { hasJev, jevCheck } from './jev';
import { geminiStatus, pruneResting, routeChecks } from './llm';
import { storageCheck } from './keep';
import { swarmsCheck } from './swarms';

export const providerStatus = (): ProviderStatus => ({ ...geminiStatus(), typesafe: hasJev(), storage: process.env.DATABASE_URL?.trim() ? 'postgres' : 'file' });

// Checks still running after waitMs report 'unchecked'; they finish in the background and the next poll reads them from the cache.
export async function checkedStatus(waitMs = Infinity): Promise<ProviderStatus> {
  const within = <T>(work: Promise<T>, fallback: T) =>
    Number.isFinite(waitMs) ? Promise.race([work, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), waitMs))]) : work;
  const [routes, swarms, typesafe, storage] = await Promise.all([
    within(routeChecks(), {}),
    within(swarmsCheck(), 'unchecked' as KeyCheck),
    within(jevCheck(), 'unchecked' as KeyCheck),
    within(storageCheck(), 'unchecked' as KeyCheck),
  ]);
  const results = Object.values(routes);
  const gemini: KeyCheck = results.includes('ok') ? 'ok' : results.includes('failing') ? 'failing' : 'unchecked';
  // Prune's own key can check out while the Gemini key vaulted in it fails, so a Prune that is resting after upstream failures reads as failing.
  const prune: KeyCheck = pruneResting() ? 'failing' : (routes.prune ?? 'unchecked');
  return { ...providerStatus(), checks: { gemini, swarms, prune, typesafe, storage } };
}
