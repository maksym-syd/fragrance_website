// Backfills fragrance details in two explicit phases. See the upgrade runbook in README.md.
//
//   Plan (default; reads files only, never connects to a database):
//     npm run backfill -- --input exports/backup-X/fragrances.json --csv /path/parfumo.csv
//   Rehearse against the live database (needs the service key; reads only):
//     npm run backfill -- --apply --plan-file exports/backfill-plan.json
//   Write, after reviewing the rehearsal:
//     npm run backfill -- --apply --plan-file exports/backfill-plan.json --no-dry-run
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { applyPlan, buildPlan, hashRankings, planMarkdown, TABLES, toDetails, type Details, type LiveRow, type Plan, type Store } from './lib/backfill';
import { cleanRows } from './lib/parfumo';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function writePlan() {
  const input = arg('--input');
  const csv = arg('--csv');
  if (!input || !csv) {
    console.error('Usage: npm run backfill -- --input <fragrances.json> --csv <parfumo.csv> [--out-json f] [--out-md f]');
    process.exit(1);
  }
  const outJson = arg('--out-json') ?? 'exports/backfill-plan.json';
  const outMd = arg('--out-md') ?? 'exports/backfill-plan.md';
  const live = JSON.parse(readFileSync(input, 'utf8')) as LiveRow[];
  const plan = buildPlan(live, cleanRows(readFileSync(csv, 'utf8')).rows, input.split('/').slice(-2).join('/'));
  const md = planMarkdown(plan);
  if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(md)) throw new Error('Plan output contains something like an email address');
  mkdirSync(dirname(outJson), { recursive: true });
  mkdirSync(dirname(outMd), { recursive: true });
  writeFileSync(outJson, JSON.stringify(plan, null, 2));
  writeFileSync(outMd, md);
  console.log(plan.summary);
  console.log(`-> ${outJson}\n-> ${outMd}\nNothing was applied.`);
}

async function supabaseStore(): Promise<Store> {
  const { serviceClient } = await import('./env');
  const { admin } = serviceClient();
  const columns = 'name,house,concentration,notes,perfumers,accords,notes_top,notes_heart,notes_base,release_year';
  return {
    async snapshot() {
      const counts = {} as Record<(typeof TABLES)[number], number>;
      for (const t of TABLES) {
        const { count, error } = await admin.from(t).select('*', { count: 'exact', head: true });
        if (error) throw new Error(`${t}: ${error.message}`);
        counts[t] = count ?? 0;
      }
      const rankings = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await admin.from('rankings').select('*').order('member_id').order('fragrance_id').range(from, from + 999);
        if (error) throw new Error(`rankings: ${error.message}`);
        rankings.push(...data);
        if (data.length < 1000) break;
      }
      return { counts, rankingsHash: hashRankings(rankings) };
    },
    async backup() {
      const out = execFileSync('npx', ['tsx', 'scripts/backup.ts'], { encoding: 'utf8' });
      const dir = out.match(/-> (.+?)\/?\s*$/m)?.[1];
      if (!dir) throw new Error(`Backup printed no directory:\n${out}`);
      return dir;
    },
    async fetchRow(id) {
      const { data, error } = await admin.from('fragrances').select(columns).eq('id', id).maybeSingle();
      if (error) throw new Error(`${id}: ${error.message}`);
      return data ? toDetails({ id, ...(data as unknown as Details) }) : null;
    },
    async update(id, patch, guard) {
      const { data, error } = await admin
        .from('fragrances')
        .update(patch)
        .eq('id', id)
        .eq('name', guard.name)
        .eq('house', guard.house)
        .select('id');
      if (error) throw new Error(error.message);
      return data.length;
    },
  };
}

async function apply() {
  const planFile = arg('--plan-file');
  if (!planFile) {
    console.error('--apply needs --plan-file <plan.json>');
    process.exit(1);
  }
  const dryRun = !process.argv.includes('--no-dry-run');
  const plan = JSON.parse(readFileSync(planFile, 'utf8')) as Plan;
  const store = await supabaseStore();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const rollback = join('exports', `backfill-rollback-${stamp}.sql`);
  mkdirSync('exports', { recursive: true });
  const r = await applyPlan(plan, store, { dryRun, writeRollback: (sql) => writeFileSync(rollback, sql, { mode: 0o600 }) });

  console.log(dryRun ? 'DRY RUN: nothing was written. Add --no-dry-run to write.' : `Backup: ${r.backup}`);
  console.log({ updated: r.updated.length, wouldUpdate: r.wouldUpdate.length, unchanged: r.unchanged.length, skipped: r.skipped.length, failed: r.failed.length });
  for (const s of r.skipped) console.log(`skipped ${s.id}: ${s.reason}`);
  for (const f of r.failed) console.log(`FAILED  ${f.id}: ${f.reason}`);
  console.log('Row counts and rankings hash identical before and after:', r.after.counts, r.after.rankingsHash);
  if (!dryRun) console.log(`Rollback: ${rollback}`);
  if (r.failed.length) process.exitCode = 1;
}

(process.argv.includes('--apply') ? apply() : Promise.resolve(writePlan())).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
