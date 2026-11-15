// Pure rules for how a room's load status and its toasts change. No React, no Supabase.
import type { Tier } from './overlap';

export type RoomStatus = 'loading' | 'not-invited' | 'join' | 'ready' | 'error';

export interface LoadState {
  status: RoomStatus;
  /** The last load failed, but an earlier one succeeded, so the data on screen is kept. */
  stale: boolean;
}

export type LoadOutcome = { ok: true; status: 'not-invited' | 'join' | 'ready' } | { ok: false };

/**
 * Only a failed *first* load is an error page. Once the room is on screen, a failed refetch
 * (a network blip, a tab waking up) keeps it and marks it stale. The next success clears that.
 */
export function afterLoad(prev: LoadState, outcome: LoadOutcome): LoadState {
  if (outcome.ok) return { status: outcome.status, stale: false };
  if (prev.status === 'ready' || prev.status === 'join') return { status: prev.status, stale: true };
  return { status: 'error', stale: false };
}

/** How long a toast stays up before clearing itself. */
export const NOTICE_MS = 6000;

export interface Notice {
  /** Changes every time, so the same text twice still re-announces and restarts the timer. */
  id: number;
  tone: 'info' | 'error';
  text: string;
  action?: { label: string; run: () => void };
}

export const shortName = (name: string | undefined) => {
  const n = (name ?? '').trim();
  if (!n) return 'that fragrance';
  return n.length > 40 ? `${n.slice(0, 39)}…` : n;
};

/** "Couldn't move Aventus to S" / "Couldn't unrank Aventus". */
export function tierFailLabel(name: string | undefined, tier: Tier | null): string {
  return tier ? `Couldn’t move ${shortName(name)} to ${tier}` : `Couldn’t unrank ${shortName(name)}`;
}

export function unrankedLabel(name: string | undefined): string {
  return `Unranked ${shortName(name)}`;
}
