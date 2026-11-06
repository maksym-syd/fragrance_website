import { describe, expect, it } from 'vitest';
import { accordOverlap, indexRankings, noteOverlap } from './overlap';
import { buildCatalog, type CatalogEntry } from './catalog';
import {
  applyEntry, draftFromFragrance, draftToFragrance, EMPTY_DRAFT, nameOptions, otherNotes, popularEntries, quickAddDetail, roomVocab, validYear,
} from './details';
import { splitNotes } from './reference';
import type { Fragrance } from './types';

const entry = (over: Partial<CatalogEntry>): CatalogEntry => ({
  name: 'Aventus', brand: 'Creed', year: 2010, concentration: null, pop: 1, accords: ['fresh'], top: ['apple'], heart: ['jasmine'], base: ['musk'], perfumers: ['A Perfumer'], ...over,
});
const frag = (over: Partial<Fragrance>): Fragrance => ({
  id: 'f', room_id: 'r', name: 'N', house: 'H', concentration: null, notes: [], perfumers: [], accords: [],
  notes_top: [], notes_heart: [], notes_base: [], release_year: null, added_by: null, created_at: '', ...over,
});

describe('splitNotes', () => {
  it('fixes listed typos and moves accord words', () => {
    expect(splitNotes(['bargamot', 'woody', 'ambegris', 'Rose', 'white floral'])).toEqual({
      notes: ['bergamot', 'ambergris', 'rose'],
      accords: ['woody', 'white floral'],
    });
  });

  it('keeps ingredient-like words that only look like accords', () => {
    expect(splitNotes(['floral notes', 'spices', 'marine']).notes).toEqual(['floral notes', 'spices', 'marine']);
  });
});

describe('draft conversions', () => {
  it('keeps flat notes of old rows as other notes, and saves them back', () => {
    const old = frag({ notes: ['vanilla', 'oud'] });
    const d = draftFromFragrance(old);
    expect(d.other).toEqual(['vanilla', 'oud']);
    expect(draftToFragrance(d).notes).toEqual(['vanilla', 'oud']);
  });

  it('keeps `notes` as the union of pyramid and other notes', () => {
    const f = draftToFragrance({ ...EMPTY_DRAFT, name: 'N', house: 'H', top: ['Apple'], base: ['musk'], other: ['musk', 'oud'], year: '2010' });
    expect(f).toMatchObject({ notes: ['apple', 'musk', 'oud'], notes_top: ['apple'], notes_base: ['musk'], release_year: 2010, concentration: null });
  });

  it('applyEntry fills everything and keeps typed notes', () => {
    const d = applyEntry({ ...EMPTY_DRAFT, other: ['smoke', 'musk'] }, entry({ concentration: 'EDP' }), null);
    expect(d).toMatchObject({ name: 'Aventus', house: 'Creed', concentration: 'EDP', year: '2010', top: ['apple'], heart: ['jasmine'], base: ['musk'], other: ['smoke'] });
  });

  it('switching picks replaces the old pick instead of piling up', () => {
    const first = entry({ name: 'One', top: ['pear'], heart: [], base: [], accords: ['sweet'], perfumers: ['P1'] });
    const second = entry({ name: 'Two', top: ['fig'], heart: [], base: [], accords: ['green'], perfumers: ['P2'] });
    const once = applyEntry({ ...EMPTY_DRAFT, other: ['typed'] }, first, null);
    const twice = applyEntry(once, second, first);
    expect(twice).toMatchObject({ top: ['fig'], other: ['typed'], accords: ['green'], perfumers: ['P2'] });
  });

  it('otherNotes leaves out what the pyramid places', () => {
    expect(otherNotes(frag({ notes: ['a', 'b'], notes_top: ['a'] }))).toEqual(['b']);
  });

  it('validates years like the database does', () => {
    expect(['', '2010', '1709'].map(validYear)).toEqual([true, true, true]);
    expect(['20', '20244', 'abcd', '1600'].map(validYear)).toEqual([false, false, false, false]);
  });
});

