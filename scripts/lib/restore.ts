// Restore deleted rows into ONE room, from a backup folder or from public.audit_log (migration 005).
// INSERT ONLY: rows that already exist are left exactly as they are (even if edited since), and
// nothing is ever updated or deleted. Rows that can't go back cleanly are skipped with a reason.
// The database is reached only through RestoreStore, so tests run all of this on PGlite.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dedupeKey } from '../../src/lib/normalize';
import { checkProject } from './project-guard';

export const RESTORE_TABLES = ['rooms', 'invites', 'members', 'fragrances', 'rankings'] as const; // FK order
export type Table = (typeof RESTORE_TABLES)[number];
export type Row = Record<string, unknown>;
export type Source = Record<Table, Row[]>;

/** Primary-key columns, also the ON CONFLICT target. */
export const PK: Record<Table, string[]> = {
  rooms: ['id'],
  invites: ['room_id', 'email'],
  members: ['id'],
  fragrances: ['id'],
  rankings: ['member_id', 'fragrance_id'],
};

export const pkOf = (table: Table, row: Row) => PK[table].map((c) => String(row[c])).join('|');
const emptySource = (): Source => ({ rooms: [], invites: [], members: [], fragrances: [], rankings: [] });
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

export interface AuditRow { id: number; table_name: string; op: string; old_row: Row }

export interface Live {
  roomByCode: Row | null; // whichever room holds the code now
  room: Row | null; // the room with the id being restored, if it exists
  invites: Row[];
  members: Row[];
  fragrances: Row[];
  rankings: Row[];
}

