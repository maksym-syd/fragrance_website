// Migration 005 (audit log), run for real in PGlite. Never touches Supabase.
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const SHIM = `
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
type User = typeof OWNER;

let db: PGlite;
let roomId: string;
let fragranceId: string;
let friendMemberId: string;

async function as<T>(user: User, fn: (q: PGlite['query']) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.email', $2, true)`, [user.id, user.email]);
    await tx.query('set local role authenticated');
    return fn(tx.query.bind(tx) as PGlite['query']);
  });
}

const logged = async (table: string, op = 'DELETE') =>
  (await db.query<{ old_row: Record<string, unknown>; actor: string | null }>(
    'select old_row, actor from public.audit_log where table_name = $1 and op = $2 order by id', [table, op])).rows;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(SHIM);
  const dir = resolve(__dirname, '../../supabase/migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(readFileSync(resolve(dir, f), 'utf8'));
  for (const u of [OWNER, FRIEND]) await db.query('insert into auth.users (id, email) values ($1, $2)', [u.id, u.email]);
  await as(OWNER, async (q) => {
    roomId = (await q<{ id: string }>(`select * from public.create_room('Club', 'Olivia')`)).rows[0].id;
    await q('insert into public.invites (room_id, email) values ($1, $2)', [roomId, FRIEND.email]);
  });
  await as(FRIEND, async (q) => {
    await q(`insert into public.members (room_id, display_name) values ($1, 'Ken')`, [roomId]);
    friendMemberId = (await q<{ id: string }>('select id from public.members where user_id = auth.uid()')).rows[0].id;
    fragranceId = (await q<{ id: string }>(`insert into public.fragrances (room_id, name, house, added_by) values ($1, 'Aventus', 'Creed', $2) returning id`, [roomId, friendMemberId])).rows[0].id;
    await q(`insert into public.rankings (room_id, member_id, fragrance_id, tier) values ($1, $2, $3, 'S')`, [roomId, friendMemberId, fragranceId]);
  });
  await as(OWNER, async (q) => {
    const me = (await q<{ id: string }>('select id from public.members where user_id = auth.uid()')).rows[0].id;
    await q(`insert into public.rankings (room_id, member_id, fragrance_id, tier) values ($1, $2, $3, 'A')`, [roomId, me, fragranceId]);
  });
});

describe('migration 005: audit log', () => {
  it('room delete logs the room and every cascaded row, with the actor', async () => {
    await as(OWNER, (q) => q('delete from public.rooms where id = $1', [roomId]));
    expect((await logged('rooms')).map((r) => r.old_row.id)).toEqual([roomId]);
    expect(await logged('invites')).toHaveLength(1);
    expect(await logged('members')).toHaveLength(2);
    expect(await logged('fragrances')).toHaveLength(1);
    expect(await logged('rankings')).toHaveLength(2);
    expect((await logged('rooms'))[0].actor).toBe(OWNER.id);
    expect((await logged('fragrances'))[0].old_row).toMatchObject({ name: 'Aventus', house: 'Creed' });
  });

  it('fragrance update logs the old row', async () => {
    await as(FRIEND, (q) => q(`update public.fragrances set name = 'Aventus Cologne' where id = $1`, [fragranceId]));
    const rows = await logged('fragrances', 'UPDATE');
    expect(rows).toHaveLength(1);
    expect(rows[0].old_row).toMatchObject({ id: fragranceId, name: 'Aventus' });
    expect(rows[0].actor).toBe(FRIEND.id);
  });

  it('uninvite trigger path logs the member and their rankings', async () => {
    await as(OWNER, (q) => q('delete from public.invites where room_id = $1 and email = $2', [roomId, FRIEND.email]));
    expect(await logged('invites')).toHaveLength(1);
    expect((await logged('members')).map((r) => r.old_row.id)).toEqual([friendMemberId]);
    expect((await logged('rankings')).map((r) => r.old_row.member_id)).toEqual([friendMemberId]);
  });

  it('a logged row can be restored with jsonb_populate_record', async () => {
    await as(OWNER, (q) => q('delete from public.rooms where id = $1', [roomId]));
    for (const t of ['rooms', 'members', 'invites', 'fragrances', 'rankings']) {
      await db.exec(`insert into public.${t} select (jsonb_populate_record(null::public.${t}, old_row)).*
                     from public.audit_log where table_name = '${t}' and op = 'DELETE'`);
    }
    expect((await db.query('select * from public.rankings')).rows).toHaveLength(2);
  });

  it('migration 006 targets the right default constraint name', async () => {
    const r = await db.query<{ conname: string; confdeltype: string }>(
      `select conname, confdeltype from pg_constraint where conrelid = 'public.rooms'::regclass and contype = 'f'`);
    expect(r.rows).toEqual([{ conname: 'rooms_owner_id_fkey', confdeltype: 'r' }]);
  });

  it('migration 006: deleting an auth user who owns a room fails and keeps all data', async () => {
    const counts = async () => (await db.query(`select (select count(*) from public.rooms) r, (select count(*) from public.members) m,
      (select count(*) from public.fragrances) f, (select count(*) from public.rankings) k, (select count(*) from public.invites) i`)).rows[0];
    const before = await counts();
    await expect(db.query('delete from auth.users where id = $1', [OWNER.id])).rejects.toThrow(/foreign key/);
    expect(await counts()).toEqual(before);
  });

  it('migration 006: deleting a non-owner still cascades their member rows and rankings (unchanged)', async () => {
    await db.query('delete from auth.users where id = $1', [FRIEND.id]);
    expect((await db.query('select * from public.members where id = $1', [friendMemberId])).rows).toHaveLength(0);
    expect((await db.query('select * from public.rankings where member_id = $1', [friendMemberId])).rows).toHaveLength(0);
    expect((await db.query('select * from public.rooms')).rows).toHaveLength(1);
    expect((await logged('members')).map((r) => r.old_row.id)).toEqual([friendMemberId]);
  });

  it('authenticated users cannot read or write audit_log', async () => {
    await as(OWNER, (q) => q('delete from public.rankings where room_id = $1 and member_id <> $2', [roomId, friendMemberId]));
    for (const stmt of [
      'select * from public.audit_log',
      `insert into public.audit_log (table_name, op, old_row) values ('x', 'DELETE', '{}')`,
      `update public.audit_log set op = 'DELETE'`,
      'delete from public.audit_log',
    ]) {
      await expect(as(OWNER, (q) => q(stmt))).rejects.toThrow(/permission denied/);
    }
    await expect(as(OWNER, (q) => q('select public.audit_old_row()'))).rejects.toThrow();
    expect(await logged('rankings')).toHaveLength(1);
  });
});
