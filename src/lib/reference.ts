// Small, hand-reviewed reference maps plus the text folding everything else builds on.
// No fuzzy logic here on purpose: a spelling only changes if someone listed it below.

/** Lowercase, strip accents and punctuation: "Terre d'Hermès" -> "terre d hermes". */
export function fold(input: string): string {
  return input
    .replace(/[øØ]/g, 'o')
    .replace(/[æÆ]/g, 'ae')
    .replace(/[œŒ]/g, 'oe')
    .replace(/ß/g, 'ss')
    .replace(/[łŁ]/g, 'l')
    .replace(/[ıİ]/g, 'i')
    .replace(/°/g, 'o')
    .replace(/&/g, ' and ')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Different spellings of one house, keyed by fold(). Includes the catalog's own forms, so a
 * catalog pick and a room's existing bottle agree. Reviewed by hand: "Arabiyat Prestige" and
 * "Arabiyat" are not here, because being a sub-line isn't the same as being the same house.
 */
const HOUSE_ALIASES: Record<string, string> = {
  ysl: 'Yves Saint Laurent',
  'penhaligon s': "Penhaligon's",
  'etat libre d orange': "Etat Libre d'Orange",
  xerjoff: 'Xerjoff',
  'bdk parfums': 'BDK Parfums',
  'jo malone': 'Jo Malone London',
  'editions de parfums frederic malle': 'Frédéric Malle',
};

/** The agreed spelling of a house, or the input (trimmed) when no alias is listed. */
export function canonicalHouse(house: string): string {
  return HOUSE_ALIASES[fold(house)] ?? house.trim();
}

/** Accent/punctuation-insensitive identity. Looser than dedupeKey(), which mirrors the SQL index. */
export function looseKey(name: string, house: string): string {
  return `${fold(name)}|${fold(canonicalHouse(house))}`;
}

/** Reviewed misspellings and punctuation variants found in live data. */
export const NOTE_FIXES: Record<string, string> = {
  bargamot: 'bergamot',
  ambegris: 'ambergris',
  'ylang ylang': 'ylang-ylang',
  'lily-of-the-valley': 'lily of the valley',
};

/** Words that describe a scent family, not an ingredient. They belong in accords. */
export const ACCORD_WORDS = new Set([
  'aquatic', 'citrus', 'floral', 'fruity', 'lactonic', 'musky', 'spicy', 'sweet', 'tropical',
  'warm', 'white floral', 'woody',
]);

/** Fix listed typos, then split accord words out of a flat notes list. Order is kept. */
export function splitNotes(notes: string[]): { notes: string[]; accords: string[] } {
  const kept = new Set<string>();
  const accords = new Set<string>();
  for (const raw of notes) {
    const n = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!n) continue;
    if (ACCORD_WORDS.has(n)) accords.add(n);
    else kept.add(NOTE_FIXES[n] ?? n);
  }
  return { notes: [...kept], accords: [...accords] };
}
