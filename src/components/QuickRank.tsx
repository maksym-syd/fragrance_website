import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { RoomApi } from '../hooks/useRoom';
import { TIERS } from '../lib/overlap';
import { TIER_LABEL } from '../lib/tiers';
import type { Tier } from '../lib/types';
import { TierLetter } from './ui';

type Step = { id: string; ranked: boolean };

/**
 * One bottle at a time: a single tap ranks it and brings up the next, with no scrolling back to
 * the pool. Bottles the group has ranked most come first, because those feed the taste match.
 * Skipping writes nothing: no ranking is what "haven't tried" means.
 */
export default function QuickRank({ api, onClose }: { api: RoomApi; onClose: () => void }) {
  const me = api.me!;
  const dialogRef = useRef<HTMLDivElement>(null);
  const [steps, setSteps] = useState<Step[]>([]);

  // Fixed when opened, so the order doesn't reshuffle while friends rank in realtime.
  const [queue] = useState(() => {
    const mine = new Set(api.rankings.filter((r) => r.member_id === me.id).map((r) => r.fragrance_id));
    const count = new Map<string, number>();
    for (const r of api.rankings) count.set(r.fragrance_id, (count.get(r.fragrance_id) ?? 0) + 1);
    return api.fragrances
      .filter((f) => !mine.has(f.id))
      .sort((a, b) => (count.get(b.id) ?? 0) - (count.get(a.id) ?? 0))
      .map((f) => f.id);
  });

  const byId = useMemo(() => new Map(api.fragrances.map((f) => [f.id, f])), [api.fragrances]);
  // Someone may remove a bottle for everyone while this is open, so skip over anything gone.
  const done = new Set(steps.map((s) => s.id));
  const remaining = queue.filter((id) => !done.has(id) && byId.has(id));
  const current = remaining.length > 0 ? byId.get(remaining[0])! : null;
  const left = remaining.length;
  const rankedCount = steps.filter((s) => s.ranked).length;
  const skippedCount = steps.length - rankedCount;

  const friends = current
    ? api.members
        .filter((m) => m.id !== me.id)
        .map((m) => ({ m, tier: api.rankings.find((r) => r.member_id === m.id && r.fragrance_id === current.id)?.tier }))
        .filter((x) => x.tier)
    : [];

  function rank(tier: Tier) {
    if (!current) return;
    api.setTier(current.id, tier);
    setSteps((s) => [...s, { id: current.id, ranked: true }]);
  }

  function skip() {
    if (current) setSteps((s) => [...s, { id: current.id, ranked: false }]);
  }

  function undo() {
    const last = steps[steps.length - 1];
    if (!last) return;
    if (last.ranked) api.setTier(last.id, null);
    setSteps((s) => s.slice(0, -1));
  }

  const keys = useRef({ rank, skip, undo, onClose });
  keys.current = { rank, skip, undo, onClose };

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return keys.current.onClose();
      if (e.key === 'Tab') return trapTab(e, dialogRef.current);
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tier = TIERS.find((t) => t.toLowerCase() === e.key.toLowerCase());
      if (tier) keys.current.rank(tier);
      else if (e.key === 'ArrowRight') keys.current.skip();
      else if (e.key === 'ArrowLeft') keys.current.undo();
    };
    document.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      previous?.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="sheet qr"
        role="dialog"
        aria-modal="true"
        aria-labelledby="qr-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sheet-head">
          <div>
            <h2 id="qr-title" className="h2">Quick rank</h2>
            <p className="muted small num" role="status">
              {current ? `${left} left` : 'All done'}
              {rankedCount > 0 && `, ${rankedCount} ranked`}
            </p>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close">×</button>
        </header>

        {current ? (
          <>
            <div key={current.id} className="qr-card">
              <p className="sheet-title">{current.name}</p>
              <p className="muted">
                {current.house}
                {current.concentration && <>, {current.concentration}</>}
              </p>
              {current.notes.length > 0 && (
                <div className="tags">
                  {current.notes.map((n) => <span key={n} className="tag">{n}</span>)}
                </div>
              )}
              {friends.length > 0 && (
                <div className="row-wrap">
                  {friends.map(({ m, tier }) => (
                    <span key={m.id} className="other-rank">
                      <TierLetter tier={tier!} size="sm" /> {m.display_name}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {api.save === 'error' && (
              <p className="error small" role="alert">Couldn’t save that one. Undo and try it again.</p>
            )}

            <div className="tier-buttons">
              {TIERS.map((t) => (
                <button key={t} className={`tier-button tier-${t.toLowerCase()}`} onClick={() => rank(t)}>
                  <span className="tier-button-letter">{t}</span>
                  <span className="tier-button-caption">{TIER_LABEL[t]}</span>
                </button>
              ))}
            </div>
            <div className="qr-actions">
              <button className="btn btn-ghost" onClick={undo} disabled={steps.length === 0}>Undo</button>
              <button className="btn" onClick={skip}>Haven’t tried</button>
            </div>
            <p className="only-desktop muted small">
              Keys: <kbd>S</kbd> <kbd>A</kbd> <kbd>B</kbd> <kbd>C</kbd> <kbd>D</kbd> to rank, <kbd>→</kbd> haven’t tried,{' '}
              <kbd>←</kbd> undo
            </p>
          </>
        ) : (
          <div className="qr-card qr-done">
            <p className="sheet-title">{queue.length === 0 ? 'Nothing left to rank' : 'That’s the lot'}</p>
            <p className="muted">
              {rankedCount} ranked, {skippedCount} not tried. Those stay in Unranked, so you can come back when you’ve
              worn them.
            </p>
            <div className="qr-actions">
              <button className="btn btn-ghost" onClick={undo} disabled={steps.length === 0}>Undo</button>
              {rankedCount > 0 ? (
                <Link className="btn btn-primary" to={`/r/${api.room!.code}/overlap`} onClick={onClose}>See overlap</Link>
              ) : (
                <button className="btn btn-primary" onClick={onClose}>Done</button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function trapTab(e: KeyboardEvent, dialog: HTMLElement | null) {
  const items = dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]');
  if (!items?.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === dialog)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}
