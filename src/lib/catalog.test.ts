import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeCatalog, type SourceRow } from '../../scripts/lib/parfumo';
import { CATALOG_FILE } from './catalog-manifest';
import {
  buildCatalog, decodeCatalog, indexByKey, loadCatalog, matchExact, resetCatalog, searchCatalog, suggestTerms,
  type CatalogEntry, type CatalogFile,
} from './catalog';
import { canonicalHouse, fold, looseKey } from './reference';

const entry = (name: string, brand: string, pop = 0, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({
  name, brand, year: null, concentration: null, pop, accords: [], top: [], heart: [], base: [], perfumers: [], ...extra,
});
const vocab = { brands: [], notes: [], accords: [], perfumers: [] };

const catalog = buildCatalog([
  entry("Terre d'Hermès", 'Hermès', 900),
  entry("Terre d'Hermès Eau Givrée", 'Hermès', 774),
  entry('Un Jardin sur le Nil', 'Hermès', 500),
  entry('Terre', 'Obscure House', 1),
  entry("L'Eau d'Issey", 'Issey Miyake', 400),
  entry('The One', 'Dolce & Gabbana', 300),
  entry('Sauvage', 'Dior', 950),
  entry('Eau Sauvage', 'Dior', 200),
], vocab);
const names = (q: string) => searchCatalog(catalog, q).map((e) => e.name);

describe('fold', () => {
  it('ignores accents, case and punctuation', () => {
    expect(fold("Terre d'Hermès")).toBe('terre d hermes');
    expect(fold('Terre d’Hermes')).toBe('terre d hermes');
    expect(fold('Kirkè')).toBe('kirke');
    expect(fold('Dolce & Gabbana')).toBe('dolce and gabbana');
    expect(fold('Ÿ  Œuvre')).toBe('y oeuvre');
  });

  it('keeps non-Latin text instead of erasing it', () => {
    expect(fold('لطافة')).not.toBe('');
  });
});

describe('searchCatalog', () => {
  it('finds accented names from plain text', () => {
    expect(names('Hermes')).toContain("Terre d'Hermès");
    expect(names('Terre d Hermes')[0]).toBe("Terre d'Hermès");
    expect(names("terre d'hermès")[0]).toBe("Terre d'Hermès");
  });

  it('matches the house too, in any word order', () => {
    expect(names('hermes terre')).toContain("Terre d'Hermès Eau Givrée");
    expect(names('dolce one')).toEqual(['The One']);
    expect(names('dolce and gabbana')).toEqual(['The One']);
  });

  it('prefers the exact name, then prefixes, then popularity', () => {
    expect(names('terre')).toEqual(['Terre', "Terre d'Hermès", "Terre d'Hermès Eau Givrée"]);
    expect(names('sauv')).toEqual(['Sauvage', 'Eau Sauvage']);
  });

  it('survives missing spaces', () => {
    expect(names('leau')).toContain("L'Eau d'Issey");
  });

  it('returns nothing for empty or punctuation-only input, and respects the limit', () => {
    expect(names('')).toEqual([]);
    expect(names(" ' ")).toEqual([]);
    expect(searchCatalog(catalog, 'e', 2)).toHaveLength(2);
  });
});

describe('suggestTerms', () => {
  it('puts room terms first, then catalog terms, without repeats', () => {
    expect(suggestTerms('van', ['vanilla caviar'], ['vanilla', 'Vanilla Caviar', 'madagascar vanilla'])).toEqual([
      'vanilla caviar', 'vanilla', 'madagascar vanilla',
    ]);
  });

  it('prefers word starts over substrings, and leaves out chosen terms', () => {
    expect(suggestTerms('rose', [], ['primrose', 'rose', 'tea rose'], ['ROSE'])).toEqual(['tea rose', 'primrose']);
  });

  it('with no query offers room terms first, so an empty field is still useful', () => {
    expect(suggestTerms('', ['oud'], ['musk'], [], 2)).toEqual(['oud', 'musk']);
  });

  it('is accent-insensitive', () => {
    expect(suggestTerms('frederic', [], ['Frédéric Malle'])).toEqual(['Frédéric Malle']);
  });
});

describe('matchExact', () => {
  const index = indexByKey([
    entry('Le Beau', 'Jean Paul Gaultier'),
    entry("Terre d'Hermès Eau Givrée", 'Hermès'),
    entry('Sauvage', 'Dior', 0, { concentration: 'EDT' }),
    entry('Sauvage', 'Dior', 0, { concentration: 'EDP' }),
    entry('Dior Homme Intense', 'Dior', 0, { year: 2007 }),
    entry('Dior Homme Intense', 'Dior', 0, { year: 2011 }),
    entry('Libre', 'Yves Saint Laurent', 0, { concentration: 'EDP' }),
  ]);

  it('never treats a prefix as a match', () => {
    expect(matchExact(index, 'Le Beau Narcisse', 'Jean Paul Gaultier', null).kind).toBe('none');
    expect(matchExact(index, "Terre d'Hermès", 'Hermès', 'EDT').kind).toBe('none');
  });

  it('matches through accents, case and house aliases', () => {
    expect(matchExact(index, 'LE BEAU', 'jean paul gaultier', null).kind).toBe('match');
    expect(matchExact(index, 'Libre', 'YSL', 'EDP').kind).toBe('match');
  });

  it('uses concentration to tell entries apart', () => {
    const m = matchExact(index, 'Sauvage', 'Dior', 'EDP');
    expect(m.kind === 'match' && m.entry.concentration).toBe('EDP');
  });

  it('calls it ambiguous when nothing tells entries apart', () => {
    expect(matchExact(index, 'Sauvage', 'Dior', null).kind).toBe('ambiguous');
    expect(matchExact(index, 'Dior Homme Intense', 'Dior', 'EDP').kind).toBe('ambiguous');
  });

  it('flags a concentration that disagrees with the only entry', () => {
    expect(matchExact(index, 'Libre', 'Yves Saint Laurent', 'EDT').kind).toBe('conflict');
  });
});

describe('house aliases', () => {
  it('unifies the known variants and leaves others alone', () => {
    expect(canonicalHouse('YSL')).toBe('Yves Saint Laurent');
    expect(canonicalHouse('Penhaligon’s')).toBe("Penhaligon's");
    expect(canonicalHouse('Etat Libre d’Orange')).toBe("Etat Libre d'Orange");
    expect(canonicalHouse('Arabiyat Prestige')).toBe('Arabiyat Prestige');
    expect(looseKey('Tuxedo', 'YSL')).toBe(looseKey('tuxedo', 'Yves Saint Laurent'));
  });
});

describe('encoding', () => {
  const row: SourceRow = {
    name: 'Aventus', brand: 'Creed', year: 2010, concentration: 'EDP', ratings: null, url: 'u',
    accords: ['fresh', 'fruity', 'citrus', 'woody', 'smoky'], top: ['apple'], heart: ['jasmine'], base: ['musk'], perfumers: ['Someone'],
  };

  it('round-trips every field', () => {
    const c = decodeCatalog(encodeCatalog([row, { ...row, name: 'Bare', year: null, concentration: null, accords: [] }], '2024-12-10'));
    const e = c.entries.find((x) => x.name === 'Aventus')!;
    expect(e).toMatchObject({ brand: 'Creed', year: 2010, concentration: 'EDP', top: ['apple'], heart: ['jasmine'], base: ['musk'], perfumers: ['Someone'] });
    expect(e.accords).toEqual(row.accords);
    expect(c.entries.find((x) => x.name === 'Bare')).toMatchObject({ year: null, concentration: null });
  });

  it('rejects an unknown format', () => {
    expect(() => decodeCatalog({ version: 2 } as unknown as CatalogFile)).toThrow(/Unknown catalog/);
  });
});

describe('loadCatalog', () => {
  beforeEach(resetCatalog);
  const file = encodeCatalog([], 'x');

  it('fetches once and shares the result', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(file)));
    const [a, b] = await Promise.all([loadCatalog(fetcher), loadCatalog(fetcher)]);
    expect(a).toBe(b);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(`/catalog/${CATALOG_FILE}`);
  });

  it('rejects on HTTP errors and on the HTML fallback, then allows a retry', async () => {
    await expect(loadCatalog(async () => new Response('nope', { status: 500 }))).rejects.toThrow(/500/);
    await expect(loadCatalog(async () => new Response('<!doctype html>'))).rejects.toThrow();
    await expect(loadCatalog(async () => { throw new TypeError('offline'); })).rejects.toThrow(/offline/);
    await expect(loadCatalog(async () => new Response(JSON.stringify(file)))).resolves.toBeTruthy();
  });
});

