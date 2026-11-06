// Parses and cleans the TidyTuesday Parfumo CSV. Shared by build-catalog and backfill-details.
import { CONCENTRATION_CODES, type CatalogFile } from '../../src/lib/catalog';
import { canonicalHouse } from '../../src/lib/reference';
import type { Concentration } from '../../src/lib/types';

export const CSV_URL =
  'https://raw.githubusercontent.com/rfordatascience/tidytuesday/main/data/2024/2024-12-10/parfumo_data_clean.csv';

export interface SourceRow {
  name: string;
  brand: string;
  year: number | null;
  concentration: Concentration | null;
  /** Rating_Count, or null when the source has none (true of many of the most famous bottles). */
  ratings: number | null;
  accords: string[];
  top: string[];
  heart: string[];
  base: string[];
  perfumers: string[];
  url: string;
}

export interface CleanStats {
  rows: number;
  headerRows: number;
  excludedProducts: number;
  namesCleaned: number;
  concentrationRecovered: number;
  kept: number;
}

/** RFC 4180 parser: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Anything worn on hair, applied after shaving, or sold as a body product rather than a perfume.
const NON_FRAGRANCE = new RegExp(
  [
    'after[ -]?shav', 'aftershave', 'pre[ -]?shave', 'rasage', 'rasierwasser', 'dopo ?barba', 'loci[oó]n',
    'hair', 'cheveux', 'capelli',
    'body', 'corps', 'all[ -]over spray', 'shimmer', 'splash', 'mist', 'brume', 'spritz',
    'solid', 'solide', 'solido', 'cream', 'cr[eè]me', 'crema', 'gel', 'stick', 'balm', 'cushion', 'compact',
    'concr[eè]t', 'lotion', 'sachet', 'shower', 'bath', 'fabric', 'tonic', 'tonique', 'tonico', 'very cool spray',
  ].map((p) => `\\b${p}`).join('|'),
  'i',
);

// Only unambiguous product phrases are trusted in a NAME; "Tonic" or "Mist" alone can be a
// perfume's title, so those are only trusted in the Concentration column.
const NON_FRAGRANCE_NAME =
  /\b(after[ -]?shave|aftershave|apr[eè]s[ -]rasage|body (spray|mist|splash|lotion|cream)|hair (mist|perfume|fragrance)|fragrance mist|solid (perfume|parfum|fragrance|cologne)|parfum solide|deodorant|shower gel|very cool spray)\b/i;

/** Source concentration text -> the app's four values. Anything else (colognes, oils) is null. */
export function mapConcentration(text: string): Concentration | null {
  const c = text.toLowerCase();
  if (/toilette|\bedt\b/.test(c)) return 'EDT';
  if (/extrait|extract|estratto|extracto|\bpure? (perfume|parfum)$/.test(c)) return 'Extrait';
  if (/eau de parf|\bedp\b/.test(c)) return 'EDP';
  if (/^(le )?(parfum|perfume|profumo)$/.test(c)) return 'Parfum';
  return null;
}

// Recovering from the tail of a name when the column is empty. "Le Parfum", "Essence de Parfum"
// and the like are titles, so a bare "Parfum" only counts when nothing but a word precedes it.
const NAME_TAIL_CONCENTRATION: Array<[RegExp, Concentration]> = [
  [/\beau de toilette( intense)?$/i, 'EDT'],
  [/\beau de parfum( intense)?$/i, 'EDP'],
  [/\bextrait( de parfum)?$/i, 'Extrait'],
  [/(?<!\b(le|de|du|d'|l'|la|of|en|au|eau) ?)\bparfum$/i, 'Parfum'],
];

