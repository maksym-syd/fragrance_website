// What a person's (or a room's) taste is like, relative to their own habits. Pure: data in, numbers out.
// See docs/audit/taste.md §2–§4 for the reasoning and the worked examples the tests use.
import {
  normalizeNote,
  tagOverlap,
  TIERS,
  tierForValue,
  type PairMatch,
  type RankIndex,
  type TagRow,
  type Tier,
} from './overlap';
import { canonicalHouse } from './reference';

// Re-exported so taste features have one place to import from; the match maths lives in overlap.ts.
export { CHANCE_MATCH, confidence, MATCH_K, shrinkMatch, type Confidence } from './overlap';

/** Shrinkage for lifts: bottles' worth of "no opinion" mixed in. One S bottle can't outrank a pattern. */
export const LIFT_K = 2;
/** |lift| at which a tag is worth mentioning: half a tier above or below your own average. */
export const PULL = 0.5;
/** Ranked bottles before we describe someone's nose or strictness at all. */
export const MIN_RANKED = 5;
/** Bottles with a note or accord before it can be a pull or a dislike. */
export const MIN_TAG = 2;
/** Bottles by one perfumer or house before it can be a streak. */
export const MIN_STREAK = 3;
/** How far from the room's average strictness counts as generous or tough. */
export const STRICT_GAP = 0.3;

export interface Baseline {
  /** Mean tier value on the ±2 scale. */
  mean: number;
  count: number;
}

/** Each member's average over everything they ranked: their personal "B". */
export function memberBaselines(idx: RankIndex): Map<string, Baseline> {
  const out = new Map<string, Baseline>();
  for (const [member, ranks] of idx) {
    if (ranks.size === 0) continue;
    let sum = 0;
    for (const v of ranks.values()) sum += v;
    out.set(member, { mean: sum / ranks.size, count: ranks.size });
  }
  return out;
}

/**
 * How much higher (or lower) than their own average someone ranks bottles with a tag, shrunk
 * towards 0 when there's little evidence: Σ(v − μ) / (count + K) = count·(avg − μ) / (count + K).
 */
export function lift(avg: number, count: number, mean: number, k = LIFT_K): number {
  return (count * (avg - mean)) / (count + k);
}

export interface MemberTag {
  avg: number;
  count: number;
  lift: number;
}

/** A TagRow from overlap.ts with each member's lift alongside their average. */
export interface LiftRow {
  tag: string;
  totalRankings: number;
  perMember: Map<string, MemberTag>;
}

export function withLift(rows: TagRow[], baselines: Map<string, Baseline>, k = LIFT_K): LiftRow[] {
  return rows.map((row) => {
    const perMember = new Map<string, MemberTag>();
    for (const [m, { avg, count }] of row.perMember) {
      const mean = baselines.get(m)?.mean ?? 0;
      perMember.set(m, { avg, count, lift: lift(avg, count, mean, k) });
    }
    return { tag: row.tag, totalRankings: row.totalRankings, perMember };
  });
}

/** Gap between the keenest and the least keen member (by lift); null with fewer than 2 people. */
export function divide(row: LiftRow): number | null {
  const lifts = [...row.perMember.values()].map((v) => v.lift);
  if (lifts.length < 2) return null;
  return Math.max(...lifts) - Math.min(...lifts);
}

/** What tells people apart first; tags only one person has ranked go last, most common first. */
export function sortByDivide(rows: LiftRow[]): LiftRow[] {
  return [...rows].sort((a, b) => {
    const da = divide(a);
    const db = divide(b);
    if (da !== null && db !== null) return db - da || b.totalRankings - a.totalRankings || a.tag.localeCompare(b.tag);
    if (da !== null) return -1;
    if (db !== null) return 1;
    return b.totalRankings - a.totalRankings || a.tag.localeCompare(b.tag);
  });
}

export function sortByCommon(rows: LiftRow[]): LiftRow[] {
  return [...rows].sort((a, b) => b.totalRankings - a.totalRankings || a.tag.localeCompare(b.tag));
}

/**
 * One-line readings of a tag table, strongest first, using lift (relative to each person's own
 * average) so a generous ranker doesn't "like" everything. A line needs 2+ people and 3+ rankings.
 */
