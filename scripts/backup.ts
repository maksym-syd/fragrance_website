// Full, restorable JSON snapshot of every app table, ids included. READ-ONLY: it only selects.
// Uses the service key (bypasses RLS). Output goes to exports/ (gitignored) and contains
// member emails, so keep it private.
//   npm run backup
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serviceClient } from './env';

// Stable sort keys, so paging can't skip or repeat rows. Parents before children.
const TABLES: Record<string, string[]> = {
  rooms: ['id'],
  invites: ['room_id', 'email'],
  members: ['id'],
  fragrances: ['id'],
  rankings: ['member_id', 'fragrance_id'],
};

async function main() {
  const { admin, url } = serviceClient();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const dir = join('exports', `backup-${stamp}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const manifest: Record<string, { rows: number; sha256: string }> = {};
  for (const [table, keys] of Object.entries(TABLES)) {
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
    const file = join(dir, `${table}.json`);
    writeFileSync(file, body, { mode: 0o600 });
    manifest[table] = { rows: rows.length, sha256: createHash('sha256').update(body).digest('hex') };
    console.log(`${table.padEnd(11)} ${rows.length}`);
  }

  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ created_at: new Date().toISOString(), project: new URL(url).hostname, tables: manifest }, null, 2),
    { mode: 0o600 },
  );
  console.log(`-> ${dir}/`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
