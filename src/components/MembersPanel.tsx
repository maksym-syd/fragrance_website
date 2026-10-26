import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RoomApi } from '../hooks/useRoom';
import { isEmail, normalizeEmail } from '../lib/normalize';
import { ConfirmButton, CopyButton } from './ui';

export default function MembersPanel({ api }: { api: RoomApi }) {
  const room = api.room!;
  const me = api.me!;
  const owner = api.members.find((m) => m.user_id === room.owner_id);
  const link = `${window.location.origin}/r/${room.code}`;

  return (
    <div className="members-layout">
      <div className="stack">
        <NameEditor api={api} />

        <section className="card stack-sm">
          <h2 className="h2">Share</h2>
          <p className="muted small">
            Only people on the invite list can open this link{api.isOwner ? '' : `. ${owner?.display_name ?? 'The owner'} manages the list`}.
          </p>
          <div className="share-row">
            <code className="share-link ellipsis">{link}</code>
            <CopyButton text={link} label="Copy link" />
          </div>
        </section>

        <section className="stack-sm">
          <h2 className="h2">Members</h2>
          <ul className="member-list">
            {api.members.map((m) => (
              <li key={m.id} className="member">
                <span className="avatar" aria-hidden>{m.display_name.slice(0, 1).toUpperCase()}</span>
                <span className="member-text">
                  <span>
                    {m.display_name}
                    {m.id === me.id && <span className="muted"> (you)</span>}
                  </span>
                  {api.isOwner && <span className="muted fine mono ellipsis">{m.email}</span>}
                </span>
                {m.user_id === room.owner_id && <span className="pill">Owner</span>}
              </li>
            ))}
          </ul>
        </section>
      </div>

      {api.isOwner && (
        <div className="stack">
          <InviteManager api={api} />
          <DangerZone api={api} />
        </div>
      )}
    </div>
  );
}

function NameEditor({ api }: { api: RoomApi }) {
  const [name, setName] = useState(api.me!.display_name);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const changed = name.trim() !== api.me!.display_name && name.trim().length > 0;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const res = await api.rename(name);
    setMsg(res.ok ? { kind: 'success', text: 'Name updated' } : { kind: 'error', text: res.message ?? 'Could not rename' });
  }

  return (
    <form className="card stack-sm" onSubmit={onSubmit}>
      <h2 className="h2">Your name here</h2>
      <div className="share-row">
        <input aria-label="Display name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        <button className="btn" disabled={!changed}>Save</button>
      </div>
      {msg && <p className={`${msg.kind} small`} role="status">{msg.text}</p>}
    </form>
  );
}

function InviteManager({ api }: { api: RoomApi }) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const joined = new Set(api.members.map((m) => m.email));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const clean = normalizeEmail(email);
    if (!isEmail(clean)) return setError('Enter a valid email');
    setError('');
    const res = await api.addInvite(clean);
    if (res.ok) setEmail('');
    else setError(res.message ?? 'Could not invite');
  }

  return (
    <section className="card stack-sm">
      <h2 className="h2">Invites</h2>
      <p className="muted small">
        Add the email each friend signs in with (Google or magic link). Then send them the room link.
      </p>
      <form className="share-row" onSubmit={onSubmit}>
        <input
          type="email"
          inputMode="email"
          aria-label="Friend’s email"
          placeholder="friend@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button className="btn btn-primary">Invite</button>
      </form>
      {error && <p className="error small" role="alert">{error}</p>}

      {api.invites.length === 0 ? (
        <p className="muted small">No one invited yet.</p>
      ) : (
        <ul className="invite-list">
          {api.invites.map((inv) => (
            <li key={inv.email} className="invite">
              <div className="invite-main">
                <span className="mono small ellipsis">{inv.email}</span>
                <span className={`pill ${joined.has(inv.email) ? '' : 'pill-accent'}`}>
                  {joined.has(inv.email) ? 'Joined' : 'Pending'}
                </span>
              </div>
              <ConfirmButton
                label="Remove"
                confirmLabel="Remove access"
                className="btn-link danger small"
                prompt={
                  joined.has(inv.email) ? (
                    <>They’ll lose access immediately and <strong>their rankings will be deleted</strong>.</>
                  ) : (
                    <>Remove this invite?</>
                  )
                }
                onConfirm={() => api.removeInvite(inv.email)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DangerZone({ api }: { api: RoomApi }) {
  const navigate = useNavigate();
  return (
    <section className="card card-danger stack-sm">
      <h2 className="h2">Delete room</h2>
      <p className="muted small">Removes every fragrance, ranking and invite for everyone. This can’t be undone.</p>
      <ConfirmButton
        label="Delete this room…"
        confirmLabel="Delete forever"
        prompt={<>Delete <strong>{api.room!.name}</strong> for everyone?</>}
        onConfirm={async () => {
          const res = await api.deleteRoom();
          if (res.ok) navigate('/', { replace: true });
        }}
      />
    </section>
  );
}
