// The backfill, run for real against migrations 001-003 in PGlite. Never touches Supabase.
import { PGlite } from '@electric-sql/pglite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyPlan, buildPlan, hashRankings, planMarkdown, rollbackSql, ruleViolation, TABLES, toDetails,
  type Details, type LiveRow, type Plan, type Store,
} from '../../scripts/lib/backfill';
import { cleanRows, type SourceRow } from '../../scripts/lib/parfumo';
import { dedupeKey } from './normalize';
import { splitNotes } from './reference';

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

const dir = resolve(__dirname, '../../supabase/migrations');
const migrations = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const sql = (file: string) => readFileSync(resolve(dir, file), 'utf8');

const OWNER = { id: '00000000-0000-0000-0000-00000000000a', email: 'owner@example.com' };
const FRIEND = { id: '00000000-0000-0000-0000-00000000000b', email: 'friend@example.com' };
const STRANGER = { id: '00000000-0000-0000-0000-00000000000c', email: 'stranger@example.com' };

async function as<T>(db: PGlite, user: typeof OWNER, fn: (q: PGlite['query']) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.email', $2, true)`, [user.id, user.email]);
    await tx.query('set local role authenticated');
    return fn(tx.query.bind(tx) as PGlite['query']);
  });
}

/** Migrations 001 and 002 only, seeded the way the live database looks today. */
async function seededOldDatabase() {
  const db = new PGlite();
  await db.exec(SHIM);
  for (const f of migrations.filter((m) => !m.startsWith('003'))) await db.exec(sql(f));
  for (const u of [OWNER, FRIEND, STRANGER]) await db.query('insert into auth.users (id, email) values ($1, $2)', [u.id, u.email]);
  const room = await as(db, OWNER, (q) => q<{ id: string; code: string }>(`select * from public.create_room('Sniff Club', 'Olivia')`));
  const roomId = room.rows[0].id;
  await as(db, OWNER, (q) => q('insert into public.invites (room_id, email) values ($1, $2)', [roomId, FRIEND.email]));
  await as(db, FRIEND, (q) => q(`insert into public.members (room_id, display_name) values ($1, 'Ken')`, [roomId]));
  const members = await db.query<{ id: string }>('select id from public.members order by joined_at');
  const rows: Array<[string, string, string | null, string[]]> = [
    ['Mojave Ghost', 'Byredo', 'EDP', ['ambrette', 'woody']],
    ['Tuxedo', 'YSL', 'EDP', ['bargamot', 'rose']],
    ['Luna', 'Penhaligon’s', 'EDT', ['bergamot']],
    ['Le Beau Narcisse', 'Jean Paul Gaultier', null, ['vanilla', 'musky']],
    ['Chamo', 'Tamburins', 'Parfum', ['moss']],
  ];
  const ids: Record<string, string> = {};
  for (const [name, house, conc, notes] of rows) {
    const r = await db.query<{ id: string }>(
      `insert into public.fragrances (room_id, name, house, concentration, notes, added_by) values ($1,$2,$3,$4,$5,$6) returning id`,
      [roomId, name, house, conc, notes, members.rows[0].id],
    );
    ids[name] = r.rows[0].id;
    for (const [i, m] of members.rows.entries()) {
      await db.query(`insert into public.rankings (room_id, member_id, fragrance_id, tier) values ($1,$2,$3,$4)`, [roomId, m.id, r.rows[0].id, i ? 'A' : 'S']);
    }
  }
  return { db, roomId, ids };
}

const liveRows = async (db: PGlite) => (await db.query<LiveRow>('select * from public.fragrances')).rows;

const source = (over: Partial<SourceRow>): SourceRow => ({
  name: '', brand: '', year: null, concentration: null, ratings: 100, accords: [], top: [], heart: [], base: [], perfumers: [], url: 'https://example.test/x', ...over,
});

const SOURCES: SourceRow[] = [
  source({ name: 'Mojave Ghost', brand: 'Byredo', year: 2014, concentration: 'EDP', accords: ['floral', 'woody'], top: ['sapote', 'ambrette'], heart: ['magnolia'], base: ['musk'], perfumers: ['Jérôme Epinette'] }),
  source({ name: 'Luna', brand: "Penhaligon's", year: 2016, concentration: 'EDT', accords: ['citrus'], top: ['bergamot'] }),
  source({ name: 'Le Beau', brand: 'Jean Paul Gaultier', year: 2019, top: ['coconut'] }),
  source({ name: 'Le Vestiaire - Tuxedo', brand: 'Yves Saint Laurent', year: 2015, top: ['coriander'] }),
];

