// Pure taste-overlap math. No React, no Supabase — just data in, numbers out.

export type Tier = 'S' | 'A' | 'B' | 'C' | 'D';
export const TIERS: Tier[] = ['S', 'A', 'B', 'C', 'D'];
export const TIER_VALUE: Record<Tier, number> = { S: 5, A: 4, B: 3, C: 2, D: 1 };

export interface RankingLike {
  member_id: string;
  fragrance_id: string;
  tier: Tier;
}
export interface FragranceLike {
  id: string;
  notes: string[];
}

/** member_id -> fragrance_id -> tier value (1..5) */
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

export interface PairMatch extends Match {
  a: string;
  b: string;
}

/** Every unordered pair of members, best match first; pairs without enough data last. */
export function allPairs(memberIds: string[], idx: RankIndex): PairMatch[] {
  const out: PairMatch[] = [];
  for (let i = 0; i < memberIds.length; i++) {
    for (let j = i + 1; j < memberIds.length; j++) {
      const a = memberIds[i];
      const b = memberIds[j];
      out.push({ a, b, ...tasteMatch(idx.get(a), idx.get(b)) });
    }
  }
  return out.sort((x, y) => (y.score ?? -1) - (x.score ?? -1) || y.common - x.common);
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
  /** Closest match, or null if nobody shares 2+ rankings with this member. */
  match: (Match & { member_id: string }) | null;
  /** Fragrance ids the member hasn't ranked that their closest match rated S or A, best first. */
  fragranceIds: string[];
}

export function tryNext(memberId: string, memberIds: string[], idx: RankIndex): TryNext {
  const mine = idx.get(memberId);
  let best: (Match & { member_id: string }) | null = null;
  for (const other of memberIds) {
    if (other === memberId) continue;
    const m = tasteMatch(mine, idx.get(other));
    if (m.score === null) continue;
    if (!best || m.score > best.score! || (m.score === best.score && m.common > best.common)) {
      best = { ...m, member_id: other };
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

export interface NoteRow {
  note: string;
  /** member_id -> { avg tier value, how many of that note they ranked } */
  perMember: Map<string, { avg: number; count: number }>;
  totalRankings: number;
}

export function normalizeNote(note: string): string {
  return note.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** For each note tag, each member's average tier over fragrances carrying that note. */
export function noteOverlap(fragrances: FragranceLike[], idx: RankIndex): NoteRow[] {
  const notesByFragrance = new Map<string, string[]>();
  for (const f of fragrances) {
    notesByFragrance.set(f.id, [...new Set(f.notes.map(normalizeNote).filter(Boolean))]);
  }
  const sums = new Map<string, Map<string, { sum: number; count: number }>>();
  for (const [memberId, ranks] of idx) {
    for (const [fid, v] of ranks) {
      for (const note of notesByFragrance.get(fid) ?? []) {
        let byMember = sums.get(note);
        if (!byMember) sums.set(note, (byMember = new Map()));
        const cur = byMember.get(memberId) ?? { sum: 0, count: 0 };
        byMember.set(memberId, { sum: cur.sum + v, count: cur.count + 1 });
      }
    }
  }
  const rows: NoteRow[] = [];
  for (const [note, byMember] of sums) {
    const perMember = new Map<string, { avg: number; count: number }>();
    let totalRankings = 0;
    for (const [mid, { sum, count }] of byMember) {
      perMember.set(mid, { avg: sum / count, count });
      totalRankings += count;
    }
    rows.push({ note, perMember, totalRankings });
  }
  return rows.sort((a, b) => b.totalRankings - a.totalRankings || a.note.localeCompare(b.note));
}

/** Fragrances with at least one ranking, highest average first. */
export function sortedByAverage(idx: RankIndex): FragranceStats[] {
  return [...fragranceStats(idx).values()].sort((a, b) => b.avg - a.avg || b.count - a.count);
}

/** Nearest tier letter for an average value (used for coloring averages). */
export function tierForValue(v: number): Tier {
  const r = Math.min(5, Math.max(1, Math.round(v)));
  return TIERS[5 - r];
}
