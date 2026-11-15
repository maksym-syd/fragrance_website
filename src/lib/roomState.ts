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

/**
 * RLS turns a DELETE you aren't allowed to make into "0 rows, no error". With `.select('id')` on
 * the delete, an empty result means nothing was removed, so report it as an error.
 */
export function requireRows<T, E>(
  res: { data: T[] | null; error: E | null },
  blocked: () => E,
): { data: T[] | null; error: E | null } {
  if (res.error) return res;
  if (!res.data || res.data.length === 0) return { data: null, error: blocked() };
  return res;
}

export const ROOM_DELETE_BLOCKED = 'Couldn’t delete the room. Only the owner can delete it.';
export const FRAGRANCE_REMOVE_BLOCKED = 'Only the room owner can remove a fragrance';
export const INVITE_REMOVE_BLOCKED = 'Only the room owner can remove an invite';

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
