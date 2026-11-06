import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { RoomApi } from '../hooks/useRoom';
import {
  allPairs,
  everyoneLoves,
  indexRankings,
  MIN_COMMON,
  mostDivisive,
  noteOverlap,
  similarityMatrix,
  sortedByAverage,
  TIERS,
  tierForValue,
  tryNext,
  type FragranceStats,
  type NoteRow,
  type PairMatch,
} from '../lib/overlap';
import type { Fragrance, Member } from '../lib/types';
import { Empty, TierLetter } from './ui';

/** Jump links, most personal first. Each target id comes from its section's title (see SectionHead). */
const JUMPS = [
  ['taste-match', 'Matches'],
  ['try-next', 'Try next'],
  ['similarity-map', 'Map'],
  ['everyone-loves', 'Loved'],
  ['most-divisive', 'Divisive'],
  ['by-note', 'Notes'],
  ['side-by-side', 'All'],
];

/** Most scores land between 50 and 85, so bands show differences a straight % would hide.
    The gap between 52 and 88 is deliberate: mid tones can't hold 4.5:1 text in either colour. */
const HEAT_BANDS = [
  { from: 80, heat: 88, label: '80+' },
  { from: 70, heat: 52, label: '70s' },
  { from: 60, heat: 38, label: '60s' },
  { from: 50, heat: 24, label: '50s' },
  { from: 0, heat: 12, label: 'Under 50' },
];
const heatBand = (score: number) => HEAT_BANDS.find((b) => score >= b.from)!;

export default function Overlap({ api, onOpen }: { api: RoomApi; onOpen: (id: string) => void }) {
  const me = api.me!;
  // Me first, then everyone else in join order.
  const members = useMemo(() => [me, ...api.members.filter((m) => m.id !== me.id)], [api.members, me]);
  const memberIds = members.map((m) => m.id);
  const nameOf = (id: string) => api.members.find((m) => m.id === id)?.display_name ?? '—';
  const fragById = useMemo(() => new Map(api.fragrances.map((f) => [f.id, f])), [api.fragrances]);

  const a = useMemo(() => {
    const idx = indexRankings(api.rankings);
    const ids = memberIds;
    return {
      idx,
      pairs: allPairs(ids, idx),
      matrix: similarityMatrix(ids, idx),
      loves: everyoneLoves(idx),
      divisive: mostDivisive(idx),
      next: tryNext(me.id, ids, idx),
      notes: noteOverlap(api.fragrances, idx),
      table: sortedByAverage(idx),
    };
  }, [api.rankings, api.fragrances, memberIds.join(','), me.id]);

  if (api.members.length < 2) {
    return (
      <Empty title="Only you here so far">
        <p>Overlap compares tastes, so it needs at least two people. Share the room link or code with a friend.</p>
        <Link to="../members" className="btn btn-primary">Get the room link</Link>
      </Empty>
    );
  }
  if (api.rankings.length === 0) {
    return (
      <Empty title="Nothing ranked yet">
        <p>Once two or more people rank fragrances they’ve both tried, matches show up here.</p>
        <Link to=".." className="btn btn-primary">Rank fragrances</Link>
      </Empty>
    );
  }

  const tierOf = (memberId: string, fid: string) => {
    const v = a.idx.get(memberId)?.get(fid);
    return v ? tierForValue(v) : null;
  };

  return (
    <div className="overlap stack-lg">
      <nav className="overlap-nav" aria-label="Jump to section">
        {JUMPS.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
      </nav>

      <section className="stack-sm">
        <SectionHead title="Taste match" />
        <TasteMatch pairs={a.pairs} meId={me.id} nameOf={nameOf} />
      </section>

      <div className="split">
        <section className="stack-sm">
          <SectionHead title="Try next" hint="For you, from your closest match" />
          {!a.next.match ? (
            <p className="muted">
              Rank a few more fragrances that others have ranked too — you need {MIN_COMMON}+ in common with someone.
            </p>
          ) : a.next.fragranceIds.length === 0 ? (
            <p className="muted">
              Your closest match is <strong>{nameOf(a.next.match.member_id)}</strong> ({a.next.match.score}%) — and you’ve
              already tried everything they love.
            </p>
          ) : (
            <>
              <p>
                Your closest match is <strong>{nameOf(a.next.match.member_id)}</strong>{' '}
                <span className="num">({a.next.match.score}%)</span>. They love these and you haven’t ranked them:
              </p>
              <Capped items={a.next.fragranceIds} limit={5}>
                {(ids) => (
                  <ul className="frag-list">
                    {ids.map((fid) => (
                      <FragRow key={fid} f={fragById.get(fid)} onOpen={onOpen}>
                        <TierLetter tier={tierOf(a.next.match!.member_id, fid)} size="sm" title={nameOf(a.next.match!.member_id)} />
                      </FragRow>
                    ))}
                  </ul>
                )}
              </Capped>
            </>
          )}
        </section>

        <section className="stack-sm">
          <SectionHead title="Similarity map" hint="Darker means closer taste" />
          <SimilarityMap members={members} matrix={a.matrix} />
        </section>
      </div>

      <div className="split">
        <section className="stack-sm">
          <SectionHead title="Everyone loves" hint="2+ rankings, all A or better" />
          {a.loves.length === 0 ? (
            <p className="muted">No unanimous favourites yet.</p>
          ) : (
            <Capped items={a.loves} limit={5}>
              {(rows) => (
                <ul className="frag-list">
                  {rows.map((s) => (
                    <FragRow key={s.fragrance_id} f={fragById.get(s.fragrance_id)} onOpen={onOpen}>
                      <MemberTiers members={members} fid={s.fragrance_id} tierOf={tierOf} />
                    </FragRow>
                  ))}
                </ul>
              )}
            </Capped>
          )}
        </section>

        <section className="stack-sm">
          <SectionHead title="Most divisive" hint="Gap of 3+ tiers" />
          {a.divisive.length === 0 ? (
            <p className="muted">No big fights. Suspiciously harmonious.</p>
          ) : (
            <Capped items={a.divisive} limit={5}>
              {(rows) => (
                <ul className="frag-list">
                  {rows.map((s) => (
                    <FragRow
                      key={s.fragrance_id}
                      f={fragById.get(s.fragrance_id)}
                      onOpen={onOpen}
                      detail={<Extremes members={members} fid={s.fragrance_id} tierOf={tierOf} />}
                    />
                  ))}
                </ul>
              )}
            </Capped>
          )}
        </section>
      </div>

      <NotesSection notes={a.notes} members={members} />

      <section className="stack-sm">
        <SectionHead title="Side by side" hint="Sorted by group average" />
        <SideBySide stats={a.table} members={members} fragById={fragById} tierOf={tierOf} onOpen={onOpen} />
      </section>
    </div>
  );
}

function SectionHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <header className="section-head" id={title.toLowerCase().replace(/\s+/g, '-')}>
      <h2 className="h2">{title}</h2>
      {hint && <span className="label">{hint}</span>}
    </header>
  );
}

