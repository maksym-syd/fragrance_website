// Pure helpers between the form, the catalog and stored rows.
import { fold, looseKey, splitNotes } from './reference';
import { matchExact, type Catalog, type CatalogEntry } from './catalog';
import { normalizeNote } from './overlap';
import type { Concentration, Fragrance, FragrancePatch, NewFragrance } from './types';

export interface Draft {
  name: string;
  house: string;
  concentration: Concentration | '';
  year: string;
  perfumers: string[];
  accords: string[];
  top: string[];
  heart: string[];
  base: string[];
  /** Flat notes with no known place in the pyramid. */
  other: string[];
}

export const EMPTY_DRAFT: Draft = {
  name: '', house: '', concentration: '', year: '', perfumers: [], accords: [], top: [], heart: [], base: [], other: [],
};

const unique = (...lists: string[][]) => [...new Set(lists.flat())];

/** Flat notes that aren't in the pyramid. Old rows have only these. */
export function otherNotes(f: Pick<Fragrance, 'notes' | 'notes_top' | 'notes_heart' | 'notes_base'>): string[] {
  const placed = new Set([...f.notes_top, ...f.notes_heart, ...f.notes_base]);
  return f.notes.filter((n) => !placed.has(n));
}

export function draftFromFragrance(f: Fragrance): Draft {
  return {
    name: f.name,
    house: f.house,
    concentration: f.concentration ?? '',
    year: f.release_year ? String(f.release_year) : '',
    perfumers: f.perfumers,
    accords: f.accords,
    top: f.notes_top,
    heart: f.notes_heart,
    base: f.notes_base,
    other: otherNotes(f),
  };
}

/**
 * Fill a draft from a catalog pick. Notes a person typed survive as "other" notes; notes that
 * came from `previous` (an earlier pick being replaced) go, so switching picks doesn't pile up.
 */
export function applyEntry(draft: Draft, entry: CatalogEntry, previous: CatalogEntry | null): Draft {
  const notesOf = (e: CatalogEntry) => [...e.top, ...e.heart, ...e.base, ...(e.flat ?? [])];
  const fromPrevious = new Set(previous ? notesOf(previous) : []);
  const placed = new Set(notesOf(entry));
  const typed = unique(draft.top, draft.heart, draft.base, draft.other);
  const typedAccords = draft.accords.filter((a) => !previous?.accords.includes(a));
  const typedPerfumers = draft.perfumers.filter((p) => !previous?.perfumers.includes(p));
  return {
    name: entry.name,
    house: entry.brand,
    concentration: entry.concentration ?? draft.concentration,
    year: entry.year ? String(entry.year) : draft.year,
    perfumers: unique(entry.perfumers, typedPerfumers),
    accords: unique(entry.accords, typedAccords),
    top: entry.top,
    heart: entry.heart,
    base: entry.base,
    other: unique(entry.flat ?? [], typed.filter((n) => !placed.has(n) && !fromPrevious.has(n))),
  };
}

export function parseYear(text: string): number | null {
  const y = Number.parseInt(text, 10);
  return Number.isFinite(y) ? y : null;
}

/** Matches the check constraint in 003_fragrance_details.sql. */
export const validYear = (text: string) => {
  if (!text.trim()) return true;
  return /^\d{4}$/.test(text.trim()) && Number(text) >= 1700 && Number(text) <= 2100;
};

export function draftToFragrance(d: Draft): FragrancePatch {
  const clean = (list: string[]) => unique(list.map(normalizeNote).filter(Boolean));
  const [top, heart, base] = [clean(d.top), clean(d.heart), clean(d.base)];
  return {
    name: d.name,
    house: d.house,
    concentration: d.concentration || null,
    notes: unique(top, heart, base, clean(d.other)),
    perfumers: unique(d.perfumers.map((p) => p.trim()).filter(Boolean)),
    accords: clean(d.accords),
    notes_top: top,
    notes_heart: heart,
    notes_base: base,
    release_year: parseYear(d.year),
  };
}

/** Quick add: curated picks gain catalog detail only on an unambiguous exact match. */
export function quickAddDetail(pick: NewFragrance, catalog: Catalog | null): NewFragrance {
  const { notes, accords } = splitNotes(pick.notes);
  const m = catalog ? matchExact(catalog.byKey, pick.name, pick.house, pick.concentration) : null;
  if (m?.kind !== 'match') return { ...pick, notes, accords };
  const e = m.entry;
  return {
    ...pick,
    concentration: pick.concentration ?? e.concentration,
    notes: unique(notes, e.top, e.heart, e.base),
    accords: unique(e.accords, accords),
    perfumers: e.perfumers,
    notes_top: e.top,
    notes_heart: e.heart,
    notes_base: e.base,
    release_year: e.year,
  };
}

function byFrequency(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
}

export interface RoomVocab {
  houses: string[];
  perfumers: string[];
  accords: string[];
  notes: string[];
}

/** What this room already uses, so bottles missing from the catalog still get suggestions. */
export function roomVocab(fragrances: Fragrance[]): RoomVocab {
  return {
    houses: byFrequency(fragrances.map((f) => f.house)),
    perfumers: byFrequency(fragrances.flatMap((f) => f.perfumers)),
    accords: byFrequency(fragrances.flatMap((f) => f.accords.map(normalizeNote))),
    notes: byFrequency(fragrances.flatMap((f) => f.notes.map(normalizeNote))),
  };
}

export type NameOption = { kind: 'room'; fragrance: Fragrance } | { kind: 'catalog'; entry: CatalogEntry };

/**
 * Catalog and curated picks not already in the room. With `showRoom`, room bottles come first:
 * they can't be added twice, so picking one opens it instead.
 */
export function nameOptions(query: string, room: Fragrance[], entries: CatalogEntry[], showRoom: boolean, limit = 8): NameOption[] {
  const tokens = fold(query).split(' ').filter(Boolean);
  if (tokens.length === 0) return [];
  const inRoom = !showRoom ? [] : room
    .filter((f) => {
      const hay = fold(`${f.name} ${f.house}`);
      return tokens.every((t) => hay.includes(t));
    })
    .slice(0, 3)
    .map((fragrance): NameOption => ({ kind: 'room', fragrance }));
  const taken = new Set(room.map((f) => looseKey(f.name, f.house)));
  const rest = entries
    .filter((e) => !taken.has(looseKey(e.name, e.brand)))
    .map((entry): NameOption => ({ kind: 'catalog', entry }));
  return [...inRoom, ...rest].slice(0, limit);
}

/** Curated picks as catalog-shaped entries, so they work when the catalog has no such bottle. */
export function popularEntries(picks: NewFragrance[], query: string, catalog: Catalog | null): CatalogEntry[] {
  const tokens = fold(query).split(' ').filter(Boolean);
  if (tokens.length === 0) return [];
  return picks
    .filter((p) => {
      if (catalog?.byKey.has(looseKey(p.name, p.house))) return false;
      const hay = fold(`${p.name} ${p.house}`);
      return tokens.every((t) => hay.includes(t));
    })
    .map((p) => {
      const { notes, accords } = splitNotes(p.notes);
      return {
        name: p.name, brand: p.house, year: null, concentration: p.concentration, pop: 0,
        accords, top: [], heart: [], base: [], perfumers: [], flat: notes,
      };
    });
}