describe('quick add', () => {
  const catalog = buildCatalog(
    [entry({ concentration: 'EDP' }), entry({ name: 'Twin', year: 2001 }), entry({ name: 'Twin', year: 2002 })],
    { brands: [], notes: [], accords: [], perfumers: [] },
  );

  it('uses catalog detail on an exact match, keeping curated notes', () => {
    const f = quickAddDetail({ name: 'Aventus', house: 'Creed', concentration: 'EDP', notes: ['pineapple', 'birch', 'musk', 'citrus'] }, catalog);
    expect(f.notes).toEqual(['pineapple', 'birch', 'musk', 'apple', 'jasmine']);
    expect(f).toMatchObject({ accords: ['fresh', 'citrus'], notes_top: ['apple'], release_year: 2010, perfumers: ['A Perfumer'] });
  });

  it('does not guess when ambiguous, or when the catalog failed to load', () => {
    const pick = { name: 'Twin', house: 'Creed', concentration: null, notes: ['rose', 'woody'] };
    expect(quickAddDetail(pick, catalog)).toEqual({ ...pick, notes: ['rose'], accords: ['woody'] });
    expect(quickAddDetail(pick, null)).toEqual({ ...pick, notes: ['rose'], accords: ['woody'] });
  });
});

describe('suggestion sources', () => {
  const room = [
    frag({ id: '1', name: 'Chamo', house: 'Tamburins', notes: ['moss'], accords: ['Green'], perfumers: ['X'] }),
    frag({ id: '2', name: "Terre d'Hermès", house: 'Hermès', notes: ['moss', 'flint'] }),
  ];

  it('the room vocabulary covers houses the catalog lacks', () => {
    expect(roomVocab(room)).toEqual({ houses: ['Tamburins', 'Hermès'], perfumers: ['X'], accords: ['green'], notes: ['moss', 'flint'] });
  });

  it('shows room bottles first and hides catalog copies of them', () => {
    const opts = nameOptions('terre', room, [entry({ name: "Terre d'Hermès", brand: 'Hermes' }), entry({ name: 'Terre Noire', brand: 'X' })], true);
    expect(opts.map((o) => o.kind)).toEqual(['room', 'catalog']);
  });

  it('in edit mode lists catalog entries only', () => {
    expect(nameOptions('chamo', room, [], false)).toEqual([]);
  });

  it('offers curated picks the catalog lacks, with notes unplaced', () => {
    const picks = [{ name: 'Khamrah', house: 'Lattafa', concentration: 'EDP' as const, notes: ['dates', 'citrus'] }];
    expect(popularEntries(picks, 'khamr', null)[0]).toMatchObject({ top: [], flat: ['dates'], accords: ['citrus'] });
    const has = buildCatalog([entry({ name: 'Khamrah', brand: 'Lattafa' })], { brands: [], notes: [], accords: [], perfumers: [] });
    expect(popularEntries(picks, 'khamr', has)).toEqual([]);
  });
});

describe('accordOverlap', () => {
  const idx = indexRankings([
    { member_id: 'a', fragrance_id: 'f1', tier: 'S' },
    { member_id: 'a', fragrance_id: 'f2', tier: 'B' },
    { member_id: 'b', fragrance_id: 'f1', tier: 'D' },
  ]);

  it('averages tiers per accord, per member, normalizing tags', () => {
    const rows = accordOverlap([{ id: 'f1', accords: ['Woody'] }, { id: 'f2', accords: ['woody ', 'fresh'] }], idx);
    expect(rows.map((r) => r.tag)).toEqual(['woody', 'fresh']);
    expect(rows[0].perMember.get('a')).toEqual({ avg: 4, count: 2 });
    expect(rows[0].perMember.get('b')).toEqual({ avg: 1, count: 1 });
  });

  it('ignores rows without accords', () => {
    expect(accordOverlap([{ id: 'f1' }, { id: 'f2', accords: [] }], idx)).toEqual([]);
  });

  it('noteOverlap still reads only the flat notes', () => {
    const rows = noteOverlap([{ id: 'f1', notes: ['rose'], accords: ['woody'] } as never], idx);
    expect(rows.map((r) => r.note)).toEqual(['rose']);
  });
});
