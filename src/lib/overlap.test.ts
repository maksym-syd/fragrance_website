import { describe, expect, it } from 'vitest';
import {
  allPairs,
  everyoneLoves,
  indexRankings,
  mostDivisive,
  noteOverlap,
  similarityMatrix,
  sortedByAverage,
  tasteMatch,
  formatScore,
  TIER_VALUE,
  tierForValue,
  tryNext,
  type RankingLike,
  type Tier,
} from './overlap';

/** Build rankings from { member: { fragrance: tier } }. */
function r(spec: Record<string, Record<string, Tier>>): RankingLike[] {
  return Object.entries(spec).flatMap(([member_id, ranks]) =>
    Object.entries(ranks).map(([fragrance_id, tier]) => ({ member_id, fragrance_id, tier })),
  );
}

describe('tasteMatch', () => {
  it('no overlap → null score, 0 in common', () => {
    const idx = indexRankings(r({ a: { x: 'S', y: 'A' }, b: { z: 'S' } }));
    expect(tasteMatch(idx.get('a'), idx.get('b'))).toEqual({ common: 0, score: null });
  });

  it('member with no rankings at all → null', () => {
    const idx = indexRankings(r({ a: { x: 'S' } }));
    expect(tasteMatch(idx.get('a'), idx.get('nobody'))).toEqual({ common: 0, score: null });
  });

  it('only one shared item → not enough data', () => {
    const idx = indexRankings(r({ a: { x: 'S', y: 'A' }, b: { x: 'S', z: 'D' } }));
    expect(tasteMatch(idx.get('a'), idx.get('b'))).toEqual({ common: 1, score: null });
  });

  it('identical lists → 100', () => {
    const lists = { x: 'S', y: 'B', z: 'D' } as const;
    const idx = indexRankings(r({ a: lists, b: lists }));
    expect(tasteMatch(idx.get('a'), idx.get('b'))).toEqual({ common: 3, score: 100 });
  });

  it('opposite lists (S vs D everywhere) → 0', () => {
    const idx = indexRankings(r({ a: { x: 'S', y: 'D' }, b: { x: 'D', y: 'S' } }));
    expect(tasteMatch(idx.get('a'), idx.get('b'))).toEqual({ common: 2, score: 0 });
  });

  it('mixed: diffs 1 and 2 → 100 − 1.5/4×100 = 62.5 → 63', () => {
    const idx = indexRankings(r({ a: { x: 'S', y: 'A' }, b: { x: 'A', y: 'C' } }));
    expect(tasteMatch(idx.get('a'), idx.get('b')).score).toBe(63);
  });

  it('is symmetric', () => {
    const idx = indexRankings(r({ a: { x: 'S', y: 'C', z: 'B' }, b: { x: 'B', y: 'C', z: 'D' } }));
    expect(tasteMatch(idx.get('a'), idx.get('b'))).toEqual(tasteMatch(idx.get('b'), idx.get('a')));
  });
});

describe('allPairs / similarityMatrix', () => {
  const idx = indexRankings(r({
    a: { x: 'S', y: 'A' },
    b: { x: 'S', y: 'A' },
    c: { x: 'D', y: 'D' },
    d: {},
  }));

  it('lists every unordered pair, best first, insufficient data last', () => {
    const pairs = allPairs(['a', 'b', 'c', 'd'], idx);
    expect(pairs).toHaveLength(6);
    expect(pairs[0]).toMatchObject({ a: 'a', b: 'b', score: 100 });
    expect(pairs.slice(-3).every((p) => p.score === null)).toBe(true);
  });

  it('builds a symmetric matrix', () => {
    const m = similarityMatrix(['a', 'b', 'c'], idx);
    expect(m[0][1]).toEqual(m[1][0]);
    expect(m[0][0].score).toBe(100);
    expect(m[0][2].score).toBe(Math.round(100 - (3.5 / 4) * 100));
  });

  it('handles zero and one members', () => {
    expect(allPairs([], idx)).toEqual([]);
    expect(allPairs(['a'], idx)).toEqual([]);
  });
});

describe('everyoneLoves', () => {
  it('needs 2+ rankers and all A or better', () => {
    const idx = indexRankings(r({
      a: { loved: 'S', solo: 'S', mixed: 'S' },
      b: { loved: 'A', mixed: 'B' },
    }));
    expect(everyoneLoves(idx).map((s) => s.fragrance_id)).toEqual(['loved']);
  });
});

