// Full, restorable JSON snapshot of every app table plus audit_log, ids included. READ-ONLY: it
// only selects. Shared by `npm run backup` and by `npm run restore -- --apply` (which backs up
// first). Output contains member emails, so it is written owner-only (0700/0600).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';

// Stable sort keys, so paging can't skip or repeat rows. Parents before children.
// audit_log (migration 005) is included so deleted rows survive even if the log is pruned.
export const BACKUP_TABLES: Record<string, string[]> = {
  rooms: ['id'],
  invites: ['room_id', 'email'],
  members: ['id'],
  fragrances: ['id'],
  rankings: ['member_id', 'fragrance_id'],
  audit_log: ['id'],
};

/** Writes exports/backup-<time>/<table>.json + manifest.json and returns the folder. */
export async function takeBackup(admin: SupabaseClient, url: string, log: (s: string) => void = console.log): Promise<string> {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const dir = join('exports', `backup-${stamp}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const manifest: Record<string, { rows: number; sha256: string }> = {};
  for (const [table, keys] of Object.entries(BACKUP_TABLES)) {
    const rows: unknown[] = [];
    for (let from = 0; ; from += 1000) {
      let q = admin.from(table).select('*');
      for (const k of keys) q = q.order(k);
      const { data, error } = await q.range(from, from + 999);
      if (error) throw new Error(`${table}: ${error.message}`);
      rows.push(...data);
      if (data.length < 1000) break;
    }
    const { count, error } = await admin.from(table).select('*', { count: 'exact', head: true });
    if (error) throw new Error(`${table} count: ${error.message}`);
    if (count !== rows.length) throw new Error(`${table}: fetched ${rows.length} rows but the table has ${count}`);

    const body = JSON.stringify(rows, null, 2);
    writeFileSync(join(dir, `${table}.json`), body, { mode: 0o600 });
    manifest[table] = { rows: rows.length, sha256: createHash('sha256').update(body).digest('hex') };
    log(`${table.padEnd(11)} ${rows.length}`);
  }

  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ created_at: new Date().toISOString(), project: new URL(url).hostname, tables: manifest }, null, 2),
    { mode: 0o600 },
  );
  return dir;
}
