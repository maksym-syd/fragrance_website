// Backfill logic with no I/O of its own, so it can be tested against PGlite and run on Supabase.
import { createHash } from 'node:crypto';
import { indexByKey, matchExact } from '../../src/lib/catalog';
import { dedupeKey } from '../../src/lib/normalize';
import { canonicalHouse, fold, NOTE_FIXES, splitNotes } from '../../src/lib/reference';
import type { Concentration } from '../../src/lib/types';
import { popularity, type SourceRow } from './parfumo';

export interface Details {
  name: string;
  house: string;
  concentration: Concentration | null;
  notes: string[];
  perfumers: string[];
  accords: string[];
  notes_top: string[];
  notes_heart: string[];
  notes_base: string[];
  release_year: number | null;
}

export interface LiveRow extends Partial<Details> {
  id: string;
  room_id?: string | null;
  name: string;
  house: string;
  notes: string[];
}

export type Section = 'auto' | 'review' | 'unmatched';

export interface SourceRef {
  name: string;
  brand: string;
  year: number | null;
  concentration: Concentration | null;
  url: string;
}

export interface Candidate extends SourceRef {
  why: string;
  /** What the row becomes if a reviewer approves this candidate. */
  after: Details;
}

export interface PlanRow {
  id: string;
  room_id: string | null;
  section: Section;
  reasons: string[];
  before: Details;
  after: Details;
  match: SourceRef | null;
  candidates: Candidate[];
  /** A reviewer sets this to a candidate's index in the plan JSON to accept it. */
  approved_candidate: number | null;
}

export interface Plan {
  version: 1;
  generated_at: string;
  input: string;
  summary: Record<Section, number> & { total: number; changed: number; collisions: number };
  rows: PlanRow[];
}

const COLUMNS: (keyof Details)[] = [
  'name', 'house', 'concentration', 'notes', 'perfumers', 'accords', 'notes_top', 'notes_heart', 'notes_base', 'release_year',
];

export function toDetails(r: LiveRow): Details {
  return {
    name: r.name,
    house: r.house,
    concentration: r.concentration ?? null,
    notes: r.notes ?? [],
    perfumers: r.perfumers ?? [],
    accords: r.accords ?? [],
    notes_top: r.notes_top ?? [],
    notes_heart: r.notes_heart ?? [],
    notes_base: r.notes_base ?? [],
    release_year: r.release_year ?? null,
  };
}

const merge = (...lists: string[][]) => [...new Set(lists.flat())];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Fixes that come only from the reviewed maps. They need no catalog match. */
function hygiene(before: Details): Details {
  const { notes, accords } = splitNotes(before.notes);
  return { ...before, house: canonicalHouse(before.house), notes, accords: merge(before.accords, accords) };
}

/** Adds source data to a row. Anything a member already filled in stays as it is. */
function enrich(base: Details, e: SourceRow): Details {
  const hasPyramid = base.notes_top.length + base.notes_heart.length + base.notes_base.length > 0;
  const top = hasPyramid ? base.notes_top : e.top;
  const heart = hasPyramid ? base.notes_heart : e.heart;
  const bottom = hasPyramid ? base.notes_base : e.base;
  return {
    ...base,
    concentration: base.concentration ?? e.concentration,
    notes: merge(base.notes, top, heart, bottom),
    perfumers: base.perfumers.length ? base.perfumers : e.perfumers,
    accords: merge(e.accords, base.accords),
    notes_top: top,
    notes_heart: heart,
    notes_base: bottom,
    release_year: base.release_year ?? e.year,
  };
}

const ref = (e: SourceRow): SourceRef => ({ name: e.name, brand: e.brand, year: e.year, concentration: e.concentration, url: e.url });

/** Near misses for a human to judge. Word-aligned containment only; never applied on its own. */
function nearMisses(sources: SourceRow[], foldedByHouse: Map<string, SourceRow[]>, row: Details): Array<{ e: SourceRow; why: string }> {
  const name = fold(row.name);
  const house = fold(canonicalHouse(row.house));
  const contains = (a: string, b: string) => ` ${a} `.includes(` ${b} `);
  const out: Array<{ e: SourceRow; why: string }> = [];
  for (const e of foldedByHouse.get(house) ?? []) {
    const n = fold(e.name);
    if (contains(n, name)) out.push({ e, why: `Same house, source name "${e.name}" contains this name` });
    else if (contains(name, n)) out.push({ e, why: `Same house, this name contains source name "${e.name}"` });
  }
  const words = house.split(' ');
  for (const e of sources) {
    if (fold(e.name) !== name) continue;
    const b = fold(e.brand);
    if (b !== house && (contains(b, house) || contains(house, b) || b.split(' ')[0] === words[0])) {
      out.push({ e, why: `Same name, similar house "${e.brand}"` });
    }
  }
  return out.sort((a, b) => popularity(b.e) - popularity(a.e)).slice(0, 5);
}

