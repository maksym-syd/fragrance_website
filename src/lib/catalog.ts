// Reference catalog: lazy loader plus pure search. The data file is fetched at runtime from
// public/catalog/ (see scripts/build-catalog.ts), so it never lands in the JS bundle.
import { CATALOG_FILE } from './catalog-manifest';
import { fold, looseKey } from './reference';
import type { Concentration } from './types';

export const CONCENTRATION_CODES: Concentration[] = ['EDT', 'EDP', 'Parfum', 'Extrait'];

/** On-disk format. Parallel columns; note/accord/brand/perfumer values index the dictionaries. */
export interface CatalogFile {
  version: 1;
  generated: string;
  brands: string[];
  notes: string[];
  accords: string[];
  perfumers: string[];
  name: string[];
  brand: number[];
  year: number[]; // 0 = unknown
  conc: number[]; // -1 = unknown
  pop: number[];
  acc: number[][];
  top: number[][];
  heart: number[][];
  base: number[][];
  perf: number[][];
}

export interface CatalogEntry {
  name: string;
  brand: string;
  year: number | null;
  concentration: Concentration | null;
  pop: number;
  accords: string[];
  top: string[];
  heart: string[];
  base: string[];
  perfumers: string[];
  /** Notes with no known position. Only curated quick-add picks have these. */
  flat?: string[];
}

export interface Catalog {
  /** Most popular first, so search can stop filling a bucket early. */
  entries: CatalogEntry[];
  /** Folded " name brand" per entry, with a leading space so " word" finds word starts. */
  hay: string[];
  /** The same with the spaces gone, so "leau" can still find "L'Eau". */
  squashed: string[];
  /** Folded name per entry. */
  names: string[];
  /** Vocabularies, most common first. */
  brands: string[];
  notes: string[];
  accords: string[];
  perfumers: string[];
  byKey: Map<string, CatalogEntry[]>;
}

const squash = (s: string) => s.replace(/ /g, '');

/** Entries grouped by looseKey(), for exact lookups. */
export function indexByKey<T extends Pick<CatalogEntry, 'name' | 'brand'>>(entries: T[]): Map<string, T[]> {
  const byKey = new Map<string, T[]>();
  for (const e of entries) {
    const k = looseKey(e.name, e.brand);
    const list = byKey.get(k);
    if (list) list.push(e);
    else byKey.set(k, [e]);
  }
  return byKey;
}

export function buildCatalog(entries: CatalogEntry[], vocab: Pick<Catalog, 'brands' | 'notes' | 'accords' | 'perfumers'>): Catalog {
  const sorted = [...entries].sort((a, b) => b.pop - a.pop || a.name.localeCompare(b.name));
  const names = sorted.map((e) => fold(e.name));
  const hay = sorted.map((e, i) => ` ${names[i]} ${fold(e.brand)}`);
  return {
    entries: sorted,
    names,
    hay,
    squashed: hay.map(squash),
    ...vocab,
    byKey: indexByKey(sorted),
  };
}

export function decodeCatalog(f: CatalogFile): Catalog {
  if (f.version !== 1 || !Array.isArray(f.name)) throw new Error('Unknown catalog format');
  const pick = (ids: number[], dict: string[]) => ids.map((i) => dict[i]);
  const entries = f.name.map((name, i): CatalogEntry => ({
    name,
    brand: f.brands[f.brand[i]],
    year: f.year[i] || null,
    concentration: CONCENTRATION_CODES[f.conc[i]] ?? null,
    pop: f.pop[i],
    accords: pick(f.acc[i], f.accords),
    top: pick(f.top[i], f.notes),
    heart: pick(f.heart[i], f.notes),
    base: pick(f.base[i], f.notes),
    perfumers: pick(f.perf[i], f.perfumers),
  }));
  return buildCatalog(entries, { brands: f.brands, notes: f.notes, accords: f.accords, perfumers: f.perfumers });
}

let pending: Promise<Catalog> | null = null;

/** Fetch once and share. A failure isn't cached, so the next screen can retry. */
export function loadCatalog(fetcher: typeof fetch = fetch): Promise<Catalog> {
  pending ??= fetcher(`/catalog/${CATALOG_FILE}`)
    .then((res) => {
      if (!res.ok) throw new Error(`Catalog request failed (${res.status})`);
      return res.json() as Promise<CatalogFile>;
    })
    .then(decodeCatalog)
    .catch((err) => {
      pending = null;
      throw err;
    });
  return pending;
}

