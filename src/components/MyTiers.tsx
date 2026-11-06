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
import { useMemo, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import type { RoomApi } from '../hooks/useRoom';
import { TIERS } from '../lib/overlap';
import { TIER_LABEL } from '../lib/tiers';
import type { Fragrance, Tier } from '../lib/types';
import ExportButton from './ExportBoard';
import QuickRank from './QuickRank';
import { Empty } from './ui';

const UNRANKED = 'unranked';
type Row = Tier | typeof UNRANKED;
type View = Row | 'all';
type Sort = 'added' | 'name' | 'house' | 'popular';

/** "hermes" should find "Hermès". */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const SORTERS: Record<Exclude<Sort, 'added' | 'popular'>, (a: Fragrance, b: Fragrance) => number> = {
  name: (a, b) => a.name.localeCompare(b.name),
  house: (a, b) => a.house.localeCompare(b.house) || a.name.localeCompare(b.name),
};

export default function MyTiers({ api, onOpen }: { api: RoomApi; onOpen: (id: string) => void }) {
  const me = api.me!;
  const [dragging, setDragging] = useState<Fragrance | null>(null);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>('all');
  const [sort, setSort] = useState<Sort>('added');
  const [quickRank, setQuickRank] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  // Mouse drags on desktop; touch is tap-to-assign via the sheet so scrolling stays natural.
  // The 6px threshold means a plain click (or Enter for keyboard users) still opens the sheet.
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }));

  const mine = useMemo(
    () => new Map(api.rankings.filter((r) => r.member_id === me.id).map((r) => [r.fragrance_id, r.tier])),
    [api.rankings, me.id],
  );

  const byTier = useMemo(() => {
    const q = fold(query.trim());
    const matches = (f: Fragrance) =>
      !q || [f.name, f.house, f.concentration ?? '', ...f.notes].some((t) => fold(t).includes(q));

    const count = new Map<string, number>();
    for (const r of api.rankings) count.set(r.fragrance_id, (count.get(r.fragrance_id) ?? 0) + 1);
    const order = sort === 'added' ? null
      : sort === 'popular' ? (a: Fragrance, b: Fragrance) => (count.get(b.id) ?? 0) - (count.get(a.id) ?? 0)
      : SORTERS[sort];

    const groups: Record<Row, Fragrance[]> = { S: [], A: [], B: [], C: [], D: [], unranked: [] };
    for (const f of api.fragrances) if (matches(f)) groups[mine.get(f.id) ?? UNRANKED].push(f);
    if (order) for (const list of Object.values(groups)) list.sort(order);
    return groups;
  }, [api.rankings, api.fragrances, mine, query, sort]);

  if (api.fragrances.length === 0) {
    return (
      <Empty title="This room has no fragrances yet">
        <p>Add a few you’ve tried. The quick-add list makes it fast.</p>
        <Link to="add" className="btn btn-primary">Add fragrances</Link>
      </Empty>
    );
  }

  function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    const target = e.over?.id as Row | undefined;
    if (!target) return;
    const fid = String(e.active.id);
    const current = mine.get(fid) ?? UNRANKED;
    if (current === target) return;
    api.setTier(fid, target === UNRANKED ? null : target);
  }

  /** Arrows walk the board; S/A/B/C/D rank the focused chip; U sends it back to Unranked. */
  function onChipKey(e: KeyboardEvent<HTMLButtonElement>, f: Fragrance) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const chips = [...document.querySelectorAll<HTMLElement>('[data-frag-id]')];
    const i = chips.indexOf(e.currentTarget);

    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      chips[e.key === 'ArrowRight' || e.key === 'ArrowDown' ? i + 1 : i - 1]?.focus();
      return;
    }

    const key = e.key.toLowerCase();
    const tier = key === 'u' ? null : TIERS.find((t) => t.toLowerCase() === key);
    if (tier === undefined || tier === (mine.get(f.id) ?? null)) return;
    e.preventDefault();
    // Moving the chip remounts it, so carry focus to its neighbour to keep ranking down the row.
    const nextId = (chips[i + 1] ?? chips[i - 1])?.dataset.fragId;
    api.setTier(f.id, tier);
    setAnnouncement(`${f.name} moved to ${tier ? `${tier}, ${TIER_LABEL[tier]}` : 'Unranked'}`);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-frag-id="${nextId}"]`)?.focus()),
    );
  }

  const unrankedTotal = api.fragrances.filter((f) => !mine.has(f.id)).length;
  const rankedCount = api.fragrances.length - unrankedTotal;
  const searching = query.trim().length > 0;
  const total = TIERS.reduce((n, t) => n + byTier[t].length, byTier.unranked.length);
  const visibleCount = view === 'all' ? total : byTier[view].length;
  const showTiers = view === 'all' ? TIERS : TIERS.filter((t) => t === view);

  return (
    <div className="stack board">
      <div className="board-tools">
        <div className="toolbar">
          <p className="small num">
            <strong>{rankedCount}</strong> <span className="muted">of {api.fragrances.length} ranked</span>
          </p>
          <div className="row-wrap">
            {unrankedTotal > 0 && (
              <button className="btn btn-sm btn-primary" onClick={() => setQuickRank(true)}>Quick rank</button>
            )}
            <ExportButton api={api} />
          </div>
        </div>
        <div className="board-search">
          <input
            type="search"
            aria-label="Search this board by name, house or note"
            placeholder="Name, house or note"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <label className="sr-only" htmlFor="board-sort">Sort by</label>
          <select id="board-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="added">Added</option>
            <option value="name">A to Z</option>
            <option value="house">House</option>
            <option value="popular">Most ranked</option>
          </select>
        </div>
      </div>

      <div className="tier-filter" role="group" aria-label="Show one tier">
        <button className="tier-filter-plain" aria-pressed={view === 'all'} onClick={() => setView('all')}>All</button>
        {TIERS.map((t) => (
          <button
            key={t}
            className={`tier-${t.toLowerCase()}`}
            aria-pressed={view === t}
            aria-label={`${t}, ${TIER_LABEL[t]}: ${byTier[t].length}`}
            onClick={() => setView(view === t ? 'all' : t)}
          >
            <b>{t}</b>
            <span className="num">{byTier[t].length}</span>
          </button>
        ))}
        <button
          className="tier-filter-plain"
          aria-pressed={view === UNRANKED}
          onClick={() => setView(view === UNRANKED ? 'all' : UNRANKED)}
        >
          Unranked <span className="num">{byTier.unranked.length}</span>
        </button>
      </div>

      {searching && visibleCount === 0 ? (
        <Empty title={view === 'all' ? `Nothing here matches “${query.trim()}”` : `No match in this tier`}>
          <p>Check the spelling, or add it if the room doesn’t have it yet.</p>
          <div className="row-wrap">
            <button className="btn" onClick={() => { setQuery(''); setView('all'); }}>Clear search</button>
            <Link to="add" className="btn btn-primary">Add a fragrance</Link>
          </div>
        </Empty>
      ) : (
        <DndContext
          sensors={sensors}
          accessibility={{
            screenReaderInstructions: {
              draggable: 'Press S, A, B, C or D to rank this fragrance, U to unrank it, Enter for details. Arrow keys move between fragrances.',
            },
          }}
          onDragStart={(e) => setDragging(api.fragrances.find((f) => f.id === e.active.id) ?? null)}
          onDragCancel={() => setDragging(null)}
          onDragEnd={onDragEnd}
        >
          {showTiers.length > 0 && (
            <div className="tier-board">
              {showTiers.map((t) => (
                <TierRow key={t} id={t} items={byTier[t]} onOpen={onOpen} onKey={onChipKey} quiet={searching && byTier[t].length === 0}>
                  <div className={`tier-label tier-${t.toLowerCase()}`}>
                    <span className="tier-label-letter">{t}</span>
                    <span className="tier-label-caption">{TIER_LABEL[t]}</span>
                  </div>
                </TierRow>
              ))}
            </div>
          )}

          {(view === 'all' || view === UNRANKED) && (
            <section className="pool">
              <h2 className="label">Unranked <span className="muted">(haven’t tried)</span></h2>
              <TierRow id={UNRANKED} items={byTier.unranked} onOpen={onOpen} onKey={onChipKey} pool>
                {byTier.unranked.length === 0 && (
                  <p className="muted small pool-empty">
                    {searching ? 'No unranked matches.' : 'Everything here is ranked. Nice nose.'}
                  </p>
                )}
              </TierRow>
            </section>
          )}

          <DragOverlay dropAnimation={null}>{dragging && <Chip fragrance={dragging} overlay />}</DragOverlay>
        </DndContext>
      )}

      <p className="muted small">
        <span className="only-desktop">
          Drag between rows, click for details, or focus a fragrance and press <kbd>S</kbd> <kbd>A</kbd> <kbd>B</kbd>{' '}
          <kbd>C</kbd> <kbd>D</kbd> to rank it.
        </span>
        <span className="only-touch">Tap a fragrance to rank it and see what friends gave it.</span>
      </p>

      <p className="sr-only" role="status">{announcement}</p>
      {quickRank && <QuickRank api={api} onClose={() => setQuickRank(false)} />}
    </div>
  );
}

function TierRow({
  id,
  items,
  onOpen,
  onKey,
  pool,
  quiet,
  children,
}: {
  id: string;
  items: Fragrance[];
  onOpen: (id: string) => void;
  onKey: (e: KeyboardEvent<HTMLButtonElement>, f: Fragrance) => void;
  pool?: boolean;
  quiet?: boolean;
  children?: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={`tier-row ${pool ? 'tier-row-pool' : ''} ${quiet ? 'is-quiet' : ''} ${isOver ? 'is-over' : ''}`}>
      {!pool && children}
      <div className="tier-items">
        {items.map((f) => (
          <DraggableChip key={f.id} fragrance={f} onOpen={onOpen} onKey={onKey} />
        ))}
        {pool && children}
      </div>
    </div>
  );
}

function DraggableChip({
  fragrance,
  onOpen,
  onKey,
}: {
  fragrance: Fragrance;
  onOpen: (id: string) => void;
  onKey: (e: KeyboardEvent<HTMLButtonElement>, f: Fragrance) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: fragrance.id });
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={`chip ${isDragging ? 'is-dragging' : ''}`}
      data-frag-id={fragrance.id}
      onClick={() => onOpen(fragrance.id)}
      onKeyDown={(e) => onKey(e, fragrance)}
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
