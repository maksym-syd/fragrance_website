// npm run restore's logic, run for real on PGlite with every migration. Never touches Supabase.
import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  auditSource, parseRestoreArgs, PK, restore, restoreReport, RESTORE_TABLES,
  type AuditRow, type Live, type RestoreOptions, type RestoreStore, type Row, type Table,
} from '../../scripts/lib/restore';

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
const KEN = { id: '00000000-0000-0000-0000-00000000000b', email: 'ken@example.com' };
const MIA = { id: '00000000-0000-0000-0000-00000000000c', email: 'mia@example.com' };
const NEWBIE = { id: '00000000-0000-0000-0000-00000000000d', email: 'newbie@example.com' };
type User = typeof OWNER;

let db: PGlite;
let code: string;
let roomId: string;
let t0: string;

async function as<T>(user: User, fn: (q: PGlite['query']) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.email', $2, true)`, [user.id, user.email]);
    await tx.query('set local role authenticated');
    return fn(tx.query.bind(tx) as PGlite['query']);
  });
}

const one = async <T,>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const memberId = async (name: string) => (await one<{ id: string }>('select id from public.members where display_name = $1', [name])).id;
const fragId = async (name: string) => (await one<{ id: string }>('select id from public.fragrances where name = $1', [name])).id;

/** Every app table as sorted JSON, for exact before/after comparisons. */
async function snapshot() {
  const out: Record<string, unknown[]> = {};
  for (const t of RESTORE_TABLES) {
    const order = PK[t].join(', ');
    out[t] = (await db.query<{ j: unknown }>(`select to_jsonb(x) as j from public.${t} x order by ${order}`)).rows.map((r) => r.j);
  }
  return out;
}

function pgliteStore(handle: Pick<PGlite, 'query'> = db): RestoreStore & { backups: number } {
  const rows = async (sql: string, params: unknown[]) => (await handle.query<{ j: Row }>(sql, params)).rows.map((r) => r.j);
  const store: RestoreStore & { backups: number } = {
    backups: 0,
    async auditRows(since, until) {
      const r = await handle.query<AuditRow>(
        `select id::int as id, table_name, op, old_row from public.audit_log where at >= $1 and ($2::timestamptz is null or at < $2) order by id`,
        [since, until ?? null],
      );
      return r.rows;
    },
    async live(c, id): Promise<Live> {
      const byCode = (await rows('select to_jsonb(r) as j from public.rooms r where code = $1', [c]))[0] ?? null;
      const rid = id ?? (byCode?.id as string | undefined);
      if (!rid) return { roomByCode: null, room: null, invites: [], members: [], fragrances: [], rankings: [] };
      const child = (t: string) => rows(`select to_jsonb(x) as j from public.${t} x where room_id = $1`, [rid]);
      return {
        roomByCode: byCode,
        room: (await rows('select to_jsonb(r) as j from public.rooms r where id = $1', [rid]))[0] ?? null,
        invites: await child('invites'),
        members: await child('members'),
        fragrances: await child('fragrances'),
        rankings: await child('rankings'),
      };
    },
    async existingUsers(ids) {
      const r = await handle.query<{ id: string }>('select id::text from auth.users where id = any($1::uuid[])', [ids]);
      return new Set(r.rows.map((x) => x.id));
    },
    async insert(table: Table, list: Row[]) {
      let n = 0;
      for (const row of list) {
        const cols = Object.keys(row).join(', ');
        const r = await handle.query(
          `insert into public.${table} (${cols}) select ${cols} from jsonb_populate_record(null::public.${table}, $1::jsonb) on conflict do nothing returning 1`,
          [JSON.stringify(row)],
        );
        n += r.rows.length;
      }
      return n;
    },
    async backup() {
      store.backups++;
      return 'exports/backup-test';
    },
    transaction: (fn) => db.transaction((tx) => fn({ ...pgliteStore(tx), backup: store.backup })),
  };
  return store;
}

const opts = (o: Partial<RestoreOptions>): RestoreOptions => ({ fromAudit: !o.from, since: t0, room: code, apply: false, ...o });

