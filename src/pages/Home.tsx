import type { User } from '@supabase/supabase-js';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { friendlyError } from '../hooks/useRoom';
import { defaultDisplayName, normalizeCode } from '../lib/normalize';
import { db } from '../lib/supabase';
import type { Room } from '../lib/types';

interface RoomRow extends Room {
  joined: boolean;
}

export default function Home({ user }: { user: User }) {
  const navigate = useNavigate();
  const [rooms, setRooms] = useState<RoomRow[] | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      // RLS returns exactly the rooms you own or are invited to.
      const [r, m] = await Promise.all([
        db().from('rooms').select('*').order('created_at', { ascending: false }),
        db().from('members').select('room_id').eq('user_id', user.id),
      ]);
      const joined = new Set((m.data ?? []).map((x) => x.room_id as string));
      setRooms(((r.data ?? []) as Room[]).map((room) => ({ ...room, joined: joined.has(room.id) })));
    })();
  }, [user.id]);

  async function createRoom(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError('');
    const { data, error: err } = await db().rpc('create_room', {
      p_name: name.trim(),
      p_display_name: defaultDisplayName(user),
    });
    setBusy(false);
    if (err) return setError(friendlyError(err));
    navigate(`/r/${(data as Room).code}/members`);
  }

  function joinRoom(e: FormEvent) {
    e.preventDefault();
    const c = normalizeCode(code);
    if (c.length === 6) navigate(`/r/${c}`);
  }

  return (
    <div className="stack-lg">
      <section className="home-hero">
        <p className="eyebrow">Hello, {defaultDisplayName(user)}</p>
        <h1 className="display">Where do your noses agree?</h1>
      </section>

      <section className="home-grid">
        <form className="card stack-sm" onSubmit={createRoom}>
          <h2 className="h2">Start a room</h2>
          <p className="muted small">You’ll be the owner and can invite friends by email.</p>
          <label className="label" htmlFor="room-name">Room name</label>
          <input
            id="room-name"
            placeholder="e.g. Thursday Sniff Club"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="btn btn-primary" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create room'}
          </button>
          {error && <p className="error" role="alert">{error}</p>}
        </form>

        <form className="card stack-sm" onSubmit={joinRoom}>
          <h2 className="h2">Join with a code</h2>
          <p className="muted small">The owner must have invited <strong>{user.email}</strong>.</p>
          <label className="label" htmlFor="room-code">Room code</label>
          <input
            id="room-code"
            className="code-input"
            placeholder="K7P2QX"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(normalizeCode(e.target.value))}
          />
          <button className="btn" disabled={code.length !== 6}>Open room</button>
        </form>
      </section>

      <section className="stack-sm">
        <h2 className="h2">Your rooms</h2>
        {rooms === null ? (
          <p className="muted">Loading…</p>
        ) : rooms.length === 0 ? (
          <p className="muted">No rooms yet. Create one above, or ask a friend to invite {user.email}.</p>
        ) : (
          <ul className="room-list">
            {rooms.map((r) => (
              <li key={r.id}>
                <Link to={`/r/${r.code}`} className="room-link">
                  <span className="room-link-name">{r.name}</span>
                  <span className="mono muted small">{r.code}</span>
                  {r.owner_id === user.id ? (
                    <span className="pill">Owner</span>
                  ) : !r.joined ? (
                    <span className="pill pill-accent">Invited</span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
