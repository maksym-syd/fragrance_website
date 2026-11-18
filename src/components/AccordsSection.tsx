import { useMemo } from 'react';
import type { RoomApi } from '../hooks/useRoom';
import { accordOverlap, indexRankings } from '../lib/overlap';
import { memberBaselines } from '../lib/taste';
import type { Member } from '../lib/types';
import TagTable from './TagTable';

/** Average tier per accord, per person. Same reading as "By note", one level up. */
export default function AccordsSection({ api, members }: { api: RoomApi; members: Member[] }) {
  const { rows, baselines } = useMemo(() => {
    const idx = indexRankings(api.rankings);
    return { rows: accordOverlap(api.fragrances, idx), baselines: memberBaselines(idx) };
  }, [api.fragrances, api.rankings]);
  return (
    <TagTable
      title="By accord"
      noun="Accord"
      rows={rows}
      baselines={baselines}
      members={members}
      limit={12}
      empty="Add accords (woody, fresh, floral…) to ranked fragrances to compare the kinds of scent you each like."
    />
  );
}