/** Two rows that would collide on fragrances_room_dedupe_key keep their current house instead. */
function withdrawCollidingRenames(rows: PlanRow[]): number {
  let withdrawn = 0;
  for (;;) {
    const groups = new Map<string, PlanRow[]>();
    for (const r of rows) {
      const k = `${r.room_id ?? ''}|${dedupeKey(r.after.name, r.after.house)}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const clashing = [...groups.values()].filter((g) => g.length > 1).flat().filter((r) => r.after.house !== r.before.house);
    if (clashing.length === 0) return withdrawn;
    for (const r of clashing) {
      const blocked = r.after.house;
      r.after = { ...r.after, house: r.before.house };
      for (const c of r.candidates) c.after = { ...c.after, house: r.before.house };
      r.section = 'review';
      r.reasons.push(`Rename to "${blocked}" withheld: it would collide with another row on fragrances_room_dedupe_key`);
      withdrawn++;
    }
  }
}

export function buildPlan(live: LiveRow[], sources: SourceRow[], input: string, now = new Date()): Plan {
  const byKey = indexByKey(sources);
  const byHouse = new Map<string, SourceRow[]>();
  for (const s of sources) {
    const k = fold(s.brand);
    const list = byHouse.get(k);
    if (list) list.push(s);
    else byHouse.set(k, [s]);
  }

  const rows = live.map((r): PlanRow => {
    const before = toDetails(r);
    const clean = hygiene(before);
    const row: PlanRow = {
      id: r.id, room_id: r.room_id ?? null, section: 'unmatched', reasons: [], before, after: clean,
      match: null, candidates: [], approved_candidate: null,
    };
    if (clean.house !== before.house) row.reasons.push(`House spelling: "${before.house}" -> "${clean.house}"`);
    for (const n of before.notes) {
      const key = n.trim().toLowerCase();
      if (NOTE_FIXES[key]) row.reasons.push(`Note spelling: "${n}" -> "${NOTE_FIXES[key]}"`);
    }
    const moved = clean.accords.filter((a) => !before.accords.includes(a));
    if (moved.length) row.reasons.push(`Moved from notes to accords: ${moved.join(', ')}`);

    const toCandidate = (e: SourceRow, why: string): Candidate => ({ ...ref(e), why, after: enrich(clean, e) });
    const m = matchExact(byKey, before.name, before.house, before.concentration);
    if (m.kind === 'match') {
      const e = m.entry;
      row.section = 'auto';
      row.match = ref(e);
      row.after = enrich(clean, e);
      row.reasons.push(`Exact name and house match: ${e.name} by ${e.brand}${e.year ? ` (${e.year})` : ''}`);
    } else if (m.kind === 'ambiguous' || m.kind === 'conflict') {
      row.section = 'review';
      row.reasons.push(m.reason);
      row.candidates = [...m.candidates].sort((a, b) => popularity(b) - popularity(a)).slice(0, 5).map((e) => toCandidate(e, m.reason));
    } else {
      const near = nearMisses(sources, byHouse, clean);
      if (near.length) {
        row.section = 'review';
        row.reasons.push('No exact match, only near misses');
        row.candidates = near.map(({ e, why }) => toCandidate(e, why));
      } else {
        row.reasons.push(byHouse.has(fold(canonicalHouse(before.house))) ? 'House is in the source, this fragrance is not' : 'House is not in the source');
      }
    }
    return row;
  });

  const collisions = withdrawCollidingRenames(rows);
  const count = (s: Section) => rows.filter((r) => r.section === s).length;
  return {
    version: 1,
    generated_at: now.toISOString(),
    input,
    summary: {
      total: rows.length,
      auto: count('auto'),
      review: count('review'),
      unmatched: count('unmatched'),
      changed: rows.filter((r) => !same(r.before, r.after)).length,
      collisions,
    },
    rows,
  };
}

/** Only the columns that differ. */
export function patchFor(before: Details, after: Details): Partial<Details> {
  const patch: Record<string, unknown> = {};
  for (const c of COLUMNS) if (!same(before[c], after[c])) patch[c] = after[c];
  return patch as Partial<Details>;
}

/** The row's target: the plan's, or a candidate a reviewer approved in the plan JSON. */
export function targetOf(row: PlanRow): Details {
  if (row.approved_candidate === null || row.approved_candidate === undefined) return row.after;
  const c = row.candidates[row.approved_candidate];
  if (!c) throw new Error(`Row ${row.id}: approved_candidate ${row.approved_candidate} doesn't exist`);
  return c.after;
}

/** Why a target breaks the rules, or null. Guards against a hand-edited or corrupted plan. */
export function ruleViolation(row: PlanRow): string | null {
  const after = targetOf(row);
  if (after.name !== row.before.name) return 'changes the name';
  if (row.before.concentration && after.concentration !== row.before.concentration) return 'overwrites a concentration';
  const kept = new Set(after.notes);
  const lost = splitNotes(row.before.notes).notes.filter((n) => !kept.has(n));
  if (lost.length) return `loses member notes: ${lost.join(', ')}`;
  return null;
}

export function hashRankings(rows: Array<{ room_id: string; member_id: string; fragrance_id: string; tier: string; updated_at: string }>): string {
  const lines = rows.map((r) => [r.room_id, r.member_id, r.fragrance_id, r.tier, new Date(r.updated_at).toISOString()].join('|')).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

export const TABLES = ['rooms', 'invites', 'members', 'fragrances', 'rankings'] as const;

export interface Snapshot {
  counts: Record<(typeof TABLES)[number], number>;
  rankingsHash: string;
}

export interface Store {
  snapshot(): Promise<Snapshot>;
  /** Writes a full backup and returns where. Must throw on failure. */
  backup(): Promise<string>;
  fetchRow(id: string): Promise<Details | null>;
  /** Update by id, still guarded on name and house. Returns rows changed. */
  update(id: string, patch: Partial<Details>, guard: { name: string; house: string }): Promise<number>;
}

export interface ApplyResult {
  dryRun: boolean;
  backup: string | null;
  updated: string[];
  wouldUpdate: string[];
  unchanged: string[];
  skipped: Array<{ id: string; reason: string }>;
  failed: Array<{ id: string; reason: string }>;
  before: Snapshot;
  after: Snapshot;
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
function sqlValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return v.length ? `array[${v.map((s) => lit(String(s))).join(', ')}]::text[]` : `'{}'::text[]`;
  return typeof v === 'number' ? String(v) : lit(String(v));
}

/** Rollback for exactly the rows written so far, as SQL for the Supabase editor. */
export function rollbackSql(done: Array<{ id: string; restore: Partial<Details> }>): string {
  const lines = done.map(({ id, restore }) => {
    const sets = Object.entries(restore).map(([c, v]) => `${c} = ${sqlValue(v)}`).join(', ');
    return `update public.fragrances set ${sets} where id = ${lit(id)};`;
  });
  return ['-- Restores the fragrance columns the backfill changed. Touches nothing else.', 'begin;', ...lines, 'commit;', ''].join('\n');
}

/**
 * Applies a reviewed plan. Rows that changed since the plan are skipped. Dry runs read and
 * compare but write nothing, not even the backup. The rollback file is rewritten BEFORE each
 * write, so a crash can't leave a change it doesn't cover.
 */
export async function applyPlan(
  plan: Plan,
  store: Store,
  opts: { dryRun: boolean; writeRollback: (sql: string) => void },
): Promise<ApplyResult> {
  for (const row of plan.rows) {
    const bad = ruleViolation(row);
    if (bad) throw new Error(`Plan refused: row ${row.id} ${bad}`);
  }
  const before = await store.snapshot();
  const backup = opts.dryRun ? null : await store.backup();
  const result: ApplyResult = { dryRun: opts.dryRun, backup, updated: [], wouldUpdate: [], unchanged: [], skipped: [], failed: [], before, after: before };
  const done: Array<{ id: string; restore: Partial<Details> }> = [];

  for (const row of plan.rows) {
    const patch = patchFor(row.before, targetOf(row));
    if (Object.keys(patch).length === 0) {
      result.unchanged.push(row.id);
      continue;
    }
    const current = await store.fetchRow(row.id);
    if (!current) {
      result.skipped.push({ id: row.id, reason: 'row no longer exists' });
      continue;
    }
    const drift = COLUMNS.filter((c) => !same(current[c], row.before[c]));
    if (drift.length) {
      result.skipped.push({ id: row.id, reason: `changed since the plan: ${drift.join(', ')}` });
      continue;
    }
    if (opts.dryRun) {
      result.wouldUpdate.push(row.id);
      continue;
    }
    const restore = Object.fromEntries(Object.keys(patch).map((c) => [c, row.before[c as keyof Details]])) as Partial<Details>;
    done.push({ id: row.id, restore });
    opts.writeRollback(rollbackSql(done));
    try {
      const n = await store.update(row.id, patch, { name: row.before.name, house: row.before.house });
      if (n === 1) {
        result.updated.push(row.id);
      } else {
        done.pop();
        opts.writeRollback(rollbackSql(done));
        result.skipped.push({ id: row.id, reason: 'changed during the update' });
      }
    } catch (e) {
      done.pop();
      opts.writeRollback(rollbackSql(done));
      result.failed.push({ id: row.id, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  result.after = await store.snapshot();
  if (!same(result.before, result.after)) {
    throw new Error(`Integrity check FAILED: tables changed.\nbefore ${JSON.stringify(result.before)}\nafter  ${JSON.stringify(result.after)}`);
  }
  return result;
}

const list = (a: string[]) => (a.length ? a.join(', ') : '—');

function diffLines(before: Details, after: Details): string[] {
  const out: string[] = [];
  for (const c of COLUMNS) {
    if (same(before[c], after[c])) continue;
    const show = (v: unknown) => (Array.isArray(v) ? list(v) : (v ?? '—'));
    out.push(`  - **${c}**: ${show(before[c])} → ${show(after[c])}`);
  }
  return out;
}

export function planMarkdown(plan: Plan): string {
  const s = plan.summary;
  const title = (r: PlanRow) => `### ${r.before.name} · ${r.before.house}${r.before.concentration ? ` · ${r.before.concentration}` : ''}`;
  const block = (r: PlanRow) => {
    const lines = [title(r), '', `\`${r.id}\``, ''];
    lines.push(...r.reasons.map((x) => `- ${x}`));
    const diff = diffLines(r.before, r.after);
    lines.push(diff.length ? '- Changes:' : '- No changes.', ...diff);
    if (r.match?.url) lines.push(`- Source: ${r.match.url}`);
    r.candidates.forEach((c, i) => {
      lines.push(`- Candidate ${i}: **${c.name}** by ${c.brand}, ${c.year ?? 'year unknown'}, ${c.concentration ?? 'concentration unknown'} (${c.why}) ${c.url}`);
    });
    return [...lines, ''].join('\n');
  };
  const section = (name: Section, heading: string, note: string) => {
    const rows = plan.rows.filter((r) => r.section === name);
    return [`## ${heading} (${rows.length})`, '', note, '', ...rows.map(block)].join('\n');
  };
  return [
    '# Backfill plan',
    '',
    `Generated ${plan.generated_at} from \`${plan.input}\`. Nothing has been applied.`,
    '',
    `| Total | Auto-matched | Needs review | Unmatched | Rows that change | Rename collisions |`,
    `| --- | --- | --- | --- | --- | --- |`,
    `| ${s.total} | ${s.auto} | ${s.review} | ${s.unmatched} | ${s.changed} | ${s.collisions} |`,
    '',
    'Every row, in any section, gets the reviewed fixes: house spelling, listed typos, and accord words moved out of notes. Source data (accords, pyramid, perfumers, year, an empty concentration) is applied only to auto-matched rows, or to a needs-review row whose candidate a reviewer approves by setting `approved_candidate` in the plan JSON.',
    '',
    section('auto', 'Auto-matched', 'Exact normalized name and house, with concentration agreeing where both are known.'),
    section('review', 'Needs review', 'Not auto-applied. Check each candidate against its source page.'),
    section('unmatched', 'Unmatched', 'Nothing in the source. Left empty for members to fill in; nothing was invented.'),
  ].join('\n');
}
