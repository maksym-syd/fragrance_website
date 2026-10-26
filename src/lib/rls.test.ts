// Runs supabase/migrations/001_init.sql inside PGlite (real Postgres compiled to WASM)
// on top of a minimal stand-in for Supabase's auth schema and roles, then checks the
// RLS policies by acting as different signed-in users.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const SUPABASE_SHIM = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.email() returns text language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.email', true), '') $$;
  grant usage on schema auth, public to anon, authenticated;
  create publication supabase_realtime;
`;

const OWNER = { id: '00000000-0000-0000-0000-00000000000a', email: 'owner@example.com' };
const FRIEND = { id: '00000000-0000-0000-0000-00000000000b', email: 'friend@example.com' };
const STRANGER = { id: '00000000-0000-0000-0000-00000000000c', email: 'stranger@example.com' };
type User = typeof OWNER;

let db: PGlite;

/** Run queries as `user` (role authenticated, JWT claims set), inside a transaction. */
async function as<T>(user: User, fn: (q: PGlite['query']) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true),
                           set_config('request.jwt.claim.email', $2, true)`, [user.id, user.email]);
    await tx.query('set local role authenticated');
    return fn(tx.query.bind(tx) as PGlite['query']);
  });
}

async function count(user: User, table: string, roomId: string) {
  return as(user, async (q) => {
    const r = await q<{ n: number }>(`select count(*)::int as n from public.${table} where room_id = $1`, [roomId]);
    return r.rows[0].n;
  });
}

let roomId: string;
let fragranceId: string;
let ownerMemberId: string;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_SHIM);
  await db.exec(readFileSync(resolve(__dirname, '../../supabase/migrations/001_init.sql'), 'utf8'));
  for (const u of [OWNER, FRIEND, STRANGER]) {
    await db.query('insert into auth.users (id, email) values ($1, $2)', [u.id, u.email]);
  }

  await as(OWNER, async (q) => {
    const room = await q<{ id: string; code: string }>(`select * from public.create_room('Friends', 'Olivia')`);
    roomId = room.rows[0].id;
    const m = await q<{ id: string }>('select id from public.members where room_id = $1', [roomId]);
    ownerMemberId = m.rows[0].id;
    const f = await q<{ id: string }>(
      `insert into public.fragrances (room_id, name, house, added_by) values ($1, 'Aventus', 'Creed', $2) returning id`,
      [roomId, ownerMemberId],
    );
    fragranceId = f.rows[0].id;
    await q(`insert into public.rankings (room_id, member_id, fragrance_id, tier) values ($1, $2, $3, 'S')`,
      [roomId, ownerMemberId, fragranceId]);
  });
});

describe('RLS: non-invited user', () => {
  it('cannot see the room, its fragrances, rankings, members or invites', async () => {
    const roomVisible = await as(STRANGER, (q) => q('select 1 from public.rooms where id = $1', [roomId]));
    expect(roomVisible.rows).toHaveLength(0);
    expect(await count(STRANGER, 'fragrances', roomId)).toBe(0);
    expect(await count(STRANGER, 'rankings', roomId)).toBe(0);
    expect(await count(STRANGER, 'members', roomId)).toBe(0);
    expect(await count(STRANGER, 'invites', roomId)).toBe(0);
  });

  it('cannot join, add fragrances, or invite themselves', async () => {
    await expect(as(STRANGER, (q) => q(
      `insert into public.members (room_id, display_name) values ($1, 'Sneaky')`, [roomId],
    ))).rejects.toThrow(/row-level security/);
    await expect(as(STRANGER, (q) => q(
      `insert into public.fragrances (room_id, name, house) values ($1, 'X', 'Y')`, [roomId],
    ))).rejects.toThrow(/row-level security/);
    await expect(as(STRANGER, (q) => q(
      `insert into public.invites (room_id, email) values ($1, $2)`, [roomId, STRANGER.email],
    ))).rejects.toThrow(/row-level security/);
  });

  it('cannot update or delete existing data (silently affects 0 rows)', async () => {
    const del = await as(STRANGER, (q) => q('delete from public.fragrances where room_id = $1', [roomId]));
    expect(del.affectedRows).toBe(0);
    const delRoom = await as(STRANGER, (q) => q('delete from public.rooms where id = $1', [roomId]));
    expect(delRoom.affectedRows).toBe(0);
    expect(await count(OWNER, 'fragrances', roomId)).toBe(1);
  });
});

