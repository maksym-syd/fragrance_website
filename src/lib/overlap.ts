// Pure taste-overlap math. No React, no Supabase — just data in, numbers out.

export type Tier = 'S' | 'A' | 'B' | 'C' | 'D';
export const TIERS: Tier[] = ['S', 'A', 'B', 'C', 'D'];
/** Centred on B, so a sign reads as a verdict: + liked, 0 fine, − disliked. The range is 4 either way. */
export const TIER_VALUE: Record<Tier, number> = { S: 2, A: 1, B: 0, C: -1, D: -2 };

/** The scale in words, for legends next to averages. */
export const SCALE_LEGEND = 'S +2 · A +1 · B 0 · C −1 · D −2';

/** "+0.8", "−1.2", "0": one decimal, a real minus sign, and no sign on zero. */
export function formatScore(v: number): string {
  const r = Math.round(v * 10) / 10;
  if (r === 0) return '0';
  const s = Math.abs(r).toFixed(1).replace(/\.0$/, '');
  return r > 0 ? `+${s}` : `−${s}`;
}

export interface RankingLike {
  member_id: string;
  fragrance_id: string;
  tier: Tier;
}
export interface FragranceLike {
  id: string;
  notes: string[];
}

/** member_id -> fragrance_id -> tier value (−2..+2). B is 0, so check `=== undefined`, not truthiness. */
export type RankIndex = Map<string, Map<string, number>>;

export const MIN_COMMON = 2;

export function indexRankings(rankings: RankingLike[]): RankIndex {
  const idx: RankIndex = new Map();
  for (const r of rankings) {
    let m = idx.get(r.member_id);
    if (!m) idx.set(r.member_id, (m = new Map()));
    m.set(r.fragrance_id, TIER_VALUE[r.tier]);
  }
  return idx;
}

export interface Match {
  /** Number of fragrances both ranked. */
  common: number;
  /** 0–100, or null when fewer than MIN_COMMON in common. */
  score: number | null;
}

/** score = 100 − mean(|diff|) / 4 × 100, over fragrances both members ranked. */
export function tasteMatch(a: Map<string, number> | undefined, b: Map<string, number> | undefined): Match {
  if (!a || !b) return { common: 0, score: null };
  let common = 0;
  let totalDiff = 0;
  for (const [id, va] of a) {
    const vb = b.get(id);
    if (vb === undefined) continue;
    common++;
    totalDiff += Math.abs(va - vb);
  }
  if (common < MIN_COMMON) return { common, score: null };
  return { common, score: Math.round(100 - (totalDiff / common / 4) * 100) };
}

// ---------------------------------------------------------------------------
// How sure is a match? Two shared bottles at 100% shouldn't beat fifteen at 88%.
// ---------------------------------------------------------------------------

/** Expected match for two people ranking at random: E|a−b| = 1.6 tiers → 100 − 1.6/4×100. */
export const CHANCE_MATCH = 60;
/** Shared bottles' worth of weight given to the prior. */
export const MATCH_K = 3;

export type Confidence = 'rough' | 'fair' | 'solid';

/** Under 5 shared is rough, under 10 fair, 10+ solid. */
export function confidence(common: number): Confidence {
  return common < 5 ? 'rough' : common < 10 ? 'fair' : 'solid';
}

/**
 * Pull a raw score towards chance in proportion to how little it rests on: (n·raw + K·60)/(n + K).
 * The prior is fixed at chance rather than the room's own average on purpose: in a room where
 * everyone agrees, a room prior would let 2 lucky bottles beat 15 solid ones again.
 */
export function shrinkMatch(score: number, common: number, prior = CHANCE_MATCH, k = MATCH_K): number {
  return (common * score + k * prior) / (common + k);
}

export interface PairMatch extends Match {
  a: string;
  b: string;
  /** The score used for ordering: `score` shrunk towards chance (see shrinkMatch). Null when `score` is. */
  shrunk: number | null;
}

/** Every unordered pair of members, most trustworthy best match first; pairs without enough data last. */
export function allPairs(memberIds: string[], idx: RankIndex): PairMatch[] {
  const out: PairMatch[] = [];
  for (let i = 0; i < memberIds.length; i++) {
    for (let j = i + 1; j < memberIds.length; j++) {
      const a = memberIds[i];
      const b = memberIds[j];
      const m = tasteMatch(idx.get(a), idx.get(b));
      out.push({ a, b, ...m, shrunk: m.score === null ? null : shrinkMatch(m.score, m.common) });
    }
  }
  return out.sort((x, y) => (y.shrunk ?? -1) - (x.shrunk ?? -1) || y.common - x.common);
}

/** Symmetric matrix keyed [rowMember][colMember]. Diagonal is the member against themselves. */
export function similarityMatrix(memberIds: string[], idx: RankIndex): Match[][] {
  return memberIds.map((a) => memberIds.map((b) => tasteMatch(idx.get(a), idx.get(b))));
}

export interface FragranceStats {
  fragrance_id: string;
  count: number;
  avg: number;
  min: number;
  max: number;
  spread: number;
}

