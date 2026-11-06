import { useEffect, useRef, useState } from 'react';
import type { RoomApi } from '../hooks/useRoom';
import { draftFromFragrance, otherNotes } from '../lib/details';
import { TIERS } from '../lib/overlap';
import { TIER_LABEL } from '../lib/tiers';
import type { Fragrance, FragrancePatch, Tier } from '../lib/types';
import FragranceForm from './FragranceForm';
import { TierLetter } from './ui';

function TagRow({ label, tags }: { label: string; tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <div className="detail-row">
      <span className="label">{label}</span>
      <div className="tags">{tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>
    </div>
  );
}

/** Accords, then the pyramid. Old rows with only flat notes show those under a plain heading. */
function FragranceDetails({ fragrance: f, onEdit }: { fragrance: Fragrance; onEdit: () => void }) {
  const other = otherNotes(f);
  const hasPyramid = f.notes_top.length + f.notes_heart.length + f.notes_base.length > 0;
  const hasAny = hasPyramid || other.length > 0 || f.accords.length > 0 || f.perfumers.length > 0;
  return (
    <div className="details">
      {f.perfumers.length > 0 && (
        <p className="small"><span className="muted">{f.perfumers.length > 1 ? 'Perfumers' : 'Perfumer'}</span> {f.perfumers.join(', ')}</p>
      )}
      <TagRow label="Accords" tags={f.accords} />
      <TagRow label="Top notes" tags={f.notes_top} />
      <TagRow label="Heart notes" tags={f.notes_heart} />
      <TagRow label="Base notes" tags={f.notes_base} />
      <TagRow label={hasPyramid ? 'Other notes' : 'Notes'} tags={other} />
      <button type="button" className="btn-link small" onClick={onEdit}>
        {hasAny ? 'Edit details' : 'Add details'}
      </button>
    </div>
  );
}

/** Bottom sheet on mobile, centered dialog on desktop. */
export default function TierSheet({ api, fragrance, onClose }: { api: RoomApi; fragrance: Fragrance; onClose: () => void }) {
  const me = api.me!;
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const escape = useRef(onClose);
  escape.current = editing ? () => setEditing(false) : onClose;

  const mine = api.rankings.find((r) => r.member_id === me.id && r.fragrance_id === fragrance.id)?.tier ?? null;
  const others = api.members
    .filter((m) => m.id !== me.id)
    .map((m) => ({ m, tier: api.rankings.find((r) => r.member_id === m.id && r.fragrance_id === fragrance.id)?.tier ?? null }))
    .filter((x) => x.tier);

  // Runs once. onClose is a new function on each parent render, and re-running this would pull
  // focus out of the edit form whenever a realtime update arrived.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && escape.current();
    document.addEventListener('keydown', onKey);
    sheetRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, []);

  async function saveEdit(patch: FragrancePatch) {
    setEditError(null);
    const res = await api.updateFragrance(fragrance.id, patch);
    if (res.ok) setEditing(false);
    else setEditError(res.message ?? 'Could not save');
    return res.ok;
  }

  function choose(tier: Tier | null) {
    api.setTier(fragrance.id, tier);
    onClose();
  }

  return (
    <div className="sheet-backdrop" onClick={() => !editing && onClose()}>
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
              {fragrance.release_year && <> · {fragrance.release_year}</>}
            </p>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close">×</button>
        </header>

        {editing ? (
          <>
            <FragranceForm
              idPrefix="edit"
              fragrances={api.fragrances}
              initial={draftFromFragrance(fragrance)}
              editingId={fragrance.id}
              submitLabel="Save changes"
              busyLabel="Saving…"
              onSubmit={saveEdit}
              onCancel={() => setEditing(false)}
            />
            {editError && <p className="error small" role="alert">{editError}</p>}
          </>
        ) : (
          <>
            <FragranceDetails fragrance={fragrance} onEdit={() => setEditing(true)} />

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

            {api.isOwner && (
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
            )}
          </>
        )}
      </div>
    </div>
  );
}