function pgliteStore(db: PGlite, hooks: { backup?: () => Promise<string> } = {}): Store & { backups: number } {
  const store = {
    backups: 0,
    async snapshot() {
      const counts = {} as Record<(typeof TABLES)[number], number>;
      for (const t of TABLES) {
        counts[t] = (await db.query<{ n: number }>(`select count(*)::int as n from public.${t}`)).rows[0].n;
      }
      const r = await db.query<{ room_id: string; member_id: string; fragrance_id: string; tier: string; updated_at: string }>('select * from public.rankings');
      return { counts, rankingsHash: hashRankings(r.rows) };
    },
    async backup() {
      store.backups++;
      return hooks.backup ? hooks.backup() : 'memory';
    },
    async fetchRow(id: string) {
      const r = await db.query<LiveRow>('select * from public.fragrances where id = $1', [id]);
      return r.rows[0] ? toDetails(r.rows[0]) : null;
    },
    async update(id: string, patch: Partial<Details>, guard: { name: string; house: string }) {
      const cols = Object.keys(patch);
      const sets = cols.map((c, i) => `${c} = $${i + 4}`).join(', ');
      const r = await db.query(
        `update public.fragrances set ${sets} where id = $1 and name = $2 and house = $3`,
        [id, guard.name, guard.house, ...Object.values(patch)],
      );
      return r.affectedRows ?? 0;
    },
  };
  return store;
}

async function allTables(db: PGlite) {
  const out: Record<string, unknown[]> = {};
  for (const t of ['rooms', 'invites', 'members', 'rankings']) {
    out[t] = (await db.query(`select * from public.${t} order by 1, 2`)).rows;
  }
  return out;
}

describe('migration 003', () => {
  let ctx: Awaited<ReturnType<typeof seededOldDatabase>>;
  beforeEach(async () => {
    ctx = await seededOldDatabase();
  });

  it('applies on top of 001 and 002, and existing rows survive with defaults', async () => {
    const before = await liveRows(ctx.db);
    await ctx.db.exec(sql('003_fragrance_details.sql'));
    const after = await liveRows(ctx.db);
    expect(after).toHaveLength(before.length);
    for (const row of after) {
      expect(row).toMatchObject({ perfumers: [], accords: [], notes_top: [], notes_heart: [], notes_base: [], release_year: null });
      expect(row).toMatchObject(before.find((b) => b.id === row.id)!);
    }
  });

  it('is safe to run twice, without losing data written in between', async () => {
    await ctx.db.exec(sql('003_fragrance_details.sql'));
    await ctx.db.query(`update public.fragrances set accords = '{woody}', release_year = 2014 where id = $1`, [ctx.ids['Mojave Ghost']]);
    await ctx.db.exec(sql('003_fragrance_details.sql'));
    const r = await ctx.db.query<LiveRow>('select * from public.fragrances where id = $1', [ctx.ids['Mojave Ghost']]);
    expect(r.rows[0]).toMatchObject({ accords: ['woody'], release_year: 2014 });
  });

  it('leaves everything outside the new columns alone', async () => {
    const before = await allTables(ctx.db);
    await ctx.db.exec(sql('003_fragrance_details.sql'));
    expect(await allTables(ctx.db)).toEqual(before);
  });

  it('lets a member update every new column, and insert them', async () => {
    await ctx.db.exec(sql('003_fragrance_details.sql'));
    const r = await as(ctx.db, FRIEND, (q) => q(
      `update public.fragrances set perfumers = '{A}', accords = '{b}', notes_top = '{c}', notes_heart = '{d}', notes_base = '{e}', release_year = 2001 where id = $1`,
      [ctx.ids['Chamo']],
    ));
    expect(r.affectedRows).toBe(1);
    await as(ctx.db, FRIEND, (q) => q(
      `insert into public.fragrances (room_id, name, house, accords, notes_top, release_year) values ($1, 'New', 'House', '{a}', '{b}', 2020)`,
      [ctx.roomId],
    ));
  });

  it('without the grant in 003 that update is denied (the trap this guards)', async () => {
    const without = sql('003_fragrance_details.sql').replace(/grant update[\s\S]*?to authenticated;/, '');
    await ctx.db.exec(without);
    await expect(as(ctx.db, FRIEND, (q) => q(`update public.fragrances set accords = '{b}' where id = $1`, [ctx.ids['Chamo']])))
      .rejects.toThrow(/permission denied/);
  });

  it('an outsider changes nothing', async () => {
    await ctx.db.exec(sql('003_fragrance_details.sql'));
    const r = await as(ctx.db, STRANGER, (q) => q(`update public.fragrances set accords = '{hacked}' where room_id = $1`, [ctx.roomId]));
    expect(r.affectedRows).toBe(0);
    const left = await ctx.db.query<LiveRow>(`select * from public.fragrances where 'hacked' = any(accords)`);
    expect(left.rows).toHaveLength(0);
  });

  it('rejects a nonsense year', async () => {
    await ctx.db.exec(sql('003_fragrance_details.sql'));
    await expect(ctx.db.query(`update public.fragrances set release_year = 20244 where id = $1`, [ctx.ids['Chamo']]))
      .rejects.toThrow(/check constraint/);
  });
});