/** Writes the database to a folder shaped exactly like `npm run backup` output. */
async function backupFixture(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'restore-test-'));
  const tables: Record<string, { rows: number; sha256: string }> = {};
  for (const t of [...RESTORE_TABLES, 'audit_log']) {
    const list = (await db.query<{ j: unknown }>(`select to_jsonb(x) as j from public.${t} x`)).rows.map((r) => r.j);
    const body = JSON.stringify(list, null, 2);
    writeFileSync(join(dir, `${t}.json`), body);
    tables[t] = { rows: list.length, sha256: createHash('sha256').update(body).digest('hex') };
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ created_at: new Date().toISOString(), project: 'test', tables }));
  return dir;
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(SHIM);
  const dir = resolve(__dirname, '../../supabase/migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(readFileSync(resolve(dir, f), 'utf8'));
  for (const u of [OWNER, KEN, MIA, NEWBIE]) await db.query('insert into auth.users (id, email) values ($1, $2)', [u.id, u.email]);

  const room = await as(OWNER, (q) => q<{ id: string; code: string }>(`select * from public.create_room('Sniff Club', 'Olivia')`));
  ({ id: roomId, code } = room.rows[0]);
  await as(OWNER, (q) => q('insert into public.invites (room_id, email) values ($1, $2), ($1, $3)', [roomId, KEN.email, MIA.email]));
  await as(KEN, (q) => q(`insert into public.members (room_id, display_name) values ($1, 'Ken')`, [roomId]));
  await as(MIA, (q) => q(`insert into public.members (room_id, display_name) values ($1, 'Mia')`, [roomId]));
  const ken = await memberId('Ken');
  const owner = await memberId('Olivia');
  await as(KEN, (q) => q(
    `insert into public.fragrances (room_id, name, house, concentration, notes, perfumers, release_year, added_by)
     values ($1, 'Aventus', 'Creed', 'EDP', '{pineapple,birch}', '{Olivier Creed}', 2010, $2),
            ($1, 'Santal 33', 'Le Labo', 'EDP', '{sandalwood}', '{}', null, $2)`, [roomId, ken]));
  await as(OWNER, (q) => q(`insert into public.fragrances (room_id, name, house, added_by) values ($1, 'Oud Wood', 'Tom Ford', $2)`, [roomId, owner]));
  const tiers: Array<[string, string]> = [[await fragId('Aventus'), 'S'], [await fragId('Santal 33'), 'A'], [await fragId('Oud Wood'), 'C']];
  for (const [user, name] of [[OWNER, 'Olivia'], [KEN, 'Ken'], [MIA, 'Mia']] as const) {
    const m = await memberId(name);
    await as(user, async (q) => {
      for (const [f, tier] of tiers) {
        await q(`insert into public.rankings (room_id, member_id, fragrance_id, tier) values ($1, $2, $3, $4)`, [roomId, m, f, tier]);
      }
    });
  }
  t0 = (await one<{ t: string }>(`select (now() - interval '1 second')::text as t`)).t;
});

