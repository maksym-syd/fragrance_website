import type { User } from '@supabase/supabase-js';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import AddFragrance from '../components/AddFragrance';
import MembersPanel from '../components/MembersPanel';
import MyTiers from '../components/MyTiers';
import Overlap from '../components/Overlap';
import TierSheet from '../components/TierSheet';
import { CopyButton, useDocumentTitle } from '../components/ui';
import { signOut } from '../hooks/useAuth';
import { useRoom, type Notice, type RoomApi, type SaveStatus } from '../hooks/useRoom';
import { defaultDisplayName, normalizeCode } from '../lib/normalize';
import { NOTICE_MS } from '../lib/roomState';

export default function RoomPage({ user }: { user: User }) {
  const params = useParams();
  const code = normalizeCode(params.code ?? '');
  const api = useRoom(code, user);
  useDocumentTitle(roomTitle(api, useLocation().pathname));

  if (api.status === 'loading') return <RoomSkeleton />;
  if (api.status === 'not-invited') return <JoinByCode api={api} user={user} code={code} />;
  // Only a failed first load gets here; later failures keep the room and show StaleBanner.
  if (api.status === 'error') {
    return (
      <div className="narrow center-page stack-sm">
        <h1 className="display">Couldn’t open this room</h1>
        <p className="error" role="alert">{api.error}</p>
        <div className="row-wrap">
          <button className="btn btn-primary" onClick={() => api.reload()}>Try again</button>
          <Link className="btn btn-ghost" to="/">Back home</Link>
        </div>
      </div>
    );
  }
  if (api.status === 'join') return <JoinRoom api={api} user={user} />;
  return <RoomView api={api} />;
}

const SECTION_TITLE: Record<string, string> = { overlap: 'Overlap', add: 'Add', members: 'Members' };

function roomTitle(api: RoomApi, pathname: string) {
  if (api.status === 'loading') return undefined;
  if (!api.room || api.status !== 'ready') return 'Join room';
  const section = SECTION_TITLE[pathname.split('/')[3] ?? ''] ?? 'My tiers';
  return `${section} – ${api.room.name}`;
}

