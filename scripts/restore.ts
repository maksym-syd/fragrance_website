// Puts deleted rows back into one room, from a backup folder or from audit_log. INSERT ONLY:
// existing rows are never changed. Dry run by default; see "Restoring data" in README.md.
//
//   npm run restore -- --room K7P2QX --from-audit --since 2026-11-18T19:00:00Z
//   npm run restore -- --room K7P2QX --from exports/backup-<time> --member Ken
//   npm run restore -- --room K7P2QX --from-audit --since <time> --apply --project=<ref>
//
// Needs SUPABASE_SERVICE_ROLE_KEY. --apply also needs --project=<ref> and takes a backup first.
// supabase-js has no transactions, so a failed write stops at once; re-running is safe because
// every insert is ON CONFLICT DO NOTHING.
import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceClient } from './env';
import { takeBackup } from './lib/backup';
import { projectRef } from './lib/project-guard';
import { PartialRestoreError, PK, parseRestoreArgs, restore, restoreReport, type AuditRow, type Live, type RestoreStore, type Row } from './lib/restore';

async function all(q: () => any): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data as Row[]));
    if (data.length < 1000) return out;
  }
}

function supabaseStore(admin: SupabaseClient, url: string): RestoreStore {
  return {
    async auditRows(since, until) {
      const rows = await all(() => {
        let q = admin.from('audit_log').select('id, table_name, op, old_row').gte('at', since).order('id');
        if (until) q = q.lt('at', until);
        return q;
      });
      return rows as unknown as AuditRow[];
    },
    async live(code, roomId): Promise<Live> {
      const byCode = await admin.from('rooms').select('*').eq('code', code).maybeSingle();
      if (byCode.error) throw new Error(`rooms: ${byCode.error.message}`);
      const id = roomId ?? (byCode.data?.id as string | undefined);
      if (!id) return { roomByCode: null, room: null, invites: [], members: [], fragrances: [], rankings: [] };
      const room = await admin.from('rooms').select('*').eq('id', id).maybeSingle();
      if (room.error) throw new Error(`rooms: ${room.error.message}`);
      const child = (t: string, order: string) => all(() => admin.from(t).select('*').eq('room_id', id).order(order));
      const [invites, members, fragrances, rankings] = await Promise.all([
        child('invites', 'email'),
        child('members', 'id'),
        child('fragrances', 'id'),
        child('rankings', 'member_id'),
      ]);
      return { roomByCode: byCode.data, room: room.data, invites, members, fragrances, rankings };
    },
    async existingUsers(ids) {
      const found = new Set<string>();
      for (const id of ids) {
        const { data } = await admin.auth.admin.getUserById(id);
        if (data.user) found.add(id);
      }
      return found;
    },
    async insert(table, rows) {
      // upsert + ignoreDuplicates = INSERT … ON CONFLICT (pk) DO NOTHING; only new rows come back.
      // defaultToNull: false lets columns missing from an older backup take their defaults.
      const { data, error } = await admin
        .from(table)
        .upsert(rows, { onConflict: PK[table].join(','), ignoreDuplicates: true, defaultToNull: false })
        .select();
      if (error) throw new Error(error.message);
      return data.length;
    },
    backup: () => takeBackup(admin, url, () => {}),
  };
}

async function main() {
  const { admin, url } = serviceClient();
  const parsed = parseRestoreArgs(process.argv.slice(2), url);
  if (!parsed.ok) {
    console.error(parsed.message);
    process.exit(1);
  }
  console.log(`${parsed.opts.apply ? 'Writing to' : 'Reading (dry run)'} Supabase project: ${projectRef(url)}`);
  try {
    const result = await restore(parsed.opts, supabaseStore(admin, url));
    console.log(restoreReport(result));
  } catch (e) {
    if (e instanceof PartialRestoreError) {
      console.error(`FAILED, stopped at the first error: ${e.message}`);
      console.error('Inserted before the error:', e.inserted);
      console.error('Re-running is safe: rows already back are left alone.');
      process.exit(1);
    }
    throw e;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