describe('buildPlan', () => {
  const rows: LiveRow[] = [
    { id: '1', name: 'Mojave Ghost', house: 'Byredo', concentration: 'EDP', notes: ['ambrette', 'woody'] },
    { id: '2', name: 'Tuxedo', house: 'YSL', concentration: 'EDP', notes: ['bargamot', 'rose'] },
    { id: '3', name: 'Le Beau Narcisse', house: 'Jean Paul Gaultier', concentration: null, notes: ['vanilla', 'musky'] },
    { id: '4', name: 'Chamo', house: 'Tamburins', concentration: 'Parfum', notes: ['moss'] },
  ];
  const plan = buildPlan(rows, SOURCES, 'test');
  const by = (id: string) => plan.rows.find((r) => r.id === id)!;

  it('sorts rows into the three sections', () => {
    expect(plan.rows.map((r) => r.section)).toEqual(['auto', 'review', 'review', 'unmatched']);
  });

  it('auto-match fills details and keeps member notes', () => {
    expect(by('1').after).toMatchObject({
      notes: ['ambrette', 'sapote', 'magnolia', 'musk'], accords: ['floral', 'woody'], notes_top: ['sapote', 'ambrette'],
      perfumers: ['Jérôme Epinette'], release_year: 2014,
    });
  });

  it('never applies source data from a near miss, but still applies reviewed fixes', () => {
    expect(by('3').after).toMatchObject({ notes: ['vanilla'], accords: ['musky'], notes_top: [], release_year: null });
    expect(by('3').candidates[0].name).toBe('Le Beau');
    expect(by('2').after).toMatchObject({ house: 'Yves Saint Laurent', notes: ['bergamot', 'rose'], notes_top: [] });
  });

  it('leaves unmatched rows empty rather than inventing anything', () => {
    expect(by('4').after).toEqual(by('4').before);
  });

  it('does not overwrite details a member already filled in', () => {
    const [r] = buildPlan([{ ...rows[0], perfumers: ['Mine'], notes_top: ['pear'], release_year: 2000 }], SOURCES, 't').rows;
    expect(r.after).toMatchObject({ perfumers: ['Mine'], notes_top: ['pear'], notes_heart: [], release_year: 2000 });
  });

  it('withholds a rename that would hit the unique index, per room', () => {
    const clash = buildPlan([
      { id: 'a', room_id: 'r1', name: 'Libre', house: 'YSL', notes: [] },
      { id: 'b', room_id: 'r1', name: 'Libre', house: 'Yves Saint Laurent', notes: [] },
      { id: 'c', room_id: 'r2', name: 'Libre', house: 'YSL', notes: [] },
    ], [], 't');
    expect(clash.rows[0].after.house).toBe('YSL');
    expect(clash.rows[0].section).toBe('review');
    expect(clash.rows[0].reasons.join()).toMatch(/fragrances_room_dedupe_key/);
    expect(clash.rows[2].after.house).toBe('Yves Saint Laurent');
    expect(clash.summary.collisions).toBe(1);
  });

  it('renders markdown with all three sections', () => {
    const md = planMarkdown(plan);
    for (const h of ['## Auto-matched (1)', '## Needs review (2)', '## Unmatched (1)']) expect(md).toContain(h);
  });
});