/** Same boxes as the loaded room, so the page doesn't jump when the data lands. */
function RoomSkeleton() {
  return (
    <div className="room" aria-busy="true">
      <p className="sr-only" role="status">Opening room…</p>
      <header className="room-head" aria-hidden>
        <span className="skeleton display" style={{ height: '1.05em', width: '70%' }} />
        <span className="skeleton skeleton-text" style={{ '--w': '45%' } as React.CSSProperties} />
      </header>
      <div className="tier-board" aria-hidden>
        {['s', 'a', 'b', 'c', 'd'].map((t) => (
          <div key={t} className="tier-row">
            <div className="tier-label skeleton" />
            <div className="tier-items">
              <span className="chip skeleton" style={{ width: '42%' }} />
              <span className="chip skeleton" style={{ width: '30%' }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RoomView({ api }: { api: RoomApi }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const closeSheet = useCallback(() => {
    // The chip may have moved to another row (a new element), so find it by id, not by reference.
    const id = openId;
    setOpenId(null);
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-frag-id="${id}"]`)?.focus({ preventScroll: true }),
    );
  }, [openId]);
  const room = api.room!;
  const base = `/r/${room.code}`;
  const open = openId ? api.fragrances.find((f) => f.id === openId) ?? null : null;

  return (
    <div className="room">
      <header className="room-head">
        <h1 className="display">{room.name}</h1>
        <div className="room-meta">
          <span className="code-chip mono" aria-label="Room code">{room.code}</span>
          <span className="muted small">
            {api.members.length} {api.members.length === 1 ? 'member' : 'members'} · {api.fragrances.length}{' '}
            {api.fragrances.length === 1 ? 'fragrance' : 'fragrances'}
          </span>
        </div>
        <nav className="tabs" aria-label="Room sections">
          <NavLink end to={base} className="tab">My tiers</NavLink>
          <NavLink to={`${base}/overlap`} className="tab">Overlap</NavLink>
          <NavLink to={`${base}/add`} className="tab">Add</NavLink>
          <NavLink to={`${base}/members`} className="tab">Members</NavLink>
        </nav>
      </header>

      {api.stale && <StaleBanner onRetry={api.reload} />}

      <Routes>
        <Route index element={<MyTiers api={api} onOpen={setOpenId} />} />
        <Route path="overlap" element={<Overlap api={api} onOpen={setOpenId} />} />
        <Route path="add" element={<AddFragrance api={api} onOpen={setOpenId} />} />
        <Route path="members" element={<MembersPanel api={api} />} />
        <Route path="*" element={<Navigate to={base} replace />} />
      </Routes>

      {/* One slot at the bottom: a toast wins over the Saving…/Saved pill, which it replaces. */}
      {api.notice ? (
        <Toast key={api.notice.id} notice={api.notice} onDismiss={api.dismissNotice} />
      ) : (
        <SaveIndicator status={api.save === 'error' ? 'idle' : api.save} />
      )}
      {open && <TierSheet api={api} fragrance={open} onClose={closeSheet} />}
    </div>
  );
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  const text = { idle: '', saving: 'Saving…', saved: 'Saved', error: 'Couldn’t save' }[status];
  return (
    <span className={`save-status save-${status}`} role="status" aria-live="polite">
      {text}
    </span>
  );
}

/** The room loaded once, but the latest refetch failed. Keep showing it, and say so. */
function StaleBanner({ onRetry }: { onRetry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="stale-banner" role="status">
      <span>Connection lost. Showing the last saved data.</span>
      <button
        type="button"
        className="btn-link"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await onRetry();
          setBusy(false);
        }}
      >
        {busy ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  );
}

/**
 * "Unranked Aventus · Undo" or "Couldn't move Aventus to S · Retry". Clears itself after
 * NOTICE_MS, but not while the pointer or focus is on it, so there's time to reach the button.
 */
function Toast({ notice, onDismiss }: { notice: Notice; onDismiss: (id?: number) => void }) {
  const [held, setHeld] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (held) return;
    const t = window.setTimeout(() => onDismiss(notice.id), NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [notice.id, held, onDismiss]);

  const isError = notice.tone === 'error';
  return (
    <div
      ref={ref}
      className={`toast ${isError ? 'toast-error' : ''}`}
      role={isError ? 'alert' : 'status'}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => !ref.current?.contains(e.relatedTarget as Node | null) && setHeld(false)}
    >
      <span className="toast-text">{notice.text}</span>
      {notice.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            onDismiss(notice.id);
            notice.action!.run();
          }}
        >
          {notice.action.label}
        </button>
      )}
      <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => onDismiss(notice.id)}>
        ×
      </button>
    </div>
  );
}

/** Shown when RLS hides the room from you: try joining with the code, fall back to "not invited". */
function JoinByCode({ api, user, code }: { api: RoomApi; user: User; code: string }) {
  const [name, setName] = useState(defaultDisplayName(user));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [inviteOnly, setInviteOnly] = useState(false);

  if (inviteOnly) return <NotInvited email={user.email ?? ''} code={code} />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const res = await api.joinByCode(name);
    setBusy(false);
    if (res.inviteOnly) setInviteOnly(true);
    else if (!res.ok) setError(res.message ?? 'Could not join');
  }

  return (
    <form className="narrow center-page stack-sm" onSubmit={onSubmit}>
      <p className="eyebrow">Room <span className="mono">{code}</span></p>
      <h1 className="display">Join this room</h1>
      <p className="muted">
        Your tiers are saved to your account (<span className="email">{user.email}</span>), so they’ll be here on any device.
      </p>
      <label className="label" htmlFor="code-display-name">Display name</label>
      <input id="code-display-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} required />
      <button className="btn btn-primary" disabled={busy || !name.trim()}>
        {busy ? 'Joining…' : 'Join room'}
      </button>
      {error && <p className="error" role="alert">{error}</p>}
      <Link to="/" className="btn btn-ghost">Back home</Link>
    </form>
  );
}

function NotInvited({ email, code }: { email: string; code: string }) {
  return (
    <div className="narrow center-page stack-sm">
      <p className="eyebrow">Room <span className="mono">{code}</span></p>
      <h1 className="display">You’re not invited to this room</h1>
      <p className="muted small">This room is invite-only (or the code is wrong).</p>
      <p className="lede">
        Ask the owner to add <strong className="email">{email}</strong> on their Members page, then reload.
      </p>
      <div className="row-wrap">
        <CopyButton text={email} label="Copy my email" className="btn" />
        <button className="btn btn-ghost" onClick={() => window.location.reload()}>Reload</button>
        <button className="btn btn-ghost" onClick={() => signOut()}>Use another account</button>
        <Link className="btn btn-ghost" to="/">Home</Link>
      </div>
    </div>
  );
}

function JoinRoom({ api, user }: { api: RoomApi; user: User }) {
  const [name, setName] = useState(defaultDisplayName(user));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await api.join(name);
    setBusy(false);
    if (!res.ok) setError(res.message ?? 'Could not join');
  }

  return (
    <form className="narrow center-page stack-sm" onSubmit={onSubmit}>
      <p className="eyebrow">You’re invited</p>
      <h1 className="display">{api.room!.name}</h1>
      <p className="muted">Pick how your friends will see you. You can change it later.</p>
      <label className="label" htmlFor="display-name">Display name</label>
      <input id="display-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} required />
      <button className="btn btn-primary" disabled={busy || !name.trim()}>
        {busy ? 'Joining…' : 'Join room'}
      </button>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}