describe('restore from audit_log', () => {
  it('a deleted room comes back identical: room, invites, members, fragrances, rankings', async () => {
    const before = await snapshot();
    await as(OWNER, (q) => q('delete from public.rooms where id = $1', [roomId]));
    expect((await snapshot()).rankings).toEqual([]);

    const store = pgliteStore();
    const r = await restore(opts({ apply: true }), store);
    expect(r.plan.skipped).toEqual([]);
    expect(r.inserted).toEqual({ rooms: 1, invites: 2, members: 3, fragrances: 3, rankings: 9 });
    expect(store.backups).toBe(1);
    expect(await snapshot()).toEqual(before);
    expect(restoreReport(r)).toContain('Backup taken first: exports/backup-test');
  });

  it('a dry run writes nothing and takes no backup', async () => {
    await as(OWNER, (q) => q('delete from public.rooms where id = $1', [roomId]));
    const after = await snapshot();
    const store = pgliteStore();
    const r = await restore(opts({}), store);
    expect(r.inserted).toBeNull();
    expect(r.plan.insert.rankings).toHaveLength(9);
    expect(store.backups).toBe(0);
    expect(await snapshot()).toEqual(after);
    expect(restoreReport(r)).toContain('DRY RUN');
  });

  it('running the same restore twice inserts nothing the second time', async () => {
    await as(OWNER, (q) => q('delete from public.rooms where id = $1', [roomId]));
    await restore(opts({ apply: true }), pgliteStore());
    const store = pgliteStore();
    const again = await restore(opts({ apply: true }), store);
    expect(again.inserted).toEqual({ rooms: 0, invites: 0, members: 0, fragrances: 0, rankings: 0 });
    expect(again.plan.present).toEqual({ rooms: 1, invites: 2, members: 3, fragrances: 3, rankings: 9 });
    expect(store.backups).toBe(0);
  });

  it("a removed member's membership, invite and rankings come back with --member", async () => {
    const before = await snapshot();
    await as(OWNER, (q) => q('delete from public.invites where room_id = $1 and email = $2', [roomId, KEN.email]));
    const r = await restore(opts({ member: 'ken', apply: true }), pgliteStore());
    expect(r.inserted).toEqual({ rooms: 0, invites: 1, members: 1, fragrances: 0, rankings: 3 });
    expect(r.plan.warnings).toEqual([]);
    // added_by was cleared when Ken left and isn't restored by an insert-only tool: the only difference.
    const after = await snapshot();
    expect({ ...after, fragrances: [] }).toEqual({ ...before, fragrances: [] });
  });

  it('an unranked bottle comes back alone with --member and --fragrance', async () => {
    const ken = await memberId('Ken');
    const mia = await memberId('Mia');
    const aventus = await fragId('Aventus');
    await as(KEN, (q) => q('delete from public.rankings where member_id = $1', [ken]));
    await as(MIA, (q) => q('delete from public.rankings where member_id = $1 and fragrance_id = $2', [mia, aventus]));
    const r = await restore(opts({ member: 'Ken', fragrance: 'aventus', apply: true }), pgliteStore());
    expect(r.inserted).toEqual({ rooms: 0, invites: 0, members: 0, fragrances: 0, rankings: 1 });
    expect(await one('select tier from public.rankings where member_id = $1 and fragrance_id = $2', [ken, aventus])).toEqual({ tier: 'S' });
    expect((await db.query('select 1 from public.rankings where member_id = $1', [mia])).rows).toHaveLength(2);
  });

  it('--since/--until limit which deletions count', async () => {
    const ken = await memberId('Ken');
    await as(KEN, (q) => q('delete from public.rankings where member_id = $1', [ken]));
    const later = (await one<{ t: string }>(`select (now() + interval '1 second')::text as t`)).t;
    const r = await restore(opts({ since: later }), pgliteStore());
    expect(r.plan.insert.rankings).toEqual([]);
    const until = await restore(opts({ until: t0 }), pgliteStore());
    expect(until.plan.insert.rankings).toEqual([]);
  });

  it('skips with reasons: owner gone, member user gone, name taken, duplicate bottle, missing parents', async () => {
    const oud = await fragId('Oud Wood');
    // Mia leaves; a newcomer takes the name "mia". Ken leaves and his account is deleted.
    await as(OWNER, (q) => q('delete from public.invites where room_id = $1 and email = any($2)', [roomId, [MIA.email, KEN.email]]));
    await db.query('delete from auth.users where id = $1', [KEN.id]);
    await as(OWNER, (q) => q('insert into public.invites (room_id, email) values ($1, $2)', [roomId, NEWBIE.email]));
    await as(NEWBIE, (q) => q(`insert into public.members (room_id, display_name) values ($1, ' MIA ')`, [roomId]));
    // Oud Wood is removed and re-added under a new id.
    await as(OWNER, (q) => q('delete from public.fragrances where id = $1', [oud]));
    await as(OWNER, (q) => q(`insert into public.fragrances (room_id, name, house) values ($1, 'oud wood', 'TOM FORD')`, [roomId]));

    const r = await restore(opts({}), pgliteStore());
    const reasons = r.plan.skipped.map((s) => `${s.table} ${s.what}: ${s.reason}`);
    expect(reasons).toContain('members Ken: their user no longer exists in auth.users');
    expect(reasons).toContain('members Mia: the display name is taken by " MIA "');
    expect(reasons).toContain('fragrances Oud Wood by Tom Ford: the room already has "oud wood by TOM FORD"');
    expect(reasons.filter((x) => x.includes('the member is missing'))).toHaveLength(6); // Ken's 3 + Mia's 3
    expect(reasons.filter((x) => x.includes('the fragrance is missing'))).toHaveLength(1); // Olivia's Oud Wood
    // Their invites are fine to restore; members/rankings that can't go back are only reported.
    expect(r.plan.insert.invites.map((i) => i.email).sort()).toEqual([KEN.email, MIA.email]);

    // Room whose owner no longer exists.
    await as(OWNER, (q) => q('delete from public.rooms where id = $1', [roomId]));
    await db.query('delete from auth.users where id = $1', [OWNER.id]);
    const gone = await restore(opts({}), pgliteStore());
    expect(gone.plan.skipped).toContainEqual({ table: 'rooms', what: `${code} "Sniff Club"`, reason: 'its owner no longer exists in auth.users' });
    expect(gone.plan.skipped.filter((s) => s.reason === 'the room itself is missing and was not restored').length).toBeGreaterThan(0);
    expect(RESTORE_TABLES.every((t) => gone.plan.insert[t].length === 0)).toBe(true);
  });

  it('refuses --member/--fragrance for a room that no longer exists', async () => {
    await as(OWNER, (q) => q('delete from public.rooms where id = $1', [roomId]));
    await expect(restore(opts({ member: 'Ken' }), pgliteStore())).rejects.toThrow(/Restore the whole room first/);
  });

  it('recovers added_by that a cascade cleared before the delete was logged', () => {
    const rows: AuditRow[] = [
      { id: 1, table_name: 'fragrances', op: 'UPDATE', old_row: { id: 'f', added_by: 'm', room_id: 'r' } },
      { id: 2, table_name: 'fragrances', op: 'DELETE', old_row: { id: 'f', added_by: null, room_id: 'r' } },
      { id: 3, table_name: 'audit_log', op: 'DELETE', old_row: {} },
    ];
    expect(auditSource(rows).fragrances).toEqual([{ id: 'f', added_by: 'm', room_id: 'r' }]);
  });

  it('inserting invites fires no trigger: invites only has AFTER DELETE triggers', async () => {
    const r = await db.query<{ tgname: string; deletes_only: boolean }>(
      `select tgname, (tgtype & 28) = 8 as deletes_only from pg_trigger where tgrelid = 'public.invites'::regclass and not tgisinternal order by 1`);
    expect(r.rows).toEqual([{ tgname: 'audit_invites', deletes_only: true }, { tgname: 'invites_remove_member', deletes_only: true }]);
  });
});

