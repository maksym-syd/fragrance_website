// Dumps every room's data to CSV files for your own analysis.
// Uses the service key (bypasses RLS), so it sees all rooms. Output goes to exports/ (gitignored).
//   npm run export            -> all rooms
//   npm run export -- K7P2QX  -> one room
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TIER_VALUE } from '../src/lib/overlap';
import { serviceClient } from './env';

type Row = Record<string, string | number | null | undefined>;

const DETAIL_COLUMNS = ['perfumers', 'accords', 'notes_top', 'notes_heart', 'notes_base', 'release_year'];

function csv(rows: Row[], columns: string[]): string {
  const cell = (v: Row[string]) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // BOM so Excel opens UTF-8 (accents in fragrance names) correctly.
  return '﻿' + [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

async function all<T>(admin: ReturnType<typeof serviceClient>['admin'], table: string, roomIds: string[] | null): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = admin.from(table).select('*').range(from, from + 999);
    if (roomIds) q = q.in(table === 'rooms' ? 'id' : 'room_id', roomIds);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data as T[]));
    if (data.length < 1000) return out;
  }
}

interface Room { id: string; code: string; name: string; join_by_code: boolean; created_at: string }
interface Member { id: string; room_id: string; email: string; display_name: string; joined_at: string }
interface Fragrance {
  id: string; room_id: string; name: string; house: string; concentration: string | null; notes: string[];
  perfumers: string[]; accords: string[]; notes_top: string[]; notes_heart: string[]; notes_base: string[]; release_year: number | null;
  added_by: string | null; created_at: string;
}
interface Ranking { room_id: string; member_id: string; fragrance_id: string; tier: keyof typeof TIER_VALUE; updated_at: string }

const details = (f: Fragrance) => ({
  perfumers: f.perfumers.join('; '),
  accords: f.accords.join('; '),
  notes_top: f.notes_top.join('; '),
  notes_heart: f.notes_heart.join('; '),
  notes_base: f.notes_base.join('; '),
  release_year: f.release_year,
});

async function main() {
  const { admin } = serviceClient();
  const onlyCode = process.argv[2]?.trim().toUpperCase();

  let rooms = await all<Room>(admin, 'rooms', null);
  if (onlyCode) rooms = rooms.filter((r) => r.code === onlyCode);
  if (rooms.length === 0) {
    console.log(onlyCode ? `No room with code ${onlyCode}.` : 'No rooms yet — nothing to export.');
    return;
  }
  const ids = rooms.map((r) => r.id);
  const [members, fragrances, rankings] = await Promise.all([
    all<Member>(admin, 'members', ids),
    all<Fragrance>(admin, 'fragrances', ids),
    all<Ranking>(admin, 'rankings', ids),
  ]);

  const roomBy = new Map(rooms.map((r) => [r.id, r]));
  const memberBy = new Map(members.map((m) => [m.id, m]));
  const fragBy = new Map(fragrances.map((f) => [f.id, f]));

  // 1. Long format: one row per (person, fragrance) rating. Best for pandas / pivot tables.
  const rankingRows = rankings.map((r) => {
    const f = fragBy.get(r.fragrance_id)!;
    return {
      room_code: roomBy.get(r.room_id)!.code,
      room_name: roomBy.get(r.room_id)!.name,
      member: memberBy.get(r.member_id)?.display_name,
      fragrance: f.name,
      house: f.house,
      concentration: f.concentration,
      notes: f.notes.join('; '),
      ...details(f),
      tier: r.tier,
      score: TIER_VALUE[r.tier],
      updated_at: r.updated_at,
    };
  }).sort((a, b) => `${a.room_code}${a.member}${a.fragrance}`.localeCompare(`${b.room_code}${b.member}${b.fragrance}`));

  // 2. Fragrances with summary stats.
  const fragRows = fragrances.map((f) => {
    const scores = rankings.filter((r) => r.fragrance_id === f.id).map((r) => TIER_VALUE[r.tier]);
    const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    return {
      room_code: roomBy.get(f.room_id)!.code,
      fragrance: f.name,
      house: f.house,
      concentration: f.concentration,
      notes: f.notes.join('; '),
      ...details(f),
      ratings: scores.length,
      avg_score: mean === null ? null : mean.toFixed(2),
      min_score: scores.length ? Math.min(...scores) : null,
      max_score: scores.length ? Math.max(...scores) : null,
      added_by: f.added_by ? memberBy.get(f.added_by)?.display_name : null,
      added_at: f.created_at,
    };
  });

  // 3. Members.
  const memberRows = members.map((m) => ({
    room_code: roomBy.get(m.room_id)!.code,
    member: m.display_name,
    email: m.email,
    ratings: rankings.filter((r) => r.member_id === m.id).length,
    joined_at: m.joined_at,
  }));

  // 4. Wide matrix per room: fragrance rows x member columns, score 1-5 (blank = not rated).
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const dir = join('exports', stamp);
  mkdirSync(dir, { recursive: true });
  for (const room of rooms) {
    const people = members.filter((m) => m.room_id === room.id).sort((a, b) => a.display_name.localeCompare(b.display_name));
    const rows = fragrances.filter((f) => f.room_id === room.id).map((f) => {
      const row: Row = { fragrance: f.name, house: f.house };
      for (const p of people) {
        const r = rankings.find((x) => x.member_id === p.id && x.fragrance_id === f.id);
        row[p.display_name] = r ? TIER_VALUE[r.tier] : null;
      }
      return row;
    });
    writeFileSync(join(dir, `matrix_${room.code}.csv`), csv(rows, ['fragrance', 'house', ...people.map((p) => p.display_name)]));
  }

  writeFileSync(join(dir, 'rankings.csv'), csv(rankingRows, ['room_code', 'room_name', 'member', 'fragrance', 'house', 'concentration', 'notes', ...DETAIL_COLUMNS, 'tier', 'score', 'updated_at']));
  writeFileSync(join(dir, 'fragrances.csv'), csv(fragRows, ['room_code', 'fragrance', 'house', 'concentration', 'notes', ...DETAIL_COLUMNS, 'ratings', 'avg_score', 'min_score', 'max_score', 'added_by', 'added_at']));
  writeFileSync(join(dir, 'members.csv'), csv(memberRows, ['room_code', 'member', 'email', 'ratings', 'joined_at']));
  writeFileSync(join(dir, 'rooms.csv'), csv(rooms.map((r) => ({ ...r, join_by_code: String(r.join_by_code) })), ['code', 'name', 'join_by_code', 'created_at']));

  console.log(`Exported ${rooms.length} room(s), ${members.length} members, ${fragrances.length} fragrances, ${rankings.length} ratings`);
  console.log(`-> ${dir}/`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
