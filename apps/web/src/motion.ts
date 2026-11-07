const query = typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

export const reducedMotion = () => query?.matches ?? false;

export const scrollBehavior = (): ScrollBehavior => (reducedMotion() ? 'auto' : 'smooth');