describe('restore from a backup folder', () => {
  it('restores a deleted room from a backup-shaped folder, checksums checked', async () => {
    const before = await snapshot();
    const dir = await backupFixture();
    await as(OWNER, (q) => q('delete from public.rooms where id = $1', [roomId]));
    await db.query('delete from public.audit_log');
    const r = await restore(opts({ from: dir, fromAudit: false, apply: true }), pgliteStore());
    expect(r.inserted).toEqual({ rooms: 1, invites: 2, members: 3, fragrances: 3, rankings: 9 });
    expect(await snapshot()).toEqual(before);
  });

  it('leaves existing rows alone, including one edited since the backup', async () => {
    const dir = await backupFixture();
    const aventus = await fragId('Aventus');
    const ken = await memberId('Ken');
    await as(KEN, (q) => q(`update public.fragrances set name = 'Aventus Absolu', notes = '{smoke}' where id = $1`, [aventus]));
    await as(KEN, (q) => q(`update public.rankings set tier = 'D' where member_id = $1 and fragrance_id = $2`, [ken, aventus]));
    const oud = await fragId('Oud Wood');
    await as(KEN, (q) => q('delete from public.rankings where member_id = $1 and fragrance_id = $2', [ken, oud]));

    const r = await restore(opts({ from: dir, fromAudit: false, apply: true }), pgliteStore());
    expect(r.inserted).toEqual({ rooms: 0, invites: 0, members: 0, fragrances: 0, rankings: 1 });
    expect(await one('select name, notes from public.fragrances where id = $1', [aventus])).toEqual({ name: 'Aventus Absolu', notes: ['smoke'] });
    expect(await one('select tier from public.rankings where member_id = $1 and fragrance_id = $2', [ken, aventus])).toEqual({ tier: 'D' });
  });

  it('refuses a backup file that does not match its checksum', async () => {
    const dir = await backupFixture();
    writeFileSync(join(dir, 'rankings.json'), '[]');
    await expect(restore(opts({ from: dir, fromAudit: false }), pgliteStore())).rejects.toThrow(/checksum/);
  });
});

describe('parseRestoreArgs', () => {
  const PROD = 'https://abcdefghijklmnop.supabase.co';
  it('requires --room and exactly one source', () => {
    expect(parseRestoreArgs(['--from-audit', '--since', '2026-11-18'], PROD)).toMatchObject({ ok: false, message: expect.stringMatching(/--room/) });
    expect(parseRestoreArgs(['--room', 'ABC123'], PROD)).toMatchObject({ ok: false, message: expect.stringMatching(/exactly one source/) });
    expect(parseRestoreArgs(['--room', 'ABC123', '--from', 'x', '--from-audit', '--since', '2026-11-18'], PROD)).toMatchObject({ ok: false });
    expect(parseRestoreArgs(['--room', 'ABC123', '--from-audit'], PROD)).toMatchObject({ ok: false, message: expect.stringMatching(/--since/) });
    expect(parseRestoreArgs(['--room', 'ABC123', '--from-audit', '--since', 'yesterday'], PROD)).toMatchObject({ ok: false });
  });
  it('is a dry run unless --apply, and --apply without --project is refused', () => {
    const base = ['--room', 'abc123', '--from-audit', '--since', '2026-11-18T19:00:00Z'];
    expect(parseRestoreArgs(base, PROD)).toMatchObject({ ok: true, opts: { apply: false, room: 'ABC123', since: '2026-11-18T19:00:00.000Z' } });
    expect(parseRestoreArgs([...base, '--apply'], PROD)).toMatchObject({ ok: false, message: expect.stringMatching(/--project=abcdefghijklmnop/) });
    expect(parseRestoreArgs([...base, '--apply', '--project=wrongref'], PROD)).toMatchObject({ ok: false });
    expect(parseRestoreArgs([...base, '--apply', '--project=abcdefghijklmnop'], PROD)).toMatchObject({ ok: true, opts: { apply: true } });
  });
});