export function fragranceStats(idx: RankIndex): Map<string, FragranceStats> {
  const acc = new Map<string, number[]>();
  for (const ranks of idx.values()) {
    for (const [fid, v] of ranks) {
      const list = acc.get(fid);
      if (list) list.push(v);
      else acc.set(fid, [v]);
    }
  }
  const out = new Map<string, FragranceStats>();
  for (const [fid, vals] of acc) {
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    out.set(fid, {
      fragrance_id: fid,
      count: vals.length,
      avg: vals.reduce((s, v) => s + v, 0) / vals.length,
      min,
      max,
      spread: max - min,
    });
  }
  return out;
}

/** Ranked by 2+ people and every one of them gave A or better. Best first. */
export function everyoneLoves(idx: RankIndex): FragranceStats[] {
  return [...fragranceStats(idx).values()]
    .filter((s) => s.count >= 2 && s.min >= TIER_VALUE.A)
    .sort((a, b) => b.avg - a.avg || b.count - a.count);
}

/** max − min ≥ 3 (e.g. S vs C or worse). Most divisive first. */
export function mostDivisive(idx: RankIndex): FragranceStats[] {
  return [...fragranceStats(idx).values()]
    .filter((s) => s.count >= 2 && s.spread >= 3)
    .sort((a, b) => b.spread - a.spread || b.count - a.count);
}

export interface TryNext {
  /** Closest match by shrunk score, or null if nobody shares 2+ rankings with this member. */
  match: (Match & { member_id: string; shrunk: number }) | null;
  /** Fragrance ids the member hasn't ranked that their closest match rated S or A, best first. */
  fragranceIds: string[];
}

export function tryNext(memberId: string, memberIds: string[], idx: RankIndex): TryNext {
  const mine = idx.get(memberId);
  let best: (Match & { member_id: string; shrunk: number }) | null = null;
  for (const other of memberIds) {
    if (other === memberId) continue;
    const m = tasteMatch(mine, idx.get(other));
    if (m.score === null) continue;
    const shrunk = shrinkMatch(m.score, m.common);
    if (!best || shrunk > best.shrunk || (shrunk === best.shrunk && m.common > best.common)) {
      best = { ...m, member_id: other, shrunk };
    }
  }
  if (!best) return { match: null, fragranceIds: [] };
  const theirs = idx.get(best.member_id)!;
  const fragranceIds = [...theirs]
    .filter(([fid, v]) => v >= TIER_VALUE.A && !mine?.has(fid))
    .sort((a, b) => b[1] - a[1])
    .map(([fid]) => fid);
  return { match: best, fragranceIds };
}

export interface TagRow {
  tag: string;
  /** member_id -> { avg tier value, how many fragrances with that tag they ranked } */
  perMember: Map<string, { avg: number; count: number }>;
  totalRankings: number;
}

export interface NoteRow extends Omit<TagRow, 'tag'> {
  note: string;
}

export function normalizeNote(note: string): string {
  return note.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** For each tag, each member's average tier over fragrances carrying that tag. */
export function tagOverlap<F extends { id: string }>(fragrances: F[], idx: RankIndex, tagsOf: (f: F) => string[]): TagRow[] {
  const tagsByFragrance = new Map<string, string[]>();
  for (const f of fragrances) {
    tagsByFragrance.set(f.id, [...new Set(tagsOf(f).map(normalizeNote).filter(Boolean))]);
  }
  const sums = new Map<string, Map<string, { sum: number; count: number }>>();
  for (const [memberId, ranks] of idx) {
    for (const [fid, v] of ranks) {
      for (const tag of tagsByFragrance.get(fid) ?? []) {
        let byMember = sums.get(tag);
        if (!byMember) sums.set(tag, (byMember = new Map()));
        const cur = byMember.get(memberId) ?? { sum: 0, count: 0 };
        byMember.set(memberId, { sum: cur.sum + v, count: cur.count + 1 });
      }
    }
  }
  const rows: TagRow[] = [];
  for (const [tag, byMember] of sums) {
    const perMember = new Map<string, { avg: number; count: number }>();
    let totalRankings = 0;
    for (const [mid, { sum, count }] of byMember) {
      perMember.set(mid, { avg: sum / count, count });
      totalRankings += count;
    }
    rows.push({ tag, perMember, totalRankings });
  }
  return rows.sort((a, b) => b.totalRankings - a.totalRankings || a.tag.localeCompare(b.tag));
}

/** For each note tag, each member's average tier over fragrances carrying that note. */
export function noteOverlap(fragrances: FragranceLike[], idx: RankIndex): NoteRow[] {
  return tagOverlap(fragrances, idx, (f) => f.notes).map(({ tag, ...row }) => ({ note: tag, ...row }));
}

/** The same, per accord. Rows without accords (old fragrances) simply don't count. */
export function accordOverlap(fragrances: Array<{ id: string; accords?: string[] }>, idx: RankIndex): TagRow[] {
  return tagOverlap(fragrances, idx, (f) => f.accords ?? []);
}

/** Fragrances with at least one ranking, highest average first. */
export function sortedByAverage(idx: RankIndex): FragranceStats[] {
  return [...fragranceStats(idx).values()].sort((a, b) => b.avg - a.avg || b.count - a.count);
}

/** Nearest tier letter for an average value (used for coloring averages). */
export function tierForValue(v: number): Tier {
  const r = Math.min(2, Math.max(-2, Math.round(v)));
  return TIERS[2 - r];
}
