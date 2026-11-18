// Full, restorable JSON snapshot of every app table and audit_log, ids included. READ-ONLY: it
// only selects. Uses the service key (bypasses RLS). Output goes to exports/ (gitignored) and
// contains member emails, so keep it private. Old backups are never deleted automatically.
//   npm run backup
import { takeBackup } from './lib/backup';
import { serviceClient } from './env';

async function main() {
  const { admin, url } = serviceClient();
  const dir = await takeBackup(admin, url);
  console.log(`-> ${dir}/`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
