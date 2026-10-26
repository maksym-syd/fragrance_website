import { useEffect, useRef, useState } from 'react';
import type { RoomApi } from '../hooks/useRoom';
import { TIERS } from '../lib/overlap';
import { TIER_LABEL } from '../lib/tiers';
import type { Fragrance, Tier } from '../lib/types';
import { TierLetter } from './ui';

/** Bottom sheet on mobile, centered dialog on desktop. */
export default function TierSheet({ api, fragrance, onClose }: { api: RoomApi; fragrance: Fragrance; onClose: () => void }) {
  const me = api.me!;
  const [confirmRemove, setConfirmRemove] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);

  const mine = api.rankings.find((r) => r.member_id === me.id && r.fragrance_id === fragrance.id)?.tier ?? null;
  const others = api.members
    .filter((m) => m.id !== me.id)
    .map((m) => ({ m, tier: api.rankings.find((r) => r.member_id === m.id && r.fragrance_id === fragrance.id)?.tier ?? null }))
    .filter((x) => x.tier);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    sheetRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  function choose(tier: Tier | null) {
    api.setTier(fragrance.id, tier);
    onClose();
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        ref={sheetRef}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-grip" aria-hidden />
        <header className="sheet-head">
          <div>
            <h2 id="sheet-title" className="sheet-title">{fragrance.name}</h2>
            <p className="muted small">
              {fragrance.house}
              {fragrance.concentration && <> · {fragrance.concentration}</>}
            </p>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close">×</button>
        </header>

        {fragrance.notes.length > 0 && (
          <div className="tags">
            {fragrance.notes.map((n) => <span key={n} className="tag">{n}</span>)}
          </div>
        )}

        <div className="tier-buttons">
          {TIERS.map((t) => (
            <button
              key={t}
              className={`tier-button tier-${t.toLowerCase()} ${mine === t ? 'is-current' : ''}`}
              onClick={() => choose(t)}
              aria-pressed={mine === t}
            >
              <span className="tier-button-letter">{t}</span>
              <span className="tier-button-caption">{TIER_LABEL[t]}</span>
            </button>
          ))}
        </div>
        <button className={`btn btn-block ${mine === null ? 'is-current-plain' : ''}`} onClick={() => choose(null)}>
          Haven’t tried
        </button>

        {others.length > 0 && (
          <div className="sheet-others">
            <span className="label">Friends</span>
            <div className="row-wrap">
              {others.map(({ m, tier }) => (
                <span key={m.id} className="other-rank">
                  <TierLetter tier={tier} size="sm" /> {m.display_name}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="sheet-danger">
          {confirmRemove ? (
            <div className="confirm" role="alertdialog">
              <p className="confirm-prompt">
                Remove <strong>{fragrance.name}</strong> from the room? Everyone’s rankings of it are deleted too.
              </p>
              <div className="confirm-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirmRemove(false)}>Keep it</button>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => {
                    api.removeFragrance(fragrance.id);
                    onClose();
                  }}
                >
                  Remove for everyone
                </button>
              </div>
            </div>
          ) : (
            <button className="btn-link danger" onClick={() => setConfirmRemove(true)}>Remove for everyone…</button>
          )}
        </div>
      </div>
    </div>
  );
}
