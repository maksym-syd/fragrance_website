import { describe, expect, it } from 'vitest';
import { allPairs, indexRankings, tagOverlap, tryNext, type RankingLike, type Tier } from './overlap';
import {
  confidence,
  divide,
  lift,
  memberBaselines,
  nose,
  shrinkMatch,
  sortByCommon,
  sortByDivide,
  strictness,
  tagInsights,
  withLift,
  type TasteFragrance,
} from './taste';

/** Build rankings from { member: { fragrance: tier } }. */
function r(spec: Record<string, Record<string, Tier>>): RankingLike[] {
  return Object.entries(spec).flatMap(([member_id, ranks]) =>
    Object.entries(ranks).map(([fragrance_id, tier]) => ({ member_id, fragrance_id, tier })),
  );
}

const frag = (id: string, f: Partial<TasteFragrance> = {}): TasteFragrance => ({ id, house: 'House', notes: [], ...f });

/**
 * Mia from taste.md §2: ten bottles averaging +0.4 on the ±2 scale.
 * Vanilla in three (S, S, A), oud in one (S), iris in two (C, B), four untagged (B, B, C, C).
 */
const MIA_FRAGS = [
  frag('v1', { notes: ['vanilla'] }),
  frag('v2', { notes: ['vanilla'] }),
  frag('v3', { notes: ['vanilla'] }),
  frag('o1', { notes: ['oud'] }),
  frag('i1', { notes: ['iris'] }),
  frag('i2', { notes: ['iris'] }),
  frag('x1'),
  frag('x2'),
  frag('x3'),
  frag('x4'),
];
const MIA = r({ mia: { v1: 'S', v2: 'S', v3: 'A', o1: 'S', i1: 'C', i2: 'B', x1: 'B', x2: 'B', x3: 'C', x4: 'C' } });

describe('memberBaselines', () => {
  it("is each person's mean on the ±2 scale", () => {
    const b = memberBaselines(indexRankings(MIA));
    expect(b.get('mia')!.count).toBe(10);
    expect(b.get('mia')!.mean).toBeCloseTo(0.4);
  });

  it('skips people with nothing ranked', () => {
    expect(memberBaselines(new Map([['nobody', new Map()]])).size).toBe(0);
  });
});

describe('lift (taste.md §2 worked example)', () => {
  const idx = indexRankings(MIA);
  const rows = withLift(tagOverlap(MIA_FRAGS, idx, (f) => f.notes), memberBaselines(idx));
  const liftOf = (tag: string) => rows.find((x) => x.tag === tag)!.perMember.get('mia')!.lift;

  it('vanilla S, S, A → +0.76', () => expect(liftOf('vanilla')).toBeCloseTo(0.76));
  it('a single S oud → +0.53, below the vanilla pattern', () => expect(liftOf('oud')).toBeCloseTo(0.533, 3));
  it('iris C, B → −0.45', () => expect(liftOf('iris')).toBeCloseTo(-0.45));

  it('a tag that tracks your average lifts by 0, however common', () => {
    expect(lift(0.4, 50, 0.4)).toBe(0);
  });

  it('shrinks harder with less evidence', () => {
    expect(lift(2, 1, 0)).toBeCloseTo(2 / 3);
    expect(lift(2, 10, 0)).toBeCloseTo(20 / 12);
  });
});