export function tagInsights(rows: LiftRow[], nameOf: (id: string) => string, limit = 6): string[] {
  const found: Array<{ text: string; strength: number }> = [];
  for (const row of rows) {
    const entries = [...row.perMember.entries()];
    if (entries.length < 2 || row.totalRankings < 3) continue;
    const up = entries.filter(([, v]) => v.lift >= PULL);
    const down = entries.filter(([, v]) => v.lift <= -PULL);
    const names = (list: typeof entries) => list.map(([id]) => nameOf(id)).join(', ');
    const strength = divide(row) ?? 0;
    const meanLift = entries.reduce((s, [, v]) => s + Math.abs(v.lift), 0) / entries.length;
    let text: string | null = null;
    if (up.length === entries.length) text = `Everyone ranks ${row.tag} above their usual`;
    else if (down.length === entries.length) text = `Everyone ranks ${row.tag} below their usual`;
    // Two people pulling opposite ways: "Only Ana is into oud" would hide that Ken dislikes it.
    else if (entries.length === 2 && up.length === 1 && down.length === 1) text = `${row.tag} divides you: ${names(up)} ▲ · ${names(down)} ▼`;
    else if (up.length === 1 && down.length === entries.length - 1) text = `Only ${names(up)} is into ${row.tag}`;
    else if (down.length === 1 && up.length === entries.length - 1) text = `Everyone but ${names(down)} is into ${row.tag}`;
    else if (up.length > 0 && down.length > 0) text = `${row.tag} divides you: ${names(up)} ▲ · ${names(down)} ▼`;
    if (text) found.push({ text, strength: Math.max(strength, meanLift) });
  }
  return found
    .sort((a, b) => b.strength - a.strength)
    .slice(0, limit)
    .map((f) => f.text);
}

// ---------------------------------------------------------------------------
// "Your nose": one person's pulls, dislikes, streaks and strictness.
// ---------------------------------------------------------------------------

export interface TasteFragrance {
  id: string;
  house: string;
  notes: string[];
  accords?: string[];
  perfumers?: string[];
}

export type NoseKind = 'accord' | 'note' | 'perfumer' | 'house';

export interface NoseItem extends MemberTag {
  kind: NoseKind;
  /** As shown: lower-case for notes and accords, the original spelling for perfumers and houses. */
  label: string;
}

export interface Strictness {
  /** This person's average on the ±2 scale. */
  mean: number;
  /** Average of everyone's averages (people with MIN_RANKED+); null if this person is the only one. */
  roomMean: number | null;
  verdict: 'generous' | 'tough' | 'typical' | null;
}

export interface Nose {
  ranked: number;
  /** False below MIN_RANKED: show an empty state, not numbers. */
  enough: boolean;
  /** Ranked bottles that carry any note or accord. */
  tagged: number;
  pulls: NoseItem[];
  dislikes: NoseItem[];
  streaks: NoseItem[];
  strictness: Strictness | null;
}

/** Perfumer and house names keep their spelling; the key folds case and spaces. */
function displayNames(values: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const v of values) {
    const key = normalizeNote(v);
    if (key && !out.has(key)) out.set(key, v.trim());
  }
  return out;
}

function memberItems(
  rows: TagRow[],
  memberId: string,
  baseline: Baseline,
  kind: NoseKind,
  label: (tag: string) => string = (t) => t,
): NoseItem[] {
  const out: NoseItem[] = [];
  for (const row of rows) {
    const v = row.perMember.get(memberId);
    if (!v) continue;
    out.push({ kind, label: label(row.tag), avg: v.avg, count: v.count, lift: lift(v.avg, v.count, baseline.mean) });
  }
  return out;
}

export function nose(memberId: string, fragrances: TasteFragrance[], idx: RankIndex, limit = 5): Nose {
  const baselines = memberBaselines(idx);
  const mine = baselines.get(memberId);
  const ranked = mine?.count ?? 0;
  const empty: Nose = { ranked, enough: false, tagged: 0, pulls: [], dislikes: [], streaks: [], strictness: null };
  if (!mine || ranked < MIN_RANKED) return empty;

  // Only this member's rankings matter for their own profile.
  const just: RankIndex = new Map([[memberId, idx.get(memberId)!]]);
  const rankedIds = new Set(idx.get(memberId)!.keys());
  const tagged = fragrances.filter(
    (f) => rankedIds.has(f.id) && ((f.accords?.length ?? 0) > 0 || f.notes.length > 0),
  ).length;

  const accords = memberItems(tagOverlap(fragrances, just, (f) => f.accords ?? []), memberId, mine, 'accord');
  const notes = memberItems(tagOverlap(fragrances, just, (f) => f.notes), memberId, mine, 'note');

  // A word can be both an accord and a note (vanilla); keep whichever says more.
  const byLabel = new Map<string, NoseItem>();
  for (const item of [...accords, ...notes]) {
    if (item.count < MIN_TAG) continue;
    const seen = byLabel.get(item.label);
    if (!seen || Math.abs(item.lift) > Math.abs(seen.lift)) byLabel.set(item.label, item);
  }
  const tags = [...byLabel.values()];
  const pulls = tags.filter((t) => t.lift >= PULL).sort((a, b) => b.lift - a.lift || b.count - a.count).slice(0, limit);
  const dislikes = tags.filter((t) => t.lift <= -PULL).sort((a, b) => a.lift - b.lift || b.count - a.count).slice(0, limit);

  const perfumerNames = displayNames(fragrances.flatMap((f) => f.perfumers ?? []));
  const houseNames = displayNames(fragrances.map((f) => canonicalHouse(f.house)));
  const streaks = [
    ...memberItems(tagOverlap(fragrances, just, (f) => f.perfumers ?? []), memberId, mine, 'perfumer', (t) => perfumerNames.get(t) ?? t),
    ...memberItems(tagOverlap(fragrances, just, (f) => [canonicalHouse(f.house)]), memberId, mine, 'house', (t) => houseNames.get(t) ?? t),
  ]
    .filter((s) => s.count >= MIN_STREAK && s.lift >= PULL)
    .sort((a, b) => b.lift - a.lift || b.count - a.count)
    .slice(0, 3);

  return { ranked, enough: true, tagged, pulls, dislikes, streaks, strictness: strictness(memberId, baselines) };
}

