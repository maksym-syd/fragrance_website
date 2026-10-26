import { useMemo } from 'react';
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
  tierForValue,
  tryNext,
  type FragranceStats,
  type NoteRow,
} from '../lib/overlap';
import type { Fragrance, Member } from '../lib/types';
import { Empty, TierLetter } from './ui';

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
        <p>Overlap compares tastes, so it needs at least two people. Invite friends by email, then share the link.</p>
        <Link to="../members" className="btn btn-primary">Invite friends</Link>
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
      <section className="stack-sm">
        <SectionHead title="Taste match" hint={`Over fragrances both ranked · needs ${MIN_COMMON}+ in common`} />
        <ul className="pair-list">
          {a.pairs.map((p) => (
            <li key={`${p.a}-${p.b}`} className={`pair ${p.a === me.id || p.b === me.id ? 'pair-me' : ''}`}>
              <span className="pair-names">
                {nameOf(p.a)} <span className="muted">×</span> {nameOf(p.b)}
              </span>
              {p.score === null ? (
                <span className="pair-score muted small">need {MIN_COMMON}+ in common</span>
              ) : (
                <span className="pair-score">
                  <span className="meter" aria-hidden>
                    <span style={{ width: `${p.score}%` }} />
                  </span>
                  <strong className="mono">{p.score}%</strong>
                </span>
              )}
              <span className="pair-common mono muted small">{p.common} in common</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="stack-sm">
        <SectionHead title="Similarity map" hint="Darker = closer taste" />
        <div className="scroll-x fit">
          <table className="heatmap">
            <thead>
              <tr>
                <th />
                {members.map((m) => <th key={m.id} scope="col" className="heat-col"><span>{m.display_name}</span></th>)}
              </tr>
            </thead>
            <tbody>
              {members.map((row, i) => (
                <tr key={row.id}>
                  <th scope="row" className="ellipsis">{row.display_name}</th>
                  {members.map((col, j) => {
                    const cell = a.matrix[i][j];
                    if (i === j) return <td key={col.id} className="heat-self" aria-label="Same person">—</td>;
                    if (cell.score === null) {
                      return (
                        <td key={col.id} className="heat-na" title={`${cell.common} in common`}>
                          <span className="mono">{cell.common ? `${cell.common}·` : '·'}</span>
                        </td>
                      );
                    }
                    return (
                      <td
                        key={col.id}
                        className={`heat ${cell.score >= 60 ? 'heat-strong' : ''}`}
                        style={{ '--heat': `${Math.max(8, cell.score)}%` } as React.CSSProperties}
                        title={`${row.display_name} × ${col.display_name}: ${cell.score}% over ${cell.common}`}
                      >
                        <span className="mono">{cell.score}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fine mono muted">Numbers are match %. “·” = not enough in common.</p>
      </section>

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
              <span className="mono">({a.next.match.score}%)</span>. They love these and you haven’t ranked them:
            </p>
            <ul className="frag-list">
              {a.next.fragranceIds.map((fid) => (
                <FragRow key={fid} f={fragById.get(fid)} onOpen={onOpen}>
                  <TierLetter tier={tierOf(a.next.match!.member_id, fid)} size="sm" title={nameOf(a.next.match!.member_id)} />
                </FragRow>
              ))}
            </ul>
          </>
        )}
      </section>

      <div className="split">
        <section className="stack-sm">
          <SectionHead title="Everyone loves" hint="2+ rankings, all A or better" />
          {a.loves.length === 0 ? (
            <p className="muted">No unanimous favourites yet.</p>
          ) : (
            <ul className="frag-list">
              {a.loves.map((s) => (
                <FragRow key={s.fragrance_id} f={fragById.get(s.fragrance_id)} onOpen={onOpen}>
                  <MemberTiers members={members} fid={s.fragrance_id} tierOf={tierOf} />
                </FragRow>
              ))}
            </ul>
          )}
        </section>

        <section className="stack-sm">
          <SectionHead title="Most divisive" hint="Gap of 3+ tiers" />
          {a.divisive.length === 0 ? (
            <p className="muted">No big fights. Suspiciously harmonious.</p>
          ) : (
            <ul className="frag-list">
              {a.divisive.map((s) => (
                <FragRow key={s.fragrance_id} f={fragById.get(s.fragrance_id)} onOpen={onOpen}>
                  <MemberTiers members={members} fid={s.fragrance_id} tierOf={tierOf} />
                </FragRow>
              ))}
            </ul>
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
    <header className="section-head">
      <h2 className="h2">{title}</h2>
      {hint && <span className="label">{hint}</span>}
    </header>
  );
}

function FragRow({ f, onOpen, children }: { f?: Fragrance; onOpen: (id: string) => void; children: React.ReactNode }) {
  if (!f) return null;
  return (
    <li>
      <button className="frag-row" onClick={() => onOpen(f.id)}>
        <span className="frag-row-text">
          <span className="frag-name">{f.name}</span>
          <span className="muted small">{f.house}</span>
        </span>
        <span className="frag-row-tiers">{children}</span>
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
        return t ? <TierLetter key={m.id} tier={t} size="sm" title={`${m.display_name}: ${t}`} /> : null;
      })}
    </>
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
                              <span className="mono fine muted">{v.count}</span>
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
          {stats.map((s) => {
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
                <td className="mono small">{s.avg.toFixed(1)}</td>
                {members.map((m) => <td key={m.id}><TierLetter tier={tierOf(m.id, f.id)} size="sm" /></td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
