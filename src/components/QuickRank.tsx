import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { RoomApi } from '../hooks/useRoom';
import { pyramidLine } from '../lib/details';
import { TIERS } from '../lib/overlap';
import { TIER_LABEL } from '../lib/tiers';
import type { Tier } from '../lib/types';
import { boardFocusFallback, TierLetter, useModal } from './ui';

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

  const notesLine = current ? pyramidLine(current) : null;
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
    if (last.ranked) api.setTier(last.id, null, { undo: false });
    setSteps((s) => s.slice(0, -1));
  }

  // Ranking the last unranked bottle removes the Quick rank button, so fall back to the board.
  useModal(dialogRef, onClose, undefined, boardFocusFallback);

  const keys = useRef({ rank, skip, undo });
  keys.current = { rank, skip, undo };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Holding a key would otherwise rank a run of bottles in one go.
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const tier = TIERS.find((t) => t.toLowerCase() === e.key.toLowerCase());
      if (tier) keys.current.rank(tier);
      else if (e.key === 'ArrowRight') keys.current.skip();
      else if (e.key === 'ArrowLeft') keys.current.undo();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Switching between the card and the done screen unmounts the focused button. Put focus on the
  // done screen's main action, or back on the dialog when Undo returns to a card.
  const isDone = !current;
  const focusOnMount = useCallback((el: HTMLElement | null) => el?.focus(), []);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!isDone && dialog && !dialog.contains(document.activeElement)) dialog.focus();
  }, [isDone]);

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
              <p className="sheet-title qr-name">{current.name}</p>
              <p className="muted">
                {[current.house, current.concentration, current.release_year].filter(Boolean).join(' · ')}
              </p>
              {current.accords.length > 0 && (
                <ul className="tags qr-accords" aria-label="Accords">
                  {current.accords.map((a) => <li key={a} className="tag">{a}</li>)}
                </ul>
              )}
              {notesLine && <p className="small qr-notes ellipsis" title={notesLine}>{notesLine}</p>}
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
                <Link ref={focusOnMount} className="btn btn-primary" to={`/r/${api.room!.code}/overlap`} onClick={onClose}>
                  See overlap
                </Link>
              ) : (
                <button ref={focusOnMount} className="btn btn-primary" onClick={onClose}>Done</button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