describe('the 91 live rows', () => {
  const live = JSON.parse(readFileSync(resolve(__dirname, '__fixtures__/fragrances-sanitized.json'), 'utf8')) as LiveRow[];
  const csv = process.env.PARFUMO_CSV;
  const sources = csv && existsSync(csv) ? cleanRows(readFileSync(csv, 'utf8')).rows : SOURCES;
  const plan = buildPlan(live, sources, 'fixture');

  it('accounts for every row', () => {
    expect(plan.rows).toHaveLength(91);
    expect(plan.summary.auto + plan.summary.review + plan.summary.unmatched).toBe(91);
  });

  it('never loses a member note: corrected originals minus accord words all survive', () => {
    for (const r of plan.rows) {
      expect(r.after.notes).toEqual(expect.arrayContaining(splitNotes(r.before.notes).notes));
      expect(ruleViolation(r)).toBeNull();
      for (const c of r.candidates) expect(c.after.notes).toEqual(expect.arrayContaining(splitNotes(r.before.notes).notes));
    }
  });

  it('removes the listed junk from notes and fixes the house variants', () => {
    const notes = plan.rows.flatMap((r) => r.after.notes);
    for (const bad of ['bargamot', 'ambegris', 'woody', 'warm', 'spicy', 'sweet', 'musky', 'lactonic', 'white floral']) expect(notes).not.toContain(bad);
    const houses = new Set(plan.rows.map((r) => r.after.house));
    for (const bad of ['YSL', 'Penhaligon’s', 'Etat Libre d’Orange']) expect(houses).not.toContain(bad);
  });

  it('leaves no duplicate under the unique index', () => {
    const keys = plan.rows.map((r) => dedupeKey(r.after.name, r.after.house));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never changes a name or an existing concentration', () => {
    for (const r of plan.rows) {
      expect(r.after.name).toBe(r.before.name);
      if (r.before.concentration) expect(r.after.concentration).toBe(r.before.concentration);
    }
  });

  it.runIf(csv)('sends the known wrong prefix hits to review, not auto', () => {
    const section = (n: string) => plan.rows.find((r) => r.before.name === n)?.section;
    expect(section('Le Beau Narcisse')).toBe('review');
    expect(section('Mojave Ghost Absolu')).toBe('review');
    expect(section("Terre d'Hermès")).toBe('auto');
    expect(plan.rows.find((r) => r.before.name === "Terre d'Hermès")?.match?.name).toBe("Terre d'Hermès");
  });
});

