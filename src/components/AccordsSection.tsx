import { useMemo } from 'react';
import type { RoomApi } from '../hooks/useRoom';
import { accordOverlap, formatScore, indexRankings, tierForValue } from '../lib/overlap';
import type { Member } from '../lib/types';
import { SectionHead, TierLetter } from './ui';

/** Average tier per accord, per person. Same reading as "By note", one level up. */
export default function AccordsSection({ api, members }: { api: RoomApi; members: Member[] }) {
  const rows = useMemo(
    () => accordOverlap(api.fragrances, indexRankings(api.rankings)).slice(0, 12),
    [api.fragrances, api.rankings],
  );
  return (
    <section className="stack-sm">
      <SectionHead title="By accord" hint="Average tier per person" />
      {rows.length === 0 ? (
        <p className="muted">Add accords (woody, fresh, floral…) to ranked fragrances to compare the kinds of scent you each like.</p>
      ) : (
        <div className="scroll-x">
          <table className="grid-table">
            <thead>
              <tr>
                <th scope="col" className="sticky-col">Accord</th>
                {members.map((m) => <th key={m.id} scope="col" className="ellipsis">{m.display_name}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.tag}>
                  <th scope="row" className="sticky-col">{r.tag}</th>
                  {members.map((m) => {
                    const v = r.perMember.get(m.id);
                    return (
                      <td key={m.id}>
                        {v ? (
                          <span className="cell-avg" title={`average ${formatScore(v.avg)} over ${v.count}`}>
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
      )}
    </section>
  );
}