describe('shrinkMatch / confidence (taste.md §4a table, prior 60)', () => {
  it('matches the worked numbers', () => {
    expect(shrinkMatch(100, 2)).toBeCloseTo(76);
    expect(shrinkMatch(100, 5)).toBeCloseTo(85);
    expect(shrinkMatch(88, 15)).toBeCloseTo(83.33, 2);
  });

  it('labels how much a match rests on', () => {
    expect([2, 4, 5, 9, 10, 30].map(confidence)).toEqual(['rough', 'rough', 'fair', 'fair', 'solid', 'solid']);
  });

  /** me shares 2 bottles with twin (identical), and 15 with friend at 88% (7 tiers of difference). */
  function room() {
    const me: Record<string, Tier> = { t1: 'S', t2: 'A' };
    const friend: Record<string, Tier> = {};
    for (let i = 0; i < 15; i++) {
      me[`f${i}`] = 'A';
      friend[`f${i}`] = i < 7 ? 'B' : 'A';
    }
    return indexRankings(r({ me, twin: { t1: 'S', t2: 'A' }, friend }));
  }

  it('15 shared at 88% outranks 2 shared at 100% in allPairs', () => {
    const mine = allPairs(['me', 'twin', 'friend'], room()).filter((p) => p.a === 'me' || p.b === 'me');
    expect(mine.map((p) => [p.a === 'me' ? p.b : p.a, p.score, p.common])).toEqual([
      ['friend', 88, 15],
      ['twin', 100, 2],
    ]);
  });

  it('…and is the one Try next draws from', () => {
    expect(tryNext('me', ['me', 'twin', 'friend'], room()).match).toMatchObject({ member_id: 'friend', score: 88, common: 15 });
  });

  it('with equal evidence, the higher score still wins', () => {
    const idx = indexRankings(r({ me: { x: 'S', y: 'A' }, a: { x: 'S', y: 'A' }, b: { x: 'A', y: 'B' } }));
    expect(tryNext('me', ['me', 'a', 'b'], idx).match?.member_id).toBe('a');
  });
});

describe('strictness', () => {
  const five = (t: Tier): Record<string, Tier> => Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((k) => [k, t]));

  it('compares your average with the room', () => {
    const b = memberBaselines(indexRankings(r({ ana: five('A'), ken: five('C'), mia: five('B') })));
    expect(strictness('ana', b)).toEqual({ mean: 1, roomMean: 0, verdict: 'generous' });
    expect(strictness('ken', b)).toEqual({ mean: -1, roomMean: 0, verdict: 'tough' });
    expect(strictness('mia', b)).toEqual({ mean: 0, roomMean: 0, verdict: 'typical' });
  });

  it('says nothing below 5 ranked, and gives no verdict with nobody to compare', () => {
    const b = memberBaselines(indexRankings(r({ ana: { x: 'S', y: 'S' }, ken: five('C') })));
    expect(strictness('ana', b)).toBeNull();
    expect(strictness('ken', b)).toEqual({ mean: -1, roomMean: null, verdict: null });
  });
});

describe('nose', () => {
  it('hides everything below 5 ranked', () => {
    const n = nose('mia', MIA_FRAGS, indexRankings(r({ mia: { v1: 'S', v2: 'S' } })));
    expect(n).toMatchObject({ ranked: 2, enough: false, pulls: [], dislikes: [], streaks: [], strictness: null });
  });

  it('keeps vanilla, drops a one-bottle oud and a weak iris', () => {
    const n = nose('mia', MIA_FRAGS, indexRankings(MIA));
    expect(n.enough).toBe(true);
    expect(n.tagged).toBe(6);
    expect(n.pulls.map((p) => [p.kind, p.label])).toEqual([['note', 'vanilla']]);
    expect(n.pulls[0].lift).toBeCloseTo(0.76);
    expect(n.dislikes).toEqual([]);
  });

  it('reads accords and notes, keeping the stronger of a word that is both', () => {
    // Mean +1/6. Amber (S, S) lifts 0.92, the vanilla note (S, S, A) 0.90; the vanilla accord has
    // one bottle, so it never competes. Aquatic (D, D) lifts −1.08.
    const frags = [
      frag('a', { accords: ['Amber'], notes: ['vanilla'] }),
      frag('b', { accords: ['amber', 'vanilla'], notes: ['vanilla'] }),
      frag('c', { accords: ['aquatic'] }),
      frag('d', { accords: ['aquatic'] }),
      frag('e', { notes: ['Vanilla'] }),
      frag('f'),
    ];
    const idx = indexRankings(r({ me: { a: 'S', b: 'S', c: 'D', d: 'D', e: 'A', f: 'B' } }));
    const n = nose('me', frags, idx);
    expect(n.pulls.map((p) => `${p.kind}:${p.label}`)).toEqual(['accord:amber', 'note:vanilla']);
    expect(n.dislikes.map((p) => `${p.kind}:${p.label}`)).toEqual(['accord:aquatic']);
  });

  it('finds perfumer and house streaks only with 3+ bottles, keeping their spelling', () => {
    const fk = { perfumers: ['Francis Kurkdjian'] };
    const frags = [
      frag('a', { ...fk, house: 'MFK' }),
      frag('b', { ...fk, house: 'MFK' }),
      frag('c', { ...fk, house: 'MFK' }),
      frag('d', { perfumers: ['Alberto Morillas'], house: 'Other' }),
      frag('e', { perfumers: ['Alberto Morillas'], house: 'Other' }),
      frag('f', { house: 'Other' }),
    ];
    // Mean +1/6: Kurkdjian/MFK (S, S, A) lift 0.9; Morillas has only 2 bottles, so it can't be a streak.
    const idx = indexRankings(r({ me: { a: 'S', b: 'S', c: 'A', d: 'C', e: 'C', f: 'D' } }));
    const n = nose('me', frags, idx);
    expect(n.streaks.map((s) => `${s.kind}:${s.label}:${s.count}`)).toEqual(['perfumer:Francis Kurkdjian:3', 'house:MFK:3']);
  });

  it('a bottle with nothing tagged counts toward the average but not `tagged`', () => {
    const idx = indexRankings(r({ me: { a: 'S', b: 'B', c: 'B', d: 'B', e: 'D' } }));
    const n = nose('me', ['a', 'b', 'c', 'd', 'e'].map((id) => frag(id)), idx);
    expect(n).toMatchObject({ enough: true, tagged: 0, pulls: [], dislikes: [] });
  });
});

