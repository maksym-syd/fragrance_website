// Creates a demo room with 4 fake members and ~30 rankings so the Overlap view has something to show.
//
//   npm run seed -- --yes --invite you@example.com
//
// Needs SUPABASE_SERVICE_ROLE_KEY. Fake members are real (password-less) auth users with
// @example.com emails; they can't sign in. --invite adds your email so you can open the room.
import { POPULAR } from '../src/lib/popular';
import type { Tier } from '../src/lib/overlap';
import { ensureUser, randomCode, serviceClient } from './env';

const args = process.argv.slice(2);
const inviteIdx = args.indexOf('--invite');
const invite = inviteIdx >= 0 ? args[inviteIdx + 1]?.trim().toLowerCase() : undefined;

if (!args.includes('--yes') || !invite) {
  console.log('Usage: npm run seed -- --yes --invite you@example.com');
  console.log('Creates a demo room in your Supabase project and invites your email to it.');
  process.exit(1);
}

const PEOPLE = ['Ana', 'Ken', 'Mia', 'Leo'] as const;
type Person = (typeof PEOPLE)[number];

// Designed so the Overlap view shows a bit of everything: a close pair (Ana/Mia), a contrarian
// (Ken loves oud), a unanimous favourite (Santal 33) and a divisive one (Aventus).
const RANKS: Record<string, Partial<Record<Person, Tier>>> = {
  'Santal 33':          { Ana: 'S', Ken: 'A', Mia: 'S', Leo: 'A' },
  'Baccarat Rouge 540': { Ana: 'A', Ken: 'C', Mia: 'A', Leo: 'B' },
  'Aventus':            { Ana: 'D', Ken: 'S', Mia: 'C', Leo: 'S' },
  'Tobacco Vanille':    { Ana: 'S', Ken: 'B', Mia: 'A', Leo: 'A' },
  'Oud Wood':           { Ana: 'D', Ken: 'S', Mia: 'C' },
  'Interlude Man':      { Ana: 'C', Ken: 'S', Leo: 'D' },
  'Replica Jazz Club':  { Ana: 'A', Mia: 'A', Leo: 'B' },
  'Sauvage':            { Ana: 'C', Ken: 'B', Mia: 'D', Leo: 'S' },
  'Bleu de Chanel':     { Ken: 'A', Leo: 'A' },
  'Khamrah':            { Ana: 'S', Mia: 'S', Ken: 'B' },
  'Light Blue':         { Mia: 'B', Leo: 'C' },
  "Terre d'Hermès":     { Ken: 'A' },
  'Lost Cherry':        { Leo: 'A' },
};

async function main() {
  const { admin } = serviceClient();

  const users = await Promise.all(
    PEOPLE.map((name) => ensureUser(admin, `${name.toLowerCase()}.demo@example.com`, name)),
  );
  const owner = users[0];

  const code = randomCode();
  const { data: room, error: roomErr } = await admin
    .from('rooms')
    .insert({ code, name: 'Demo Sniff Club', owner_id: owner.id })
    .select()
    .single();
  if (roomErr) throw roomErr;

  const inviteEmails = [...users.slice(1).map((u) => u.email!), invite];
  const { error: invErr } = await admin.from('invites').insert(inviteEmails.map((email) => ({ room_id: room.id, email })));
  if (invErr) throw invErr;

  const { data: members, error: memErr } = await admin
    .from('members')
    .insert(users.map((u, i) => ({ room_id: room.id, user_id: u.id, email: u.email, display_name: PEOPLE[i] })))
    .select();
  if (memErr) throw memErr;
  const memberId = (p: Person) => members!.find((m) => m.display_name === p)!.id;

  const fragrances = Object.keys(RANKS).map((name, i) => {
    const p = POPULAR.find((x) => x.name === name)!;
    return { room_id: room.id, ...p, added_by: memberId(PEOPLE[i % PEOPLE.length]) };
  });
  const { data: frags, error: fragErr } = await admin.from('fragrances').insert(fragrances).select();
  if (fragErr) throw fragErr;

  const rankings = frags!.flatMap((f) =>
    Object.entries(RANKS[f.name]).map(([person, tier]) => ({
      room_id: room.id,
      member_id: memberId(person as Person),
      fragrance_id: f.id,
      tier,
    })),
  );
  const { error: rankErr } = await admin.from('rankings').insert(rankings);
  if (rankErr) throw rankErr;

  console.log(`Demo room created: ${room.name} (${code}) — ${frags!.length} fragrances, ${rankings.length} rankings.`);
  console.log(`Invited ${invite}. Open /r/${code}, join, and check the Overlap tab.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