describe('mostDivisive', () => {
  it('includes spread ≥ 3 only, biggest first', () => {
    const idx = indexRankings(r({
      a: { x: 'S', y: 'S', z: 'S' },
      b: { x: 'D', y: 'C', z: 'B' },
    }));
    expect(mostDivisive(idx).map((s) => [s.fragrance_id, s.spread])).toEqual([['x', 4], ['y', 3]]);
  });

  it('identical lists → nothing divisive', () => {
    const idx = indexRankings(r({ a: { x: 'S' }, b: { x: 'S' } }));
    expect(mostDivisive(idx)).toEqual([]);
  });
});

describe('tryNext', () => {
  it("suggests the closest match's S/A picks I haven't ranked", () => {
    const idx = indexRankings(r({
      me: { x: 'S', y: 'A' },
      twin: { x: 'S', y: 'A', p: 'A', q: 'S', w: 'C' },
      opposite: { x: 'D', y: 'D', z: 'S' },
    }));
    const res = tryNext('me', ['me', 'twin', 'opposite'], idx);
    expect(res.match?.member_id).toBe('twin');
    expect(res.fragranceIds).toEqual(['q', 'p']);
  });

  it('no match when nobody shares 2+', () => {
    const idx = indexRankings(r({ me: { x: 'S' }, other: { x: 'S', y: 'S' } }));
    expect(tryNext('me', ['me', 'other'], idx)).toEqual({ match: null, fragranceIds: [] });
  });

  it('only member in the room', () => {
    const idx = indexRankings(r({ me: { x: 'S' } }));
    expect(tryNext('me', ['me'], idx).match).toBeNull();
  });
});

describe('noteOverlap', () => {
  it('averages tier per member per note, normalizing tags', () => {
    const fragrances = [
      { id: 'f1', notes: ['Vanilla', 'oud'] },
      { id: 'f2', notes: [' vanilla '] },
      { id: 'f3', notes: [] },
    ];
    const idx = indexRankings(r({
      ana: { f1: 'S', f2: 'A', f3: 'D' },
      ken: { f1: 'D', f2: 'S' },
    }));
    const rows = noteOverlap(fragrances, idx);
    expect(rows.map((n) => n.note)).toEqual(['vanilla', 'oud']);
    const vanilla = rows[0];
    expect(vanilla.perMember.get('ana')).toEqual({ avg: 1.5, count: 2 });
    expect(vanilla.perMember.get('ken')).toEqual({ avg: 0, count: 2 });
    expect(rows[1].perMember.get('ken')).toEqual({ avg: -2, count: 1 });
  });

  it('nothing ranked → no rows', () => {
    expect(noteOverlap([{ id: 'f', notes: ['citrus'] }], indexRankings([]))).toEqual([]);
  });
});

describe('sortedByAverage / tierForValue', () => {
  it('orders by average desc', () => {
    const idx = indexRankings(r({ a: { x: 'C', y: 'S' }, b: { x: 'D', y: 'A' } }));
    expect(sortedByAverage(idx).map((s) => s.fragrance_id)).toEqual(['y', 'x']);
  });

  it('maps averages to nearest tier', () => {
    expect(tierForValue(2)).toBe('S');
    expect(tierForValue(1.4)).toBe('A');
    expect(tierForValue(0.4)).toBe('B');
    expect(tierForValue(0)).toBe('B');
    expect(tierForValue(-0.6)).toBe('C');
    expect(tierForValue(-2)).toBe('D');
    expect(tierForValue(9)).toBe('S');
    expect(tierForValue(-9)).toBe('D');
  });
});

describe('±2 scale', () => {
  it('centres on B with a range of 4', () => {
    expect(TIER_VALUE).toEqual({ S: 2, A: 1, B: 0, C: -1, D: -2 });
  });

  it('a B ranking (value 0) still counts as ranked everywhere', () => {
    const idx = indexRankings(r({ a: { x: 'B', y: 'B', z: 'S' }, b: { x: 'B', y: 'B' } }));
    expect(tasteMatch(idx.get('a'), idx.get('b'))).toEqual({ common: 2, score: 100 });
    expect(sortedByAverage(idx).find((s) => s.fragrance_id === 'x')).toMatchObject({ count: 2, avg: 0 });
    // b hasn't ranked z, which a rated S, and B-ranked x/y are not offered again.
    expect(tryNext('b', ['a', 'b'], idx).fragranceIds).toEqual(['z']);
  });

  it('formats scores with a sign, one decimal and no sign on zero', () => {
    expect(formatScore(0.8)).toBe('+0.8');
    expect(formatScore(-1.24)).toBe('−1.2');
    expect(formatScore(2)).toBe('+2');
    expect(formatScore(-1)).toBe('−1');
    expect(formatScore(0)).toBe('0');
    expect(formatScore(0.04)).toBe('0');
    expect(formatScore(-0.04)).toBe('0');
  });
});
