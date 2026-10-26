import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** Loads .env.local / .env and returns a service-role client (bypasses RLS — scripts only). */
export function serviceClient(): { admin: SupabaseClient; url: string; anonKey: string } {
  for (const f of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(f);
    } catch {
      /* file not present */
    }
  }
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY ?? '';
  if (!url || !serviceKey) {
    console.error('Missing VITE_SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY (see .env.example).');
    process.exit(1);
  }
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return { admin, url, anonKey };
}

/** Create a confirmed auth user, or return the existing one with that email. */
export async function ensureUser(admin: SupabaseClient, email: string, fullName: string, password?: string) {
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (created.data.user) return created.data.user;
  for (let page = 1; page < 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const found = data.users.find((u) => u.email === email);
    if (found) return found;
    if (data.users.length < 200) break;
  }
  throw created.error ?? new Error(`Could not create ${email}`);
}

export function randomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}