/** Test hook: forget the shared load. */
export function resetCatalog() {
  pending = null;
}

/** 0 exact name, 1 name prefix, 2 word starts in name, 3 word starts in name+brand, 4 substring. */
function matchTier(hay: string, name: string, q: string, tokens: string[]): number {
  for (const t of tokens) if (!hay.includes(t)) return -1;
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  const paddedName = ` ${name}`;
  if (tokens.every((t) => paddedName.includes(` ${t}`))) return 2;
  if (tokens.every((t) => hay.includes(` ${t}`))) return 3;
  return 4;
}

/**
 * Ranked by how well the text matches, then popularity. One pass with fixed-size buckets and no
 * sort, so it stays cheap on every keystroke even for a single letter.
 */
export function searchCatalog(catalog: Catalog, query: string, limit = 8): CatalogEntry[] {
  const q = fold(query);
  if (!q) return [];
  const tokens = q.split(' ');
  const squashed = squash(q);
  const buckets: CatalogEntry[][] = [[], [], [], [], [], []];
  for (let i = 0; i < catalog.entries.length; i++) {
    let tier = matchTier(catalog.hay[i], catalog.names[i], q, tokens);
    if (tier === -1 && squashed.length >= 3 && catalog.squashed[i].includes(squashed)) tier = 5;
    if (tier !== -1 && buckets[tier].length < limit) buckets[tier].push(catalog.entries[i]);
    if (buckets[0].length >= limit) break;
  }
  return buckets.flat().slice(0, limit);
}

/**
 * Suggestions from a list of terms. `first` (what's already in the room) beats `rest` (the
 * catalog vocabulary); prefix matches beat substrings; duplicates and `exclude` are dropped.
 */
export function suggestTerms(query: string, first: string[], rest: string[], exclude: string[] = [], limit = 8): string[] {
  const q = fold(query);
  const seen = new Set(exclude.map(fold));
  const prefix: string[] = [];
  const inside: string[] = [];
  const consider = (term: string) => {
    const f = fold(term);
    if (!f || seen.has(f)) return;
    const at = q ? ` ${f}`.indexOf(` ${q}`) : 0;
    if (at !== -1) {
      seen.add(f);
      prefix.push(term);
    } else if (f.includes(q)) {
      seen.add(f);
      inside.push(term);
    }
  };
  for (const t of first) consider(t);
  for (const t of rest) {
    if (prefix.length >= limit) break;
    consider(t);
  }
  return [...prefix, ...inside].slice(0, limit);
}

export type ExactMatch<T> =
  | { kind: 'match'; entry: T }
  | { kind: 'ambiguous' | 'conflict'; candidates: T[]; reason: string }
  | { kind: 'none' };

/**
 * The only automatic match: exact folded name and house. Prefixes never count ("Le Beau Narcisse"
 * is not "Le Beau"). If several entries share the name, concentration has to single one out.
 * Backfill and quick add both use this, so they can't disagree.
 */
export function matchExact<T extends Pick<CatalogEntry, 'concentration'>>(
  byKey: Map<string, T[]>,
  name: string,
  house: string,
  concentration: Concentration | null,
): ExactMatch<T> {
  const found = byKey.get(looseKey(name, house)) ?? [];
  if (found.length === 0) return { kind: 'none' };
  if (found.length === 1) {
    const [entry] = found;
    if (concentration && entry.concentration && entry.concentration !== concentration) {
      return { kind: 'conflict', candidates: found, reason: `Same name and house, but the source lists ${entry.concentration} and this row says ${concentration}` };
    }
    return { kind: 'match', entry };
  }
  const same = concentration ? found.filter((e) => e.concentration === concentration) : [];
  if (same.length === 1) return { kind: 'match', entry: same[0] };
  return {
    kind: 'ambiguous',
    candidates: same.length > 1 ? same : found,
    reason: concentration
      ? `${found.length} source entries share this name and concentration doesn't single one out`
      : `${found.length} source entries share this name and this row has no concentration to tell them apart`,
  };
}