describe('RLS: invited user', () => {
  it('can see the room once invited, but no data until they join', async () => {
    await as(OWNER, (q) => q('insert into public.invites (room_id, email) values ($1, $2)', [roomId, FRIEND.email]));
    const room = await as(FRIEND, (q) => q('select name from public.rooms where id = $1', [roomId]));
    expect(room.rows).toHaveLength(1);
    expect(await count(FRIEND, 'fragrances', roomId)).toBe(0);
  });

  it('can join and then read everything in the room', async () => {
    await as(FRIEND, (q) => q(`insert into public.members (room_id, display_name) values ($1, 'Ken')`, [roomId]));
    expect(await count(FRIEND, 'fragrances', roomId)).toBe(1);
    expect(await count(FRIEND, 'rankings', roomId)).toBe(1);
    expect(await count(FRIEND, 'members', roomId)).toBe(2);
  });

  it("cannot see the invite list or write someone else's ranking", async () => {
    // Only their own invite row is visible.
    expect(await count(FRIEND, 'invites', roomId)).toBe(1);
    await expect(as(FRIEND, (q) => q(
      `insert into public.rankings (room_id, member_id, fragrance_id, tier) values ($1, $2, $3, 'D')
       on conflict (member_id, fragrance_id) do update set tier = excluded.tier`,
      [roomId, ownerMemberId, fragranceId],
    ))).rejects.toThrow(/row-level security/);
  });

  it('cannot invite others or delete the room', async () => {
    await expect(as(FRIEND, (q) => q(
      'insert into public.invites (room_id, email) values ($1, $2)', [roomId, STRANGER.email],
    ))).rejects.toThrow(/row-level security/);
    const del = await as(FRIEND, (q) => q('delete from public.rooms where id = $1', [roomId]));
    expect(del.affectedRows).toBe(0);
  });

  it('can rank for themselves', async () => {
    await as(FRIEND, async (q) => {
      const me = await q<{ id: string }>('select id from public.members where room_id = $1 and user_id = auth.uid()', [roomId]);
      await q(`insert into public.rankings (room_id, member_id, fragrance_id, tier) values ($1, $2, $3, 'B')`,
        [roomId, me.rows[0].id, fragranceId]);
    });
    expect(await count(OWNER, 'rankings', roomId)).toBe(2);
  });

  it('cannot spoof another email when joining', async () => {
    await expect(as(STRANGER, (q) => q(
      `insert into public.members (room_id, email, display_name) values ($1, $2, 'Fake')`, [roomId, FRIEND.email],
    ))).rejects.toThrow(/row-level security/);
  });
});

describe('RLS: revoking an invite', () => {
  it('removes access, membership and rankings immediately', async () => {
    await as(OWNER, (q) => q('delete from public.invites where room_id = $1 and email = $2', [roomId, FRIEND.email]));
    expect(await count(FRIEND, 'fragrances', roomId)).toBe(0);
    const room = await as(FRIEND, (q) => q('select 1 from public.rooms where id = $1', [roomId]));
    expect(room.rows).toHaveLength(0);
    expect(await count(OWNER, 'members', roomId)).toBe(1);
    expect(await count(OWNER, 'rankings', roomId)).toBe(1);
  });
});

describe('RLS: owner', () => {
  it('can delete the room, cascading everything', async () => {
    await as(OWNER, (q) => q('delete from public.rooms where id = $1', [roomId]));
    const left = await db.query<{ n: number }>('select count(*)::int as n from public.fragrances');
    expect(left.rows[0].n).toBe(0);
  });

  it('anonymous (signed-out) role has no table access', async () => {
    await expect(db.transaction(async (tx) => {
      await tx.query('set local role anon');
      await tx.query('select * from public.rooms');
    })).rejects.toThrow(/permission denied/);
  });
});
