import { describe, expect, it } from 'vitest';
import { cleanPerfumers, cleanRows, dedupeRows, isUseful, mapConcentration, parseCsv, popularity, stripNameNoise } from '../../scripts/lib/parfumo';

const HEADER = 'Number,Name,Brand,Release_Year,Concentration,Rating_Value,Rating_Count,Main_Accords,Top_Notes,Middle_Notes,Base_Notes,Perfumers,URL';
const row = (fields: Partial<Record<string, string>>) => {
  const order = HEADER.split(',');
  return order.map((c) => {
    const v = fields[c] ?? 'NA';
    return /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(',');
};
const clean = (...rows: string[]) => cleanRows([HEADER, ...rows].join('\n'));

describe('parseCsv', () => {
  it('handles quotes, commas and doubled quotes', () => {
    expect(parseCsv('a,"b, c","d ""e"""\n1,2,3\n')).toEqual([['a', 'b, c', 'd "e"'], ['1', '2', '3']]);
  });
});

describe('stripNameNoise', () => {
  it('removes brand, year and concentration', () => {
    expect(stripNameNoise('Mojave Ghost Byredo 2014 Eau de Parfum', 'Byredo', 'Eau de Parfum')).toBe('Mojave Ghost');
    expect(stripNameNoise('Mojave Ghost Byredo Huile Parfum', 'Byredo', 'Huile Parfum')).toBe('Mojave Ghost');
  });

  it('handles a brand with an alias', () => {
    expect(stripNameNoise('Amber Al Haramain / الحرمين 2019 Perfume Oil', 'Al Haramain / الحرمين', 'Perfume Oil')).toBe('Amber');
  });

  it('leaves names alone when the row has no concentration', () => {
    expect(stripNameNoise('On Ice 2004', 'Carolina Herrera', '')).toBe('On Ice 2004');
    expect(stripNameNoise('Aria Missoni', 'Missoni', '')).toBe('Aria Missoni');
  });
});

describe('mapConcentration', () => {
  it('maps to the four values the database allows, and nothing else', () => {
    expect(mapConcentration('Eau de Toilette')).toBe('EDT');
    expect(mapConcentration('Eau de Parfum Intense')).toBe('EDP');
    expect(mapConcentration('Extrait de Parfum')).toBe('Extrait');
    expect(mapConcentration('Parfum')).toBe('Parfum');
    expect(mapConcentration('Eau de Cologne')).toBeNull();
    expect(mapConcentration('Perfume Oil')).toBeNull();
  });
});

describe('cleanPerfumers', () => {
  it('drops companies and role labels', () => {
    expect(cleanPerfumers('Sonia Constant, Givaudan')).toEqual(['Sonia Constant']);
    expect(cleanPerfumers('IFF (International Flavors & Fragrances)')).toEqual([]);
    expect(cleanPerfumers('Claire Baxter Brand owner, Perfume maker')).toEqual(['Claire Baxter']);
    expect(cleanPerfumers('Brand owner [Libertine Fragrance]')).toEqual([]);
  });

  it('keeps one name per person', () => {
    expect(cleanPerfumers('Valery Sokolov / Валерий Соколов')).toEqual(['Valery Sokolov']);
    expect(cleanPerfumers('Emma Vincent (née Dick)')).toEqual(['Emma Vincent']);
    expect(cleanPerfumers('Joseph DeLapp a.k.a. JK DeLapp Perfume maker')).toEqual(['Joseph DeLapp']);
  });
});

describe('cleanRows', () => {
  it('recovers the name and concentration, and lowercases tags', () => {
    const { rows } = clean(row({
      Name: 'Mojave Ghost Byredo 2014 Eau de Parfum', Brand: 'Byredo', Release_Year: '2014', Concentration: 'Eau de Parfum',
      Rating_Count: '652', Main_Accords: 'Floral, Woody', Top_Notes: 'Sapote, Ambrette', Perfumers: 'Jérôme Epinette',
    }));
    expect(rows[0]).toMatchObject({
      name: 'Mojave Ghost', brand: 'Byredo', year: 2014, concentration: 'EDP', ratings: 652,
      accords: ['floral', 'woody'], top: ['sapote', 'ambrette'], perfumers: ['Jérôme Epinette'],
    });
  });

  it('recovers concentration from a name tail, but not from titles', () => {
    const { rows } = clean(
      row({ Name: 'Million Parfum', Brand: 'Paco Rabanne' }),
      row({ Name: 'Le Beau Le Parfum', Brand: 'Jean Paul Gaultier' }),
      row({ Name: 'Essence de Parfum', Brand: 'Roja Parfums' }),
    );
    expect(rows.map((r) => r.concentration)).toEqual(['Parfum', null, null]);
  });

  it('drops products that are not fragrances', () => {
    const products = ['After Shave', 'Hair Perfume', 'Body Spray', 'Solid Perfume', 'Lotion Après-Rasage', 'Brume Cheveux', 'Fragrance Mist', 'Parfum Solide', 'Liquid Balm'];
    const { rows, stats } = clean(
      ...products.map((c) => row({ Name: `X Brand 2010 ${c}`, Brand: 'Brand', Concentration: c })),
      row({ Name: 'Afeitar After Shave', Brand: 'Myrurgia' }),
      row({ Name: 'Kept Brand 2010 Perfume Oil', Brand: 'Brand', Concentration: 'Perfume Oil' }),
      row({ Name: 'Morning Mist', Brand: 'Brand' }),
    );
    expect(rows.map((r) => r.name)).toEqual(['Kept', 'Morning Mist']);
    expect(stats.excludedProducts).toBe(products.length + 1);
  });

  it('drops the stray header rows that caused the "Main Accords" junk value', () => {
    const { rows, stats } = clean(row({ Name: 'Name', Brand: 'Brand', Main_Accords: 'Main Accords' }));
    expect(rows).toEqual([]);
    expect(stats.headerRows).toBe(1);
  });

  it('uses the first brand spelling and the agreed house names', () => {
    const { rows } = clean(row({ Name: 'Ajwad اجواد', Brand: 'Lattafa / لطافة' }), row({ Name: 'Erba Pura', Brand: 'XerJoff' }));
    expect(rows.map((r) => [r.name, r.brand])).toEqual([['Ajwad', 'Lattafa'], ['Erba Pura', 'Xerjoff']]);
  });
});

describe('inclusion and ranking', () => {
  const base = { name: 'N', brand: 'B', year: null, concentration: null, ratings: null, accords: [], top: [], heart: [], base: [], perfumers: [], url: '' };

  it('keeps anything with data, even without a rating count', () => {
    expect(isUseful({ ...base, accords: ['fresh'] })).toBe(true);
    expect(isUseful({ ...base, ratings: 3 })).toBe(true);
    expect(isUseful(base)).toBe(false);
  });

  it('does not rank bottles with a lost count below everything', () => {
    expect(popularity({ ...base, accords: ['a', 'b', 'c', 'd', 'e'] })).toBeGreaterThan(popularity({ ...base, ratings: 26 }));
    expect(popularity({ ...base, accords: ['a'] })).toBe(0);
  });

  it('dedupes identical entries, keeping the richer one', () => {
    const rich = { ...base, top: ['rose'] };
    expect(dedupeRows([base, rich, { ...base, year: 2001 }])).toEqual([rich, { ...base, year: 2001 }]);
  });
});
