import { useMemo, useState } from 'react';
import { formatScore, SCALE_LEGEND, tierForValue, type TagRow } from '../lib/overlap';
import { PULL, sortByCommon, sortByDivide, tagInsights, withLift, type Baseline } from '../lib/taste';
import type { Member } from '../lib/types';
import { SectionHead, TierLetter } from './ui';

type Order = 'divide' | 'common';

/**
 * "By note" and "By accord": each person's average tier per tag, marked ▲/▼ where it sits half a
 * tier or more above or below that person's own average. Sorted by what tells people apart.
 */
export default function TagTable({
  title,
  noun,
  rows,
  baselines,
  members,
  limit,
  empty,
}: {
  title: string;
  /** Column header and legend word: "Note", "Accord". */
  noun: string;
  rows: TagRow[];
  baselines: Map<string, Baseline>;
  members: Member[];
  limit: number;
  empty: string;
}) {
  const [order, setOrder] = useState<Order>('divide');
  const lifted = useMemo(() => withLift(rows, baselines), [rows, baselines]);
  const shown = useMemo(
    () => (order === 'divide' ? sortByDivide(lifted) : sortByCommon(lifted)).slice(0, limit),
    [lifted, order, limit],
  );
  const insights = useMemo(() => {
    const names = new Map(members.map((m) => [m.id, m.display_name]));
    return tagInsights(lifted, (id) => names.get(id) ?? '—');
  }, [lifted, members]);

  return (
    <section className="stack-sm">
      <SectionHead title={title} hint="Average tier per person" />
      {shown.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <>
          {insights.length > 0 && (
            <ul className="insights">
              {insights.map((t) => <li key={t}>{t}</li>)}
            </ul>
          )}
          <div className="seg" role="group" aria-label={`Order ${noun.toLowerCase()}s by`}>
            <button type="button" aria-pressed={order === 'divide'} onClick={() => setOrder('divide')}>
              What divides you
            </button>
            <button type="button" aria-pressed={order === 'common'} onClick={() => setOrder('common')}>
              Most common
            </button>
          </div>
          <div className="scroll-x">
            <table className="grid-table">
              <thead>
                <tr>
                  <th scope="col" className="sticky-col">{noun}</th>
                  {members.map((m) => <th key={m.id} scope="col" className="ellipsis">{m.display_name}</th>)}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.tag}>
                    <th scope="row" className="sticky-col">{r.tag}</th>
                    {members.map((m) => {
                      const v = r.perMember.get(m.id);
                      if (!v) return <td key={m.id}><TierLetter tier={null} size="sm" /></td>;
                      const dir = v.lift >= PULL ? 'up' : v.lift <= -PULL ? 'down' : null;
                      return (
                        <td key={m.id}>
                          <span
                            className="cell-avg"
                            title={`${m.display_name}: average ${formatScore(v.avg)} over ${v.count}, ${formatScore(v.lift)} against their own average`}
                          >
                            <TierLetter tier={tierForValue(v.avg)} size="sm" />
                            {dir && (
                              <span className={`lift lift-${dir}`}>
                                <span aria-hidden>{dir === 'up' ? '▲' : '▼'}</span>
                                <span className="sr-only">{dir === 'up' ? 'above' : 'below'} their usual</span>
                              </span>
                            )}
                            <span className="num fine muted">{v.count}</span>
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="scale-legend">
            Letter: average tier ({SCALE_LEGEND}). ▲ ▼ half a tier or more above or below that person’s own
            average. Small number: bottles ranked.
          </p>
        </>
      )}
    </section>
  );
}