describe('tables: divide, sorting, insights', () => {
  // Ana is neutral overall but loves oud; Ken is neutral overall but hates it. Everyone likes vanilla.
  const frags = [
    frag('o1', { notes: ['oud'] }),
    frag('o2', { notes: ['oud'] }),
    frag('v1', { notes: ['vanilla', 'musk'] }),
    frag('v2', { notes: ['vanilla', 'musk'] }),
    frag('m1', { notes: ['musk'] }),
    frag('m2', { notes: ['musk'] }),
    frag('m3', { notes: ['musk'] }),
    frag('m4', { notes: ['musk'] }),
    frag('s1', { notes: ['solo'] }),
  ];
  const idx = indexRankings(r({
    ana: { o1: 'S', o2: 'S', v1: 'S', v2: 'S', m1: 'D', m2: 'D', m3: 'D', m4: 'D', s1: 'B' },
    ken: { o1: 'D', o2: 'D', v1: 'S', v2: 'S', m1: 'B', m2: 'B', m3: 'B', m4: 'B' },
  }));
  const rows = withLift(tagOverlap(frags, idx, (f) => f.notes), memberBaselines(idx));
  const names: Record<string, string> = { ana: 'Ana', ken: 'Ken' };

  it('divide is the gap between keenest and least keen; null for one person', () => {
    expect(divide(rows.find((x) => x.tag === 'oud')!)).toBeGreaterThan(1.5);
    expect(divide(rows.find((x) => x.tag === 'solo')!)).toBeNull();
  });

  it('sorts by what tells people apart, not by how common a tag is', () => {
    expect(sortByCommon(rows).map((x) => x.tag)).toEqual(['musk', 'oud', 'vanilla', 'solo']);
    expect(sortByDivide(rows).map((x) => x.tag)[0]).toBe('oud');
    expect(sortByDivide(rows).at(-1)!.tag).toBe('solo');
  });

  it('reads the table relative to each person, strongest first', () => {
    const lines = tagInsights(rows, (id) => names[id]);
    expect(lines[0]).toBe('oud divides you: Ana ▲ · Ken ▼');
    expect(lines).toContain('Everyone ranks vanilla above their usual');
  });

  it("a generous ranker doesn't 'like' everything", () => {
    // Both rate everything S or A: raw averages all look like love, but no tag stands out.
    const flat = indexRankings(r({ ana: { o1: 'S', o2: 'S', v1: 'S', v2: 'S' }, ken: { o1: 'A', o2: 'A', v1: 'A', v2: 'A' } }));
    const flatRows = withLift(tagOverlap(frags, flat, (f) => f.notes), memberBaselines(flat));
    expect(tagInsights(flatRows, (id) => names[id])).toEqual([]);
  });
});
