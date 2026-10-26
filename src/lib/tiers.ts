import type { Tier } from './overlap';

export const TIER_LABEL: Record<Tier, string> = {
  S: 'Holy grail',
  A: 'Love',
  B: 'Like',
  C: 'Meh',
  D: 'Nope',
};

export const tierVar = (t: Tier) => `var(--tier-${t.toLowerCase()})`;