describe('applyPlan against a seeded copy', () => {
  let ctx: Awaited<ReturnType<typeof seededOldDatabase>>;
  let plan: Plan;
  let rollback: string;
  const opts = (dryRun: boolean) => ({ dryRun, writeRollback: (s: string) => { rollback = s; } });
  const fragrance = async (id: string) => (await ctx.db.query<LiveRow>('select * from public.fragrances where id = $1', [id])).rows[0];

  beforeEach(async () => {
    ctx = await seededOldDatabase();
    await ctx.db.exec(sql('003_fragrance_details.sql'));
    plan = buildPlan(await liveRows(ctx.db), SOURCES, 'seed');
    rollback = '';
  });

  it('updates fragrances and leaves rankings and every other table identical', async () => {
    const before = await allTables(ctx.db);
    const store = pgliteStore(ctx.db);
    const hash = (await store.snapshot()).rankingsHash;
    const r = await applyPlan(plan, store, opts(false));
    expect(r.updated).toHaveLength(plan.summary.changed);
    expect(r.failed).toEqual([]);
    expect(await allTables(ctx.db)).toEqual(before);
    expect((await store.snapshot()).rankingsHash).toBe(hash);
    expect(await fragrance(ctx.ids['Mojave Ghost'])).toMatchObject({ release_year: 2014, perfumers: ['Jérôme Epinette'] });
    expect(await fragrance(ctx.ids['Tuxedo'])).toMatchObject({ house: 'Yves Saint Laurent', notes: ['bergamot', 'rose'] });
    expect(await fragrance(ctx.ids['Luna'])).toMatchObject({ house: "Penhaligon's" });
  });

  it('takes the backup before the first write, and a failed backup stops everything', async () => {
    const store = pgliteStore(ctx.db, { backup: async () => { throw new Error('backup broke'); } });
    await expect(applyPlan(plan, store, opts(false))).rejects.toThrow(/backup broke/);
    expect(await fragrance(ctx.ids['Tuxedo'])).toMatchObject({ house: 'YSL' });
    expect(store.backups).toBe(1);
  });

  it('skips a row changed since the plan, and keeps the member edit', async () => {
    await as(ctx.db, FRIEND, (q) => q(`update public.fragrances set notes = '{bergamot,rose,oud}' where id = $1`, [ctx.ids['Tuxedo']]));
    await as(ctx.db, FRIEND, (q) => q(`update public.fragrances set house = 'Byredo Paris' where id = $1`, [ctx.ids['Mojave Ghost']]));
    const r = await applyPlan(plan, pgliteStore(ctx.db), opts(false));
    expect(r.skipped.map((s) => s.id).sort()).toEqual([ctx.ids['Tuxedo'], ctx.ids['Mojave Ghost']].sort());
    expect(r.skipped.find((s) => s.id === ctx.ids['Tuxedo'])?.reason).toMatch(/notes/);
    expect(await fragrance(ctx.ids['Tuxedo'])).toMatchObject({ house: 'YSL', notes: ['bergamot', 'rose', 'oud'] });
    expect(await fragrance(ctx.ids['Luna'])).toMatchObject({ house: "Penhaligon's" });
    expect(rollback).not.toContain(ctx.ids['Tuxedo']);
  });

  it('skips a row deleted since the plan', async () => {
    await ctx.db.query('delete from public.rankings where fragrance_id = $1', [ctx.ids['Tuxedo']]);
    await ctx.db.query('delete from public.fragrances where id = $1', [ctx.ids['Tuxedo']]);
    const r = await applyPlan(plan, pgliteStore(ctx.db), opts(false));
    expect(r.skipped).toEqual([{ id: ctx.ids['Tuxedo'], reason: 'row no longer exists' }]);
  });

  it('a dry run writes nothing and takes no backup', async () => {
    const before = await liveRows(ctx.db);
    const store = pgliteStore(ctx.db);
    const r = await applyPlan(plan, store, opts(true));
    expect(r.wouldUpdate).toHaveLength(plan.summary.changed);
    expect(r.updated).toEqual([]);
    expect(await liveRows(ctx.db)).toEqual(before);
    expect(store.backups).toBe(0);
    expect(rollback).toBe('');
  });

  it('applies a candidate only when a reviewer approves it', async () => {
    const row = plan.rows.find((r) => r.before.name === 'Le Beau Narcisse')!;
    row.approved_candidate = 0;
    await applyPlan(plan, pgliteStore(ctx.db), opts(false));
    expect(await fragrance(row.id)).toMatchObject({ notes_top: ['coconut'], release_year: 2019 });
  });

  it('the rollback file restores every changed row exactly', async () => {
    const before = (await liveRows(ctx.db)).sort((a, b) => a.id.localeCompare(b.id));
    await applyPlan(plan, pgliteStore(ctx.db), opts(false));
    expect(rollback).not.toBe('');
    await ctx.db.exec(rollback);
    expect((await liveRows(ctx.db)).sort((a, b) => a.id.localeCompare(b.id))).toEqual(before);
  });

  it('survives quotes in rollback values', async () => {
    const sqlText = rollbackSql([{ id: ctx.ids['Luna'], restore: { house: "O'Brien", notes: ["l'eau"] } }]);
    await ctx.db.exec(sqlText);
    expect(await fragrance(ctx.ids['Luna'])).toMatchObject({ house: "O'Brien", notes: ["l'eau"] });
  });

  it('refuses a plan that would lose member notes, before touching anything', async () => {
    const row = plan.rows.find((r) => r.before.name === 'Tuxedo')!;
    row.after = { ...row.after, notes: [] };
    await expect(applyPlan(plan, pgliteStore(ctx.db), opts(false))).rejects.toThrow(/loses member notes/);
    expect(await fragrance(row.id)).toMatchObject({ house: 'YSL' });
  });

  it('fails loudly if rankings change during the run', async () => {
    const store = pgliteStore(ctx.db);
    const realUpdate = store.update;
    store.update = async (...args) => {
      await ctx.db.query(`update public.rankings set tier = 'D' where fragrance_id = $1`, [ctx.ids['Chamo']]);
      return realUpdate(...args);
    };
    await expect(applyPlan(plan, store, opts(false))).rejects.toThrow(/Integrity check FAILED/);
  });

  it('reports a unique violation at write time as failed, and carries on', async () => {
    await ctx.db.query(`insert into public.fragrances (room_id, name, house) values ($1, 'Tuxedo', 'Yves Saint Laurent')`, [ctx.roomId]);
    const r = await applyPlan(plan, pgliteStore(ctx.db), opts(false));
    expect(r.failed.map((f) => f.id)).toEqual([ctx.ids['Tuxedo']]);
    expect(r.updated).toContain(ctx.ids['Luna']);
    expect(rollback).not.toContain(ctx.ids['Tuxedo']);
  });
});