function recoverConcentration(name: string): Concentration | null {
  if (!/\s/.test(name)) return null;
  for (const [re, c] of NAME_TAIL_CONCENTRATION) if (re.test(name)) return c;
  return null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "Mojave Ghost Byredo 2014 Eau de Parfum" -> "Mojave Ghost" (only when that tail is present). */
export function stripNameNoise(name: string, rawBrand: string, concentration: string): string {
  let out = name.trim();
  if (concentration && out.toLowerCase().endsWith(concentration.toLowerCase())) {
    out = out.slice(0, -concentration.length).trim();
  } else if (!concentration) {
    return out;
  }
  out = out.replace(/\s+(1[7-9]|20)\d\d$/, '').trim();
  for (const b of [rawBrand, ...rawBrand.split(' / ')]) {
    const stripped = out.replace(new RegExp(`\\s+${escapeRe(b.trim())}$`, 'i'), '').trim();
    if (stripped && stripped !== out) { out = stripped; break; }
  }
  return out || name.trim();
}

/** Trailing original-script alias: "Ajwad اجواد" -> "Ajwad". Only when Latin text remains. */
function dropScriptAlias(name: string): string {
  const out = name.replace(/[\s\p{Script=Arabic}\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u, '').trim();
  return /\p{Script=Latin}/u.test(out) ? out : name;
}

// Fragrance suppliers credited in place of a person. Reviewed from the full Perfumers list.
const COMPANIES = new Set(
  [
    'Firmenich', 'dsm-firmenich', 'IFF', 'International Flavors & Fragrances', 'Givaudan', 'Robertet', 'Symrise', 'Mane',
    'Takasago', 'Drom', 'SFA', 'Flair', 'Créations Aromatiques', 'Fragrance Resources', 'TechnicoFlor', 'CPL Aromas',
    'Dragoco', "Parf'ex", 'Ravetllat Aromatics', 'PFW Aroma Chemicals', 'Maelstroem', 'Perfumers', 'LUZI', 'Florasynth', 'Coty',
  ].map((s) => s.toLowerCase()),
);

/** "Valery Sokolov / Валерий Соколов" -> "Valery Sokolov"; companies and role labels go. */
export function cleanPerfumers(raw: string): string[] {
  const out = new Set<string>();
  for (const part of raw.split(',')) {
    let p = part.replace(/\[[^\]]*\]/g, ' ');
    p = p.split(' / ')[0];
    p = p.replace(/\s+a\.k\.a\..*$/i, '');
    p = p.replace(/\s*\([^)]*\)/g, ' ');
    p = p.replace(/\b(perfume ?maker|brand owner|fragrance designer)\b/gi, ' ');
    p = p.replace(/\s+/g, ' ').trim();
    if (!p || COMPANIES.has(p.toLowerCase())) continue;
    out.add(p);
  }
  return [...out];
}

const tags = (raw: string) => [
  ...new Set(raw.split(',').map((s) => s.trim().toLowerCase().replace(/\s+/g, ' ')).filter((s) => s && s !== 'main accords')),
];

/** Every fragrance row in the CSV, cleaned. Non-fragrance products and stray headers are dropped. */
export function cleanRows(csvText: string): { rows: SourceRow[]; stats: CleanStats } {
  const [header, ...raw] = parseCsv(csvText);
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const stats: CleanStats = { rows: raw.length, headerRows: 0, excludedProducts: 0, namesCleaned: 0, concentrationRecovered: 0, kept: 0 };
  const rows: SourceRow[] = [];
  for (const r of raw) {
    const get = (c: string) => (r[col[c]] === 'NA' ? '' : (r[col[c]] ?? '').trim());
    // The source has its header repeated 10 times mid-file; that's where "Main Accords" came from.
    if (get('Name') === 'Name') { stats.headerRows++; continue; }
    const conc = get('Concentration');
    const rawName = get('Name');
    if ((conc && NON_FRAGRANCE.test(conc)) || NON_FRAGRANCE_NAME.test(rawName)) { stats.excludedProducts++; continue; }
    const stripped = stripNameNoise(rawName, get('Brand'), conc);
    const name = dropScriptAlias(stripped);
    if (name !== rawName) stats.namesCleaned++;
    let concentration = mapConcentration(conc);
    if (!conc) {
      concentration = recoverConcentration(name);
      if (concentration) stats.concentrationRecovered++;
    }
    const year = Number.parseInt(get('Release_Year'), 10);
    const ratings = Number.parseInt(get('Rating_Count'), 10);
    rows.push({
      name,
      brand: canonicalHouse(get('Brand').split(' / ')[0]),
      year: Number.isFinite(year) ? year : null,
      concentration,
      ratings: Number.isFinite(ratings) ? ratings : null,
      accords: tags(get('Main_Accords')),
      top: tags(get('Top_Notes')),
      heart: tags(get('Middle_Notes')),
      base: tags(get('Base_Notes')),
      perfumers: cleanPerfumers(get('Perfumers')),
      url: get('URL'),
    });
  }
  stats.kept = rows.length;
  return { rows, stats };
}

