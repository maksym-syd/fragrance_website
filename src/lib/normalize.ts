import type { User } from '@supabase/supabase-js';
import { normalizeNote } from './overlap';

/** Case/space-insensitive identity for a fragrance. Mirrors fragrances_room_dedupe_key in SQL. */
export function dedupeKey(name: string, house: string): string {
  const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase();
  return `${squash(name)}|${squash(house)}`;
}

/** "Vanilla, tonka bean ,  OUD" -> ["vanilla", "tonka bean", "oud"] */
export function parseNotes(input: string): string[] {
  return [...new Set(input.split(/[,;\n]/).map(normalizeNote).filter(Boolean))].slice(0, 12);
}

export function normalizeCode(input: string): string {
  return input.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 6);
}

export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

export function defaultDisplayName(user: User): string {
  const meta = user.user_metadata ?? {};
  const name: string = meta.full_name || meta.name || (user.email ?? '').split('@')[0] || 'Me';
  return name.trim().slice(0, 40);
}