describe('the shipped catalog file', () => {
  const body = readFileSync(resolve(__dirname, '../../public/catalog', CATALOG_FILE));
  const real = decodeCatalog(JSON.parse(body.toString()) as CatalogFile);

  it('stays well under the size budget', () => {
    expect(gzipSync(body).length).toBeLessThan(1_200_000);
  });

  it('finds real bottles the way people type them', () => {
    const first = (q: string) => searchCatalog(real, q)[0];
    expect(first('Terre d Hermes')).toMatchObject({ name: "Terre d'Hermès", brand: 'Hermès' });
    expect(first('aventus').name).toBe('Aventus');
    expect(first('mojave ghost')).toMatchObject({ name: 'Mojave Ghost', concentration: 'EDP', year: 2014 });
  });

  it('holds no junk accords and no non-fragrance products', () => {
    expect(real.accords).not.toContain('main accords');
    expect(real.perfumers.filter((p) => /^(Givaudan|Firmenich|IFF\b|Perfume maker)/i.test(p))).toEqual([]);
    expect(real.perfumers.filter((p) => /\s\/\s|Brand owner/.test(p))).toEqual([]);
    expect(real.entries.filter((e) => /\b(After ?Shave|Hair Perfume|Body Spray|Solid Perfume)\b/i.test(e.name))).toEqual([]);
  });

  it('is fast enough to run on every keystroke', () => {
    const queries = ['a', 'e', 'th', 'sau', 'terre d', 'hermes', 'zzzzzz', 'chanel n', 'maison francis k'];
    const start = performance.now();
    for (let i = 0; i < 5; i++) for (const q of queries) searchCatalog(real, q);
    const perQuery = (performance.now() - start) / (queries.length * 5);
    expect(perQuery).toBeLessThan(16); // one frame, with a wide margin on a laptop
  });
});
