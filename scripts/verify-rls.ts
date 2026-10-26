// Live RLS check against your real Supabase project (complements the offline PGlite tests).
// Creates two throwaway password users, has one build a room, and confirms the other —
// signed in with the public anon key, exactly like the browser — can't read or write it.
// Cleans up after itself.
//
//   npm run verify-rls
//
// Requires the Email provider enabled (it is by default) and SUPABASE_SERVICE_ROLE_KEY.
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { ensureUser, serviceClient } from './env';

const { admin, url, anonKey } = serviceClient();
if (!anonKey) {
  console.error('Missing VITE_SUPABASE_ANON_KEY');
  process.exit(1);
}

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

async function signedIn(email: string, password: string) {
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

async function main() {
  const tag = randomUUID().slice(0, 8);
  const password = `pw-${randomUUID()}`;
  const ownerUser = await ensureUser(admin, `rls-owner-${tag}@example.com`, 'RLS Owner', password);
  const outsiderUser = await ensureUser(admin, `rls-outsider-${tag}@example.com`, 'RLS Outsider', password);

  try {
    const owner = await signedIn(ownerUser.email!, password);
    const outsider = await signedIn(outsiderUser.email!, password);

    const { data: room, error: roomErr } = await owner.rpc('create_room', { p_name: 'RLS check', p_display_name: 'Owner' });
    if (roomErr) throw roomErr;
    const { data: me } = await owner.from('members').select('id').eq('room_id', room.id).single();
    const { data: frag, error: fErr } = await owner
      .from('fragrances')
      .insert({ room_id: room.id, name: 'Test', house: 'Test', added_by: me!.id })
      .select()
      .single();
    if (fErr) throw fErr;
    await owner.from('rankings').insert({ room_id: room.id, member_id: me!.id, fragrance_id: frag.id, tier: 'S' });

    for (const table of ['fragrances', 'rankings', 'members', 'invites'] as const) {
      const { data, error } = await outsider.from(table).select('*').eq('room_id', room.id);
      check(`outsider cannot read ${table}`, !error && data!.length === 0, error?.message ?? `${data!.length} rows`);
    }
    const { data: rooms } = await outsider.from('rooms').select('*').eq('id', room.id);
    check('outsider cannot see the room', rooms!.length === 0);

    const join = await outsider.from('members').insert({ room_id: room.id, display_name: 'Sneaky' });
    check('outsider cannot join', !!join.error, join.error?.message);
    const add = await outsider.from('fragrances').insert({ room_id: room.id, name: 'X', house: 'Y' });
    check('outsider cannot add fragrances', !!add.error, add.error?.message);
    const inv = await outsider.from('invites').insert({ room_id: room.id, email: outsiderUser.email });
    check('outsider cannot invite themselves', !!inv.error, inv.error?.message);
    await outsider.from('rankings').delete().eq('room_id', room.id);
    const { data: still } = await owner.from('rankings').select('*').eq('room_id', room.id);
    check("outsider cannot delete the owner's rankings", still!.length === 1);

    const anon = createClient(url, anonKey, { auth: { persistSession: false } });
    const anonRead = await anon.from('fragrances').select('*').eq('room_id', room.id);
    check('signed-out client cannot read', !!anonRead.error || anonRead.data!.length === 0, anonRead.error?.message);

    await owner.from('invites').insert({ room_id: room.id, email: outsiderUser.email });
    const joined = await outsider.from('members').insert({ room_id: room.id, display_name: 'Friend' });
    check('after invite: can join', !joined.error, joined.error?.message);
    const { data: visible } = await outsider.from('fragrances').select('*').eq('room_id', room.id);
    check('after invite: can read fragrances', visible!.length === 1);

    await owner.from('invites').delete().eq('room_id', room.id).eq('email', outsiderUser.email!);
    const { data: revoked } = await outsider.from('fragrances').select('*').eq('room_id', room.id);
    check('after uninvite: access revoked', revoked!.length === 0);

    await admin.from('rooms').delete().eq('id', room.id);
  } finally {
    await admin.auth.admin.deleteUser(ownerUser.id);
    await admin.auth.admin.deleteUser(outsiderUser.id);
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll RLS checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