export interface RestoreStore {
  /** DELETE rows (and fragrances UPDATE rows) from audit_log with since <= at (< until), by id. */
  auditRows(since: string, until?: string): Promise<AuditRow[]>;
  /** Current state of the room with `roomId` (or, if not given, of the room holding `code`). */
  live(code: string, roomId?: string): Promise<Live>;
  /** Which of these auth.users ids still exist. */
  existingUsers(ids: string[]): Promise<Set<string>>;
  /** INSERT … ON CONFLICT DO NOTHING; returns rows actually inserted. */
  insert(table: Table, rows: Row[]): Promise<number>;
  /** Fresh backup before writing; returns where it went. */
  backup(): Promise<string>;
  /** Run fn atomically, if the adapter can. */
  transaction?<T>(fn: (store: RestoreStore) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

export interface RestoreOptions {
  from?: string;
  fromAudit: boolean;
  since?: string;
  until?: string;
  room: string;
  member?: string;
  fragrance?: string;
  apply: boolean;
}

export const RESTORE_USAGE = `Usage:
  npm run restore -- --room <CODE> --from exports/backup-<time> [--member <name>] [--fragrance <name>]
  npm run restore -- --room <CODE> --from-audit --since <ISO time> [--until <ISO time>] [--member <name>] [--fragrance <name>]
Dry run by default. Add --apply --project=<ref> to write.`;

/** Parses argv (without node/script). With --apply, also runs the --project guard against `url`. */
export function parseRestoreArgs(argv: string[], url: string | undefined): { ok: true; opts: RestoreOptions } | { ok: false; message: string } {
  const value = (name: string) => {
    const i = argv.indexOf(name);
    if (i === -1) return undefined;
    const v = argv[i + 1];
    return v === undefined || v.startsWith('--') ? '' : v;
  };
  const fail = (message: string) => ({ ok: false as const, message: `${message}\n\n${RESTORE_USAGE}` });

  const room = value('--room');
  if (room === undefined || room === '') return fail('--room <CODE> is required.');
  if (!/^[A-Za-z0-9]{6}$/.test(room)) return fail(`--room must be a 6-character room code, got "${room}".`);

  const from = value('--from');
  const fromAudit = argv.includes('--from-audit');
  if ((from !== undefined) === fromAudit) return fail('Give exactly one source: --from <backup folder> or --from-audit.');
  if (from === '') return fail('--from needs a backup folder.');

  const since = value('--since');
  const until = value('--until');
  const badTime = (t: string | undefined) => t !== undefined && (t === '' || Number.isNaN(Date.parse(t)));
  if (fromAudit && since === undefined) return fail('--from-audit needs --since <ISO time>.');
  if (badTime(since)) return fail(`--since must be an ISO time, got "${since}".`);
  if (badTime(until)) return fail(`--until must be an ISO time, got "${until}".`);
  if (!fromAudit && (since !== undefined || until !== undefined)) return fail('--since/--until only apply to --from-audit.');

  const member = value('--member');
  const fragrance = value('--fragrance');
  if (member === '') return fail('--member needs a display name.');
  if (fragrance === '') return fail('--fragrance needs a name.');

  const apply = argv.includes('--apply');
  if (apply) {
    const guard = checkProject(url, argv);
    if (!guard.ok) return { ok: false, message: guard.message };
  }

  return {
    ok: true,
    opts: {
      from,
      fromAudit,
      since: since && new Date(since).toISOString(),
      until: until && new Date(until).toISOString(),
      room: room.toUpperCase(),
      member,
      fragrance,
      apply,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------

/** Reads a folder written by `npm run backup`, checking each file against manifest.json. */
export function loadBackupDir(dir: string): Source {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`${dir} has no manifest.json; is it a backup folder?`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { tables: Record<string, { rows: number; sha256: string }> };
  const source = emptySource();
  for (const table of RESTORE_TABLES) {
    const entry = manifest.tables[table];
    if (!entry) throw new Error(`${dir}/manifest.json does not list ${table}`);
    const body = readFileSync(join(dir, `${table}.json`), 'utf8');
    if (createHash('sha256').update(body).digest('hex') !== entry.sha256) {
      throw new Error(`${dir}/${table}.json does not match its checksum in manifest.json`);
    }
    source[table] = JSON.parse(body) as Row[];
  }
  return source;
}

/**
 * Builds a source from audit rows: each DELETE's old row, the latest deletion winning if a row was
 * deleted more than once. A member's removal clears `added_by` on fragrances they added (logged as
 * an UPDATE) before a room delete reaches the fragrances, so that value is recovered from the
 * matching UPDATE row.
 */
export function auditSource(rows: AuditRow[]): Source {
  const sorted = [...rows].sort((a, b) => a.id - b.id);
  const latest = new Map<string, { auditId: number; row: Row }>();
  for (const a of sorted) {
    if (a.op !== 'DELETE' || !(RESTORE_TABLES as readonly string[]).includes(a.table_name)) continue;
    const table = a.table_name as Table;
    latest.set(`${table}:${pkOf(table, a.old_row)}`, { auditId: a.id, row: a.old_row });
  }
  const source = emptySource();
  for (const [key, { auditId, row }] of latest) {
    const table = key.slice(0, key.indexOf(':')) as Table;
    let out = row;
    if (table === 'fragrances' && row.added_by == null) {
      const cleared = sorted
        .filter((a) => a.op === 'UPDATE' && a.table_name === 'fragrances' && a.id < auditId && a.old_row.id === row.id && a.old_row.added_by != null)
        .pop();
      if (cleared) out = { ...row, added_by: cleared.old_row.added_by };
    }
    source[table].push(out);
  }
  return source;
}

// ---------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------

export interface Skip { table: Table; what: string; reason: string }
export interface RestorePlan {
  roomId: string;
  code: string;
  insert: Source;
  present: Record<Table, number>;
  skipped: Skip[];
  warnings: string[];
}

const nameKey = (s: unknown) => str(s).trim().toLowerCase();
const fragKey = (s: unknown) => str(s).replace(/\s+/g, '').toLowerCase();

/** Pure: decides what to insert, what is already there, and what to skip (and why). */
export function planRestore(source: Source, live: Live, users: Set<string>, scope: { room: string; member?: string; fragrance?: string }): RestorePlan {
  const code = scope.room.toUpperCase();
  const narrowed = scope.member !== undefined || scope.fragrance !== undefined;
  const srcRoom = source.rooms.find((r) => r.code === code) ?? (live.room ? source.rooms.find((r) => r.id === live.room!.id) : undefined);
  const roomId = str(srcRoom?.id ?? live.room?.id ?? live.roomByCode?.id);
  if (!roomId) throw new Error(`No room with code ${code} in the source or in the database.`);
  if (narrowed && !live.room) {
    throw new Error(`Room ${code} does not exist any more. Restore the whole room first (without --member/--fragrance).`);
  }

  const plan: RestorePlan = {
    roomId,
    code,
    insert: emptySource(),
    present: { rooms: 0, invites: 0, members: 0, fragrances: 0, rankings: 0 },
    skipped: [],
    warnings: [],
  };
  const inRoom = (t: Table) => source[t].filter((r) => str(t === 'rooms' ? r.id : r.room_id) === roomId);
  const liveKeys = (t: Exclude<Table, 'rooms'>) => new Set(live[t].map((r) => pkOf(t, r)));
  const skip = (table: Table, what: string, reason: string) => plan.skipped.push({ table, what, reason });

  // Names for messages, from both source and live rows.
  const memberName = new Map<string, string>();
  for (const m of [...source.members, ...live.members]) memberName.set(str(m.id), str(m.display_name));
  const fragName = new Map<string, string>();
  for (const f of [...source.fragrances, ...live.fragrances]) fragName.set(str(f.id), `${str(f.name)} by ${str(f.house)}`);

  // Scope filters match source and live rows, so "Ken's ranking of Aventus" works while Ken is still a member.
  let memberIds: Set<string> | null = null;
  if (scope.member !== undefined) {
    const want = nameKey(scope.member);
    memberIds = new Set([...inRoom('members'), ...live.members].filter((m) => nameKey(m.display_name) === want).map((m) => str(m.id)));
    if (memberIds.size === 0) throw new Error(`No member named "${scope.member}" in room ${code}, in the source or the database.`);
  }
  let fragranceIds: Set<string> | null = null;
  if (scope.fragrance !== undefined) {
    const want = fragKey(scope.fragrance);
    fragranceIds = new Set([...inRoom('fragrances'), ...live.fragrances].filter((f) => fragKey(f.name) === want).map((f) => str(f.id)));
    if (fragranceIds.size === 0) throw new Error(`No fragrance named "${scope.fragrance}" in room ${code}, in the source or the database.`);
  }

  // rooms
  let roomOk = !!live.room;
  let ownerId = str(live.room?.owner_id);
  if (!narrowed) {
    for (const r of inRoom('rooms')) {
      const what = `${str(r.code)} "${str(r.name)}"`;
      if (live.room) plan.present.rooms++;
      else if (live.roomByCode && str(live.roomByCode.id) !== roomId) skip('rooms', what, 'its code is now used by another room');
      else if (!users.has(str(r.owner_id))) skip('rooms', what, 'its owner no longer exists in auth.users');
      else {
        plan.insert.rooms.push(r);
        roomOk = true;
        ownerId = str(r.owner_id);
      }
    }
  }
  const roomMissing = 'the room itself is missing and was not restored';

  // invites
  const memberEmails = new Set(
    [...inRoom('members'), ...live.members].filter((m) => !memberIds || memberIds.has(str(m.id))).map((m) => str(m.email)),
  );
  const inviteCandidates = memberIds ? inRoom('invites').filter((i) => memberEmails.has(str(i.email))) : fragranceIds ? [] : inRoom('invites');
  const liveInvites = liveKeys('invites');
  for (const i of inviteCandidates) {
    if (liveInvites.has(pkOf('invites', i))) plan.present.invites++;
    else if (!roomOk) skip('invites', str(i.email), roomMissing);
    else plan.insert.invites.push(i);
  }

  // members
  const memberCandidates = memberIds ? inRoom('members').filter((m) => memberIds!.has(str(m.id))) : fragranceIds ? [] : inRoom('members');
  const liveMemberIds = new Set(live.members.map((m) => str(m.id)));
  const takenUsers = new Map(live.members.map((m) => [str(m.user_id), str(m.display_name)]));
  const takenNames = new Map(live.members.map((m) => [nameKey(m.display_name), str(m.display_name)]));
  for (const m of memberCandidates) {
    const what = str(m.display_name);
    if (liveMemberIds.has(str(m.id))) plan.present.members++;
    else if (!roomOk) skip('members', what, roomMissing);
    else if (!users.has(str(m.user_id))) skip('members', what, 'their user no longer exists in auth.users');
    else if (takenUsers.has(str(m.user_id))) skip('members', what, `they rejoined since, as "${takenUsers.get(str(m.user_id))}"`);
    else if (takenNames.has(nameKey(m.display_name))) skip('members', what, `the display name is taken by "${takenNames.get(nameKey(m.display_name))}"`);
    else {
      plan.insert.members.push(m);
      takenUsers.set(str(m.user_id), what);
      takenNames.set(nameKey(m.display_name), what);
    }
  }
  const memberThere = new Set([...liveMemberIds, ...plan.insert.members.map((m) => str(m.id))]);
  const invited = new Set([...live.invites, ...plan.insert.invites].map((i) => str(i.email)));
  for (const m of plan.insert.members) {
    if (str(m.user_id) !== ownerId && !invited.has(str(m.email))) {
      plan.warnings.push(`${str(m.display_name)} is not on the invite list, so they can't open the room until you invite them again.`);
    }
  }

  // fragrances
  const fragCandidates = fragranceIds ? inRoom('fragrances').filter((f) => fragranceIds!.has(str(f.id))) : memberIds ? [] : inRoom('fragrances');
  const liveFragIds = new Set(live.fragrances.map((f) => str(f.id)));
  const takenFrags = new Map(live.fragrances.map((f) => [dedupeKey(str(f.name), str(f.house)), fragName.get(str(f.id))!]));
  for (const f of fragCandidates) {
    const what = fragName.get(str(f.id))!;
    const key = dedupeKey(str(f.name), str(f.house));
    if (liveFragIds.has(str(f.id))) plan.present.fragrances++;
    else if (!roomOk) skip('fragrances', what, roomMissing);
    else if (takenFrags.has(key)) skip('fragrances', what, `the room already has "${takenFrags.get(key)}"`);
    else {
      let row = f;
      if (f.added_by != null && !memberThere.has(str(f.added_by))) {
        row = { ...f, added_by: null };
        plan.warnings.push(`${what}: "added by" cleared, because that member isn't in the room.`);
      }
      plan.insert.fragrances.push(row);
      takenFrags.set(key, what);
    }
  }
  const fragThere = new Set([...liveFragIds, ...plan.insert.fragrances.map((f) => str(f.id))]);

  // rankings
  const liveRankings = liveKeys('rankings');
  const rankCandidates = inRoom('rankings').filter(
    (r) => (!memberIds || memberIds.has(str(r.member_id))) && (!fragranceIds || fragranceIds.has(str(r.fragrance_id))),
  );
  for (const r of rankCandidates) {
    const what = `${memberName.get(str(r.member_id)) ?? str(r.member_id)}: ${str(r.tier)} for ${fragName.get(str(r.fragrance_id)) ?? str(r.fragrance_id)}`;
    if (liveRankings.has(pkOf('rankings', r))) plan.present.rankings++;
    else if (!roomOk) skip('rankings', what, roomMissing);
    else if (!memberThere.has(str(r.member_id))) skip('rankings', what, 'the member is missing and was not restored');
    else if (!fragThere.has(str(r.fragrance_id))) skip('rankings', what, 'the fragrance is missing and was not restored');
    else plan.insert.rankings.push(r);
  }

  return plan;
}

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------

export class PartialRestoreError extends Error {
  constructor(message: string, readonly inserted: Record<Table, number>) {
    super(message);
  }
}

/** Inserts the plan in FK order. In one transaction when the store supports it; otherwise stops at the first error. */
export async function applyRestore(plan: RestorePlan, store: RestoreStore): Promise<Record<Table, number>> {
  const run = async (s: RestoreStore) => {
    const inserted: Record<Table, number> = { rooms: 0, invites: 0, members: 0, fragrances: 0, rankings: 0 };
    for (const t of RESTORE_TABLES) {
      if (plan.insert[t].length === 0) continue;
      try {
        inserted[t] = await s.insert(t, plan.insert[t]);
      } catch (e) {
        throw new PartialRestoreError(`${t}: ${e instanceof Error ? e.message : String(e)}`, inserted);
      }
    }
    return inserted;
  };
  return store.transaction ? store.transaction(run) : run(store);
}

export interface RestoreResult { plan: RestorePlan; backup: string | null; inserted: Record<Table, number> | null }

export async function restore(opts: RestoreOptions, store: RestoreStore): Promise<RestoreResult> {
  const source = opts.from ? loadBackupDir(opts.from) : auditSource(await store.auditRows(opts.since!, opts.until));
  const srcRoom = source.rooms.find((r) => r.code === opts.room);
  const live = await store.live(opts.room, srcRoom ? str(srcRoom.id) : undefined);
  const userIds = [...source.rooms.map((r) => str(r.owner_id)), ...source.members.map((m) => str(m.user_id))].filter(Boolean);
  const users = await store.existingUsers([...new Set(userIds)]);
  const plan = planRestore(source, live, users, opts);
  if (!opts.apply) return { plan, backup: null, inserted: null };
  if (RESTORE_TABLES.every((t) => plan.insert[t].length === 0)) return { plan, backup: null, inserted: { rooms: 0, invites: 0, members: 0, fragrances: 0, rankings: 0 } };
  const backup = await store.backup();
  const inserted = await applyRestore(plan, store);
  return { plan, backup, inserted };
}

/** Human-readable summary of a plan (and, after --apply, of what was inserted). */
export function restoreReport(r: RestoreResult): string {
  const { plan } = r;
  const lines = [`Room ${plan.code} (${plan.roomId})`, `${'table'.padEnd(11)} ${'restore'.padStart(7)} ${'present'.padStart(7)} ${'skipped'.padStart(7)}${r.inserted ? ' inserted'.padStart(9) : ''}`];
  for (const t of RESTORE_TABLES) {
    const skipped = plan.skipped.filter((s) => s.table === t).length;
    lines.push(`${t.padEnd(11)} ${String(plan.insert[t].length).padStart(7)} ${String(plan.present[t]).padStart(7)} ${String(skipped).padStart(7)}${r.inserted ? String(r.inserted[t]).padStart(9) : ''}`);
  }
  if (plan.skipped.length) {
    lines.push('', 'Skipped:');
    for (const s of plan.skipped) lines.push(`  ${s.table.padEnd(10)} ${s.what}: ${s.reason}`);
  }
  if (plan.warnings.length) {
    lines.push('', 'Warnings:');
    for (const w of plan.warnings) lines.push(`  ${w}`);
  }
  lines.push('');
  if (!r.inserted) lines.push('DRY RUN: nothing was written. Add --apply --project=<ref> to write.');
  else if (!r.backup) lines.push('Nothing to restore; nothing was written.');
  else lines.push(`Backup taken first: ${r.backup}`);
  return lines.join('\n');
}
