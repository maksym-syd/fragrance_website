import {
  DndContext,
  DragOverlay,
  MouseSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { RoomApi } from '../hooks/useRoom';
import { TIERS } from '../lib/overlap';
import { TIER_LABEL } from '../lib/tiers';
import type { Fragrance, Tier } from '../lib/types';
import ExportButton from './ExportBoard';
import { Empty } from './ui';

const UNRANKED = 'unranked';

export default function MyTiers({ api, onOpen }: { api: RoomApi; onOpen: (id: string) => void }) {
  const me = api.me!;
  const [dragging, setDragging] = useState<Fragrance | null>(null);

  // Mouse drags on desktop; touch is tap-to-assign via the sheet so scrolling stays natural.
  // The 6px threshold means a plain click (or Enter for keyboard users) still opens the sheet.
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }));

  const byTier = useMemo(() => {
    const mine = new Map(api.rankings.filter((r) => r.member_id === me.id).map((r) => [r.fragrance_id, r.tier]));
    const groups: Record<Tier | typeof UNRANKED, Fragrance[]> = { S: [], A: [], B: [], C: [], D: [], unranked: [] };
    for (const f of api.fragrances) groups[mine.get(f.id) ?? UNRANKED].push(f);
    return groups;
  }, [api.rankings, api.fragrances, me.id]);

  if (api.fragrances.length === 0) {
    return (
      <Empty title="This room has no fragrances yet">
        <p>Add a few you’ve tried — the popular quick-add list makes it fast.</p>
        <Link to="add" className="btn btn-primary">Add fragrances</Link>
      </Empty>
    );
  }

  function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    const target = e.over?.id as Tier | typeof UNRANKED | undefined;
    if (!target) return;
    const fid = String(e.active.id);
    const current = (TIERS as string[]).find((t) => byTier[t as Tier].some((f) => f.id === fid)) ?? UNRANKED;
    if (current === target) return;
    api.setTier(fid, target === UNRANKED ? null : target);
  }

  const rankedCount = api.fragrances.length - byTier.unranked.length;

  return (
    <div className="stack">
      <div className="toolbar">
        <p className="muted small">
          <span className="only-desktop">Drag between rows, or click</span>
          <span className="only-touch">Tap</span> a fragrance to rank it · {rankedCount}/{api.fragrances.length} ranked
        </p>
        <ExportButton api={api} />
      </div>

      <DndContext
        sensors={sensors}
        onDragStart={(e) => setDragging(api.fragrances.find((f) => f.id === e.active.id) ?? null)}
        onDragCancel={() => setDragging(null)}
        onDragEnd={onDragEnd}
      >
        <div className="tier-board">
          {TIERS.map((t) => (
            <TierRow key={t} id={t} items={byTier[t]} onOpen={onOpen}>
              <div className={`tier-label tier-${t.toLowerCase()}`}>
                <span className="tier-label-letter">{t}</span>
                <span className="tier-label-caption">{TIER_LABEL[t]}</span>
              </div>
            </TierRow>
          ))}
        </div>

        <section className="pool">
          <h2 className="label">Unranked · haven’t tried</h2>
          <TierRow id={UNRANKED} items={byTier.unranked} onOpen={onOpen} pool>
            {byTier.unranked.length === 0 && <p className="muted small pool-empty">Everything here is ranked. Nice nose.</p>}
          </TierRow>
        </section>

        <DragOverlay dropAnimation={null}>{dragging && <Chip fragrance={dragging} overlay />}</DragOverlay>
      </DndContext>
    </div>
  );
}

function TierRow({
  id,
  items,
  onOpen,
  pool,
  children,
}: {
  id: string;
  items: Fragrance[];
  onOpen: (id: string) => void;
  pool?: boolean;
  children?: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={`tier-row ${pool ? 'tier-row-pool' : ''} ${isOver ? 'is-over' : ''}`}>
      {!pool && children}
      <div className="tier-items">
        {items.map((f) => (
          <DraggableChip key={f.id} fragrance={f} onOpen={onOpen} />
        ))}
        {pool && children}
      </div>
    </div>
  );
}

function DraggableChip({ fragrance, onOpen }: { fragrance: Fragrance; onOpen: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: fragrance.id });
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={`chip ${isDragging ? 'is-dragging' : ''}`}
      onClick={() => onOpen(fragrance.id)}
      {...listeners}
      {...attributes}
      aria-roledescription="fragrance"
      aria-label={`${fragrance.name} by ${fragrance.house}`}
    >
      <ChipBody fragrance={fragrance} />
    </button>
  );
}

function Chip({ fragrance, overlay }: { fragrance: Fragrance; overlay?: boolean }) {
  return (
    <div className={`chip ${overlay ? 'chip-overlay' : ''}`}>
      <ChipBody fragrance={fragrance} />
    </div>
  );
}

function ChipBody({ fragrance }: { fragrance: Fragrance }) {
  return (
    <>
      <span className="chip-name">{fragrance.name}</span>
      <span className="chip-house">{fragrance.house}</span>
    </>
  );
}