/** How generously someone ranks, against the room. Null below MIN_RANKED. */
export function strictness(memberId: string, baselines: Map<string, Baseline>): Strictness | null {
  const mine = baselines.get(memberId);
  if (!mine || mine.count < MIN_RANKED) return null;
  const others = [...baselines.entries()].filter(([id, b]) => id !== memberId && b.count >= MIN_RANKED);
  if (others.length === 0) return { mean: mine.mean, roomMean: null, verdict: null };
  const all = [mine.mean, ...others.map(([, b]) => b.mean)];
  const roomMean = all.reduce((s, v) => s + v, 0) / all.length;
  const gap = mine.mean - roomMean;
  const verdict = gap >= STRICT_GAP ? 'generous' : gap <= -STRICT_GAP ? 'tough' : 'typical';
  return { mean: mine.mean, roomMean, verdict };
}

// ---------------------------------------------------------------------------
// "You vs a friend": every shared bottle on a 5×5 grid of your tier against theirs.
// ---------------------------------------------------------------------------

/** Tiers apart before a bottle counts as a split worth naming. */
export const SPLIT_GAP = 2;

/** Tiers from D to S: the order of both axes, low to high. */
export const AXIS: Tier[] = [...TIERS].reverse();

export interface VersusCell {
  mine: Tier;
  theirs: Tier;
  /** Shared bottles that land here, in name order. */
  ids: string[];
}

export interface VersusSplit {
  fragrance_id: string;
  mine: Tier;
  theirs: Tier;
  /** Tiers apart, 2–4. */
  gap: number;
}

export interface Versus {
  common: number;
  /** As drawn: rows top to bottom are their S → D, columns left to right are my D → S. */
  rows: VersusCell[][];
  /** Largest cell count, for scaling marks. */
  max: number;
  /** Bottles on the diagonal. */
  same: number;
  /** Bottles at most one tier apart (includes the diagonal). */
  within1: number;
  /** The widest gap (SPLIT_GAP+), ties by name; null when nothing is that far apart. */
  split: VersusSplit | null;
}

export function versus(
  meId: string,
  otherId: string,
  idx: RankIndex,
  nameOf: (fragranceId: string) => string = (id) => id,
): Versus {
  const mine = idx.get(meId) ?? new Map<string, number>();
  const theirs = idx.get(otherId) ?? new Map<string, number>();
  const rows: VersusCell[][] = TIERS.map((t) => AXIS.map((m) => ({ mine: m, theirs: t, ids: [] as string[] })));
  let common = 0;
  let same = 0;
  let within1 = 0;
  let split: VersusSplit | null = null;
  const byName = (a: string, b: string) => nameOf(a).localeCompare(nameOf(b)) || a.localeCompare(b);

  for (const [fid, a] of mine) {
    const b = theirs.get(fid);
    if (b === undefined) continue; // B is 0, so test for missing, not falsy
    common++;
    const m = tierForValue(a);
    const t = tierForValue(b);
    rows[TIERS.indexOf(t)][AXIS.indexOf(m)].ids.push(fid);
    const gap = Math.abs(a - b);
    if (gap === 0) same++;
    if (gap <= 1) within1++;
    if (gap >= SPLIT_GAP && (!split || gap > split.gap || (gap === split.gap && byName(fid, split.fragrance_id) < 0))) {
      split = { fragrance_id: fid, mine: m, theirs: t, gap };
    }
  }
  let max = 0;
  for (const row of rows) {
    for (const cell of row) {
      cell.ids.sort(byName);
      max = Math.max(max, cell.ids.length);
    }
  }
  return { common, rows, max, same, within1, split };
}

/** "Same tier on 9 of 15 · within one tier on 13 · biggest split: Aventus (you S, Ken D)". */
export function versusSummary(v: Versus, friend: string, nameOf: (fragranceId: string) => string): string {
  if (v.common === 0) return `You and ${friend} haven’t ranked any of the same bottles yet`;
  const parts = [`Same tier on ${v.same} of ${v.common}`, `within one tier on ${v.within1}`];
  parts.push(
    v.split
      ? `biggest split: ${nameOf(v.split.fragrance_id)} (you ${v.split.mine}, ${friend} ${v.split.theirs})`
      : `no splits of ${SPLIT_GAP}+ tiers`,
  );
  return parts.join(' · ');
}

/** Who to compare with first: the closest match by shrunk score, else the first other member. */
export function defaultFriend(meId: string, memberIds: string[], pairs: PairMatch[]): string | null {
  const best = pairs.find((p) => (p.a === meId || p.b === meId) && p.score !== null);
  if (best) return best.a === meId ? best.b : best.a;
  return memberIds.find((id) => id !== meId) ?? null;
}