/**
 * Inclusion rule: a row earns its bytes if it can fill something in. That means it has any
 * accord, note or perfumer, or at least a rating. Bare name-and-year rows are dropped, and
 * rating count alone is not used: the source has no count for Aventus, Sauvage or Tobacco
 * Vanille, so a rating threshold would drop the bottles people look for most.
 */
export function isUseful(r: SourceRow): boolean {
  return r.ratings !== null || r.accords.length + r.top.length + r.heart.length + r.base.length + r.perfumers.length > 0;
}

/**
 * Search rank. 26,000 of the 27,700 rows with a full five accords have ratings, so five accords
 * means people voted on it even when the source lost the count. Such rows rank like a
 * top-sixth bottle (100 ratings) instead of last.
 */
export function popularity(r: SourceRow): number {
  return r.ratings ?? (r.accords.length >= 5 ? 100 : 0);
}

/** Same name, house, concentration and year: keep the row with the most to offer. */
export function dedupeRows(rows: SourceRow[]): SourceRow[] {
  const detail = (r: SourceRow) => r.accords.length + r.top.length + r.heart.length + r.base.length + r.perfumers.length;
  const best = new Map<string, SourceRow>();
  for (const r of rows) {
    const k = [r.name.toLowerCase(), r.brand.toLowerCase(), r.concentration, r.year].join('|');
    const cur = best.get(k);
    if (!cur || detail(r) > detail(cur) || (detail(r) === detail(cur) && popularity(r) > popularity(cur))) best.set(k, r);
  }
  return [...best.values()];
}

/** Most frequent first: small indexes for common values, and the order suggestions want. */
function dictionary(values: string[]): { list: string[]; index: Map<string, number> } {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const list = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
  return { list, index: new Map(list.map((v, i) => [v, i])) };
}

/** Columnar and dictionary-encoded. Columns gzip about 18% better than one array per row. */
export function encodeCatalog(input: SourceRow[], generated: string): CatalogFile {
  const rows = [...input].sort((a, b) => a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name));
  const brands = dictionary(rows.map((r) => r.brand));
  const notes = dictionary(rows.flatMap((r) => [...r.top, ...r.heart, ...r.base]));
  const accords = dictionary(rows.flatMap((r) => r.accords));
  const perfumers = dictionary(rows.flatMap((r) => r.perfumers));
  const ids = (list: string[], d: { index: Map<string, number> }) => list.map((v) => d.index.get(v)!);
  return {
    version: 1,
    generated,
    brands: brands.list,
    notes: notes.list,
    accords: accords.list,
    perfumers: perfumers.list,
    name: rows.map((r) => r.name),
    brand: rows.map((r) => brands.index.get(r.brand)!),
    year: rows.map((r) => r.year ?? 0),
    conc: rows.map((r) => (r.concentration ? CONCENTRATION_CODES.indexOf(r.concentration) : -1)),
    pop: rows.map(popularity),
    acc: rows.map((r) => ids(r.accords, accords)),
    top: rows.map((r) => ids(r.top, notes)),
    heart: rows.map((r) => ids(r.heart, notes)),
    base: rows.map((r) => ids(r.base, notes)),
    perf: rows.map((r) => ids(r.perfumers, perfumers)),
  };
}
