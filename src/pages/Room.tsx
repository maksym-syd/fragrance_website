import type { User } from '@supabase/supabase-js';
import { useState, type FormEvent } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useParams } from 'react-router-dom';
import AddFragrance from '../components/AddFragrance';
import MembersPanel from '../components/MembersPanel';
import MyTiers from '../components/MyTiers';
import Overlap from '../components/Overlap';
import TierSheet from '../components/TierSheet';
import { CopyButton } from '../components/ui';
import { signOut } from '../hooks/useAuth';
import { useRoom, type RoomApi, type SaveStatus } from '../hooks/useRoom';
import { defaultDisplayName, normalizeCode } from '../lib/normalize';

export default function RoomPage({ user }: { user: User }) {
  const params = useParams();
  const code = normalizeCode(params.code ?? '');
  const api = useRoom(code, user);

  if (api.status === 'loading') return <p className="muted pad">Opening room…</p>;
  if (api.status === 'not-invited') return <NotInvited email={user.email ?? ''} code={code} />;
  if (api.status === 'error') {
    return (
      <div className="card narrow">
        <p className="error">{api.error}</p>
        <button className="btn" onClick={() => api.reload()}>Try again</button>
      </div>
    );
  }
  if (api.status === 'join') return <JoinRoom api={api} user={user} />;
  return <RoomView api={api} />;
}

function RoomView({ api }: { api: RoomApi }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const room = api.room!;
  const base = `/r/${room.code}`;
  const open = openId ? api.fragrances.find((f) => f.id === openId) ?? null : null;

  return (
    <div className="room">
      <header className="room-head">
        <div className="room-title-row">
          <h1 className="display room-title">{room.name}</h1>
          <SaveIndicator status={api.save} />
        </div>
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

      <Routes>
        <Route index element={<MyTiers api={api} onOpen={setOpenId} />} />
        <Route path="overlap" element={<Overlap api={api} onOpen={setOpenId} />} />
        <Route path="add" element={<AddFragrance api={api} onOpen={setOpenId} />} />
        <Route path="members" element={<MembersPanel api={api} />} />
        <Route path="*" element={<Navigate to={base} replace />} />
      </Routes>

      {open && <TierSheet api={api} fragrance={open} onClose={() => setOpenId(null)} />}
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

function NotInvited({ email, code }: { email: string; code: string }) {
  return (
    <div className="narrow center-page stack-sm">
      <p className="eyebrow mono">Room {code}</p>
      <h1 className="display">You’re not invited to this room</h1>
      <p className="lede">
        Ask the owner to add <strong className="email">{email}</strong> on their Members page, then reload.
      </p>
      <p className="muted small">If the code is mistyped, this room may not exist at all — we can’t tell you which.</p>
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
