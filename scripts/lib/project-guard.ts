// Refuses service-key writes unless the operator names the project they mean to write to.
// Pure: no env, no network. Prints the project ref (not secret), never a key.

export type GuardResult = { ok: true; target: string } | { ok: false; message: string };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/** The project ref from https://<ref>.supabase.co, 'local' for localhost, otherwise null. */
export function projectRef(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (LOCAL_HOSTS.has(host)) return 'local';
  const m = host.match(/^([a-z0-9]+)\.supabase\.co$/);
  return m ? m[1] : null;
}

/** Value of --project=<ref> in argv, if given. */
export function projectFlag(argv: string[]): string | undefined {
  const a = argv.find((x) => x.startsWith('--project='));
  return a === undefined ? undefined : a.slice('--project='.length).trim();
}

export function checkProject(url: string | undefined, argv: string[]): GuardResult {
  const ref = url ? projectRef(url) : null;
  if (ref === 'local') return { ok: true, target: 'local' };
  if (!ref) {
    return { ok: false, message: 'Refusing to write: VITE_SUPABASE_URL is not a <ref>.supabase.co or localhost URL.' };
  }
  const flag = projectFlag(argv);
  if (flag === undefined) {
    return {
      ok: false,
      message: `Refusing to write to Supabase project "${ref}" without confirmation. Re-run with --project=${ref} if you mean it.`,
    };
  }
  if (flag !== ref) {
    return { ok: false, message: `Refusing to write: --project=${flag} does not match the configured project "${ref}".` };
  }
  return { ok: true, target: ref };
}

/** For scripts: exit(1) with the reason unless the guard passes. */
export function assertProject(url: string | undefined, argv: string[] = process.argv): string {
  const r = checkProject(url, argv);
  if (!r.ok) {
    console.error(r.message);
    process.exit(1);
  }
  console.log(`Writing to Supabase project: ${r.target}`);
  return r.target;
}