/** Long lists open short; the first few carry the point on a phone. */
function Capped<T>({ items, limit, children }: { items: T[]; limit: number; children: (visible: T[]) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {children(open ? items : items.slice(0, limit))}
      {items.length > limit && (
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </>
  );
}

function PairRow({ pair, label, mine }: { pair: PairMatch; label: ReactNode; mine?: boolean }) {
  return (
    <li className={`pair ${mine ? 'pair-me' : ''}`}>
      <span className="pair-names">{label}</span>
      {pair.score === null ? (
        <span className="pair-score muted small">need {MIN_COMMON}+ in common</span>
      ) : (
        <span className="pair-score">
          <span className="meter" aria-hidden>
            <span style={{ width: `${pair.score}%` }} />
          </span>
          <strong className="num">{pair.score}%</strong>
        </span>
      )}
      <span className="pair-common num muted small">{pair.common} in common</span>
    </li>
  );
}

function TasteMatch({ pairs, meId, nameOf }: { pairs: PairMatch[]; meId: string; nameOf: (id: string) => string }) {
  const other = (p: PairMatch) => (p.a === meId ? p.b : p.a);
  const mine = pairs.filter((p) => p.a === meId || p.b === meId);
  const scored = mine.filter((p) => p.score !== null);
  const closest = scored[0];
  const furthest = scored.length > 1 ? scored[scored.length - 1] : null;

  return (
    <div className="overlap-lead">
      <div className="stack-sm">
        {closest ? (
          <>
            <p className="verdict">You and {nameOf(other(closest))} agree most</p>
            <p className="muted">
              <span className="num">{closest.score}%</span> match over the{' '}
              <span className="num">{closest.common}</span> fragrances you’ve both ranked.
              {furthest && <> You’re furthest from {nameOf(other(furthest))}, at <span className="num">{furthest.score}%</span>.</>}
            </p>
          </>
        ) : (
          <>
            <p className="verdict">No match for you yet</p>
            <p className="muted">
              You need {MIN_COMMON}+ fragrances in common with someone. <Link to=".." className="btn-link">Rank a few more</Link>
            </p>
          </>
        )}
      </div>
      <div className="stack-sm">
        <ul className="pair-list">
          {mine.map((p) => <PairRow key={other(p)} pair={p} label={nameOf(other(p))} mine />)}
        </ul>
        {pairs.length > mine.length && (
          <details className="more">
            <summary>Every pair in the room ({pairs.length})</summary>
            <ul className="pair-list">
              {pairs.map((p) => (
                <PairRow
                  key={`${p.a}-${p.b}`}
                  pair={p}
                  label={<>{nameOf(p.a)} <span className="muted">×</span> {nameOf(p.b)}</>}
                />
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

function SimilarityMap({ members, matrix }: { members: Member[]; matrix: ReturnType<typeof similarityMatrix> }) {
  return (
    <>
      <div className="scroll-x fit">
        <table className="heatmap">
          <thead>
            <tr>
              <th />
              {members.map((m) => (
                <th key={m.id} scope="col" className="heat-col" title={m.display_name}>
                  <span className="heat-short" aria-hidden>{m.display_name.slice(0, 3)}</span>
                  <span className="heat-full">{m.display_name}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {members.map((row, i) => (
              <tr key={row.id}>
                <th scope="row" className="ellipsis" title={row.display_name}>{row.display_name}</th>
                {members.map((col, j) => {
                  const cell = matrix[i][j];
                  if (i === j) return <td key={col.id} className="heat-self" aria-label="Same person">—</td>;
                  if (cell.score === null) {
                    return (
                      <td key={col.id} className="heat-na" title={`${cell.common} in common`} aria-label="Not enough in common">
                        ·
                      </td>
                    );
                  }
                  const band = heatBand(cell.score);
                  return (
                    <td
                      key={col.id}
                      className={`heat num ${band.heat > 60 ? 'heat-strong' : ''}`}
                      style={{ '--heat': `${band.heat}%` } as React.CSSProperties}
                      title={`${row.display_name} × ${col.display_name}: ${cell.score}% over ${cell.common}`}
                    >
                      {cell.score}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="heat-legend" aria-label="Match % colour key">
        {[...HEAT_BANDS].reverse().map((b) => (
          <li key={b.label}>
            <span className="heat" style={{ '--heat': `${b.heat}%` } as React.CSSProperties} />
            {b.label}
          </li>
        ))}
        <li>“·” not enough in common</li>
      </ul>
    </>
  );
}

function FragRow({
  f,
  onOpen,
  detail,
  children,
}: {
  f?: Fragrance;
  onOpen: (id: string) => void;
  detail?: ReactNode;
  children?: ReactNode;
}) {
  if (!f) return null;
  return (
    <li>
      <button className="frag-row" onClick={() => onOpen(f.id)}>
        <span className="frag-row-text">
          <span className="frag-name">{f.name}</span>
          <span className="muted small">{f.house}</span>
          {detail}
        </span>
        {children && <span className="frag-row-tiers">{children}</span>}
      </button>
    </li>
  );
}

function MemberTiers({
  members,
  fid,
  tierOf,
}: {
  members: Member[];
  fid: string;
  tierOf: (m: string, f: string) => ReturnType<typeof tierForValue> | null;
}) {
  return (
    <>
      {members.map((m) => {
        const t = tierOf(m.id, fid);
        return t ? (
          <span key={m.id}>
            <span className="sr-only">{m.display_name}: </span>
            <TierLetter tier={t} size="sm" title={`${m.display_name}: ${t}`} />
          </span>
        ) : null;
      })}
    </>
  );
}

/** Who sits at each end of the argument, in words: a row of letters can't say who gave what on a phone. */
function Extremes({
  members,
  fid,
  tierOf,
}: {
  members: Member[];
  fid: string;
  tierOf: (m: string, f: string) => ReturnType<typeof tierForValue> | null;
}) {
  const ranked = members.flatMap((m) => {
    const t = tierOf(m.id, fid);
    return t ? [{ name: m.display_name, tier: t }] : [];
  });
  const positions = ranked.map((r) => TIERS.indexOf(r.tier));
  const ends = [TIERS[Math.min(...positions)], TIERS[Math.max(...positions)]];
  return (
    <span className="extremes">
      {ends.map((t) => (
        <span key={t}>
          <TierLetter tier={t} size="sm" /> {ranked.filter((r) => r.tier === t).map((r) => r.name).join(', ')}
        </span>
      ))}
    </span>
  );
}

const LIKE = 3.5;
const DISLIKE = 2.5;

function noteInsights(notes: NoteRow[], members: Member[]): string[] {
  const name = (id: string) => members.find((m) => m.id === id)?.display_name ?? '—';
  const out: string[] = [];
  for (const n of notes) {
    const entries = [...n.perMember.entries()];
    // Skip one-off notes: an insight needs 2+ people and 3+ rankings behind it.
    if (entries.length < 2 || n.totalRankings < 3) continue;
    const likers = entries.filter(([, v]) => v.avg >= LIKE);
    const dislikers = entries.filter(([, v]) => v.avg <= DISLIKE);
    if (likers.length === entries.length) out.push(`Everyone likes ${n.note}`);
    else if (dislikers.length === entries.length) out.push(`Nobody’s into ${n.note}`);
    else if (likers.length === 1 && dislikers.length === entries.length - 1) out.push(`Only ${name(likers[0][0])} likes ${n.note}`);
    else if (dislikers.length === 1 && likers.length === entries.length - 1) out.push(`Everyone but ${name(dislikers[0][0])} likes ${n.note}`);
    if (out.length >= 6) break;
  }
  return out;
}

function NotesSection({ notes, members }: { notes: NoteRow[]; members: Member[] }) {
  const top = notes.slice(0, 16);
  const insights = noteInsights(notes, members);
  return (
    <section className="stack-sm">
      <SectionHead title="By note" hint="Average tier per person" />
      {top.length === 0 ? (
        <p className="muted">Add notes tags (vanilla, citrus, oud…) to fragrances to see which accords you share.</p>
      ) : (
        <>
          {insights.length > 0 && (
            <ul className="insights">
              {insights.map((t) => <li key={t}>{t}</li>)}
            </ul>
          )}
          <div className="scroll-x">
            <table className="grid-table">
              <thead>
                <tr>
                  <th scope="col" className="sticky-col">Note</th>
                  {members.map((m) => <th key={m.id} scope="col" className="ellipsis">{m.display_name}</th>)}
                </tr>
              </thead>
              <tbody>
                {top.map((n) => (
                  <tr key={n.note}>
                    <th scope="row" className="sticky-col">{n.note}</th>
                    {members.map((m) => {
                      const v = n.perMember.get(m.id);
                      return (
                        <td key={m.id}>
                          {v ? (
                            <span className="cell-avg" title={`avg ${v.avg.toFixed(1)} over ${v.count}`}>
                              <TierLetter tier={tierForValue(v.avg)} size="sm" />
                              <span className="num fine muted">{v.count}</span>
                            </span>
                          ) : (
                            <TierLetter tier={null} size="sm" />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function SideBySide({
  stats,
  members,
  fragById,
  tierOf,
  onOpen,
}: {
  stats: FragranceStats[];
  members: Member[];
  fragById: Map<string, Fragrance>;
  tierOf: (m: string, f: string) => ReturnType<typeof tierForValue> | null;
  onOpen: (id: string) => void;
}) {
  return (
    <Capped items={stats} limit={15}>
      {(rows) => (
        <div className="scroll-x">
          <table className="grid-table side-table">
            <thead>
              <tr>
                <th scope="col" className="sticky-col">Fragrance</th>
                <th scope="col">Avg</th>
                {members.map((m) => <th key={m.id} scope="col" className="ellipsis">{m.display_name}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const f = fragById.get(s.fragrance_id);
                if (!f) return null;
                return (
                  <tr key={s.fragrance_id}>
                    <th scope="row" className="sticky-col">
                      <button className="cell-link" onClick={() => onOpen(f.id)}>
                        <span className="frag-name">{f.name}</span>
                        <span className="muted fine">{f.house}</span>
                      </button>
                    </th>
                    <td className="num small">{s.avg.toFixed(1)}</td>
                    {members.map((m) => <td key={m.id}><TierLetter tier={tierOf(m.id, f.id)} size="sm" /></td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Capped>
  );
}
