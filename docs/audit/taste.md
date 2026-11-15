# Taste audit: making "what are our tastes like" insightful

Status: proposal (2026-11-15). Nothing here is implemented. No migration files were created; the
schema drafts in §8 are for review only.

Scope read: `README.md`, `supabase/migrations/001–004`, `src/lib/*.ts`, `src/components/Overlap.tsx`,
`AccordsSection.tsx`, `MyTiers.tsx` (plus `TierSheet.tsx` and `useRoom.ts` where they touch rankings).

**TL;DR.** The Overlap tab already has the right *sections*. It mostly shows raw averages, though.
The insight is in the *differences*: how you rate a note **compared with how you rate everything else**,
how sure we are about a match, and *which* bottles and notes cause it. Every proposal in P1 and P2
runs client-side on data `useRoom` already loads (`fragrances`, `rankings`, `members`). None of them
needs a schema change. Two optional schema additions (§8) would unlock human-written "why"s and a
"want to try / not for me" signal.

---

## 1. What's already done vs. what's missing

| Area | Done today | Gap |
|---|---|---|
| Pair match | `tasteMatch` = 100 − mean\|diff\|/4·100, `MIN_COMMON = 2`; list + heatmap; "N in common" shown | 2 shared bottles can show 100% and beat a solid 88% over 15 (`allPairs` sorts by raw score). Strictness counts as disagreement: a generous and a harsh ranker with the *same order* score 75%. No drill-down into *why* two people match. |
| Favourite notes/accords | `noteOverlap` / `accordOverlap`: average tier per person per tag, top 16 notes / 12 accords by frequency; `noteInsights` strings (thresholds 3.5 / 2.5 on the raw average) | Raw average, not relative to the person: someone who rates everything A "likes" every note. One S bottle with oud counts the same as five vanilla bottles. Tables are sorted by how common a tag is, not by what's distinctive. There's no per-person view ("your nose"). Perfumers and houses (migration 003) are never used. |
| Recommendations | `tryNext`: S/A bottles from the single closest match | Picks the closest match by raw score (see the 2-shared problem). Ignores everyone else and ignores notes. No explanation beyond "your closest match loves these". Can't say "you'd probably *not* like this". |
| Disagreement | `mostDivisive` (room-wide max−min ≥ 3), `Extremes` names who sits at each end | Nothing pair-specific ("where you and Ken split"). Nothing personal ("your hot takes"). It can't tell one outlier from a room split down the middle. No note-level disagreement. |
| Unanimous | `everyoneLoves` (2+ rankers, all ≥ A) | Fine. Could add "everyone avoids" as its mirror (cheap). |
| Few shared items | A "need 2+ in common" placeholder. `QuickRank` already puts the most-ranked bottles first | Nothing tells you *which* bottles to rank to unlock or sharpen a match with a specific person. No fallback signal when two people have ranked different bottles. |
| Nav | `JUMPS` | "By accord" has no jump link (open follow-up from the design review). |

---

## 2. Core building block: personal baseline + shrunk "lift"

Most proposals below share two small pure helpers. They would live in `src/lib/taste.ts`, next to
`overlap.ts`, and be tested the same way.

```ts
/** Each member's mean tier value over everything they ranked (their "strictness"). */
memberBaseline(idx: RankIndex): Map<memberId, { mean: number; count: number }>

/**
 * For each member and tag: how much higher (or lower) than their own average they rank bottles
 * carrying that tag, pulled towards 0 when there's little evidence.
 *   lift = Σ (v − μ_member) / (count + K)        K = 2
 */
tagLift(fragrances, idx, tagsOf, K = 2): Map<memberId, Map<tag, { lift: number; count: number; avg: number }>>
```

Why this shape:

- **Centering on the person's own mean** removes strictness. Generous Mia (mean 4.2) giving vanilla
  bottles A is *below* her norm. Harsh Ken (mean 2.6) giving them B is *above* his.
- **Ubiquitous notes fall to ~0 by themselves.** If musk is in 90% of your bottles, its average *is*
  your average, so lift ≈ 0. No IDF weighting is needed.
- **The `+K` in the denominator** is a simple shrinkage. One S bottle never outranks a consistent
  pattern:

  | Mia, μ = 3.4 | ranked | Σ(v−μ) | lift (K=2) |
  |---|---|---|---|
  | vanilla | S, S, A (5,5,4) | 3.8 | **+0.76** |
  | oud | S (5) | 1.6 | +0.53 |
  | iris | C, B (2,3) | −1.8 | −0.45 |

- Reading it: lift is in tier units. +0.76 ≈ "three-quarters of a tier above your usual".
  Suggested labels: **≥ +0.5 "draws you in"**, **≤ −0.5 "puts you off"**, otherwise not shown.

`tagOverlap` in `overlap.ts` already does the grouping. `tagLift` is the same loop with `v − μ` and a
different divisor, so it can reuse `normalizeNote` and the "unique tags per fragrance" logic.

Known limit: notes co-occur (vanilla + tonka, bergamot + lemon). They're the same signal counted
twice. That's fine for a profile. Explanations (§5) should cap at two tags so they don't read as
"vanilla, tonka, benzoin, amber…".

---

## 3. Favourite notes and accords per person ("Your nose")

**Shows:** a per-person card. *Draws you in*: top 3–5 accords and notes by lift. *Puts you off*:
bottom 3. Plus strictness ("You rank a bit generously: average A−, room average B+") and, where the
data exists, a house or perfumer streak.

**Algorithm:**
1. `memberBaseline` → mean and count. Strictness = member mean − mean of all members' means.
2. `tagLift` three times: accords (`f.accords`), notes (`f.notes`), perfumers (`f.perfumers`).
   Houses use `tagsOf = f => [canonicalHouse(f.house)]`.
3. Keep tags with `count ≥ 2`. Sort by lift. Take the top N with lift ≥ +0.5 and the bottom N with
   lift ≤ −0.5.
4. Accords first, because they're broader and better filled since the backfill. Notes second.
   Perfumers and houses only when count ≥ 3 (otherwise it's anecdote).
5. Empty states: fewer than 5 ranked → "Rank 5+ to see your nose". No tag with |lift| ≥ 0.5 →
   "No strong pulls yet. Your tiers don't lean towards any accord."

**Optional weighting (experiment, behind a backtest; see §9):** pyramid position. Base notes are
what you wear for hours, so weight base 1.0, heart 1.0, top 0.6, unplaced 1.0. Don't ship unless it
improves prediction error.

**UI sketch.** This goes at the top of Overlap, above "Taste match". It's the most personal section,
and it works even when you're the only one who ranked much.

```
┌─ Your nose ───────────────────────────────────── 23 ranked ─┐
│ Draws you in                    Puts you off                │
│  amber      ▲ +0.9  (6)          aquatic   ▼ −1.1  (4)      │
│  vanilla    ▲ +0.8  (5)          iris      ▼ −0.6  (3)      │
│  leather    ▲ +0.6  (3)                                     │
│                                                             │
│ You rank a bit generously: average A−  (room: B+)           │
│ Francis Kurkdjian bottles: 3 of 3 in your S/A               │
└─────────────────────────────────────────────────────────────┘
  [ Ana ] [ Ken ] [ Mia ]   ← switch to a friend's nose
```

Phone: the two columns stack. Counts stay visible because they're the confidence.

**Also fix (S):** `noteInsights` and the two "By …" tables.
- Switch `noteInsights` from raw averages (3.5 / 2.5) to lift (±0.5). "Everyone likes vanilla" then
  means everyone likes it *more than their usual*.
- Sort the tables by the spread of lifts across members (what separates people). Keep a toggle back
  to "most common".
- Show the cell as the tier letter (unchanged) plus a ▲/▼ when |lift| ≥ 0.5.

**Effort:** M for the card plus `taste.ts` and tests. S for the insight and table changes on their own.
**Schema:** none.

---

## 4. Friend-to-friend similarity that's honest about little data

### 4a. Confidence and shrinkage (S)

**Shows:** the same % as today, plus a confidence tag. Ordering ("closest match", the `tryNext`
source, pair sort) uses a shrunk score, so 2 lucky bottles don't win.

**Algorithm:**
```
raw     = tasteMatch(a, b).score                  // unchanged, still what's displayed
prior   = mean of all scored pairs in the room, or 60 when there are none
          // 60 = expected score for two people ranking uniformly at random: E|a−b| = 1.6
shrunk  = (n·raw + K·prior) / (n + K)              K = 3
label   = n < 5 → "rough" · n < 10 → "fair" · else "solid"
```
| n shared | raw | shrunk (prior 60) |
|---|---|---|
| 2 | 100 | 76 |
| 5 | 100 | 85 |
| 15 | 88 | 83 |

`allPairs` and `tryNext` sort by `shrunk`. `PairRow` shows `raw%` and a muted label. The heatmap
cell for a "rough" pair gets a dashed outline instead of a full fill.

```
  Ken     ███████████░░  88%   solid · 15 in common
  Leo     █████████████ 100%   rough ·  2 in common
```

### 4b. "Same taste, different strictness" (S)

**Shows:** a one-line callout when two people order bottles the same way but use different letters.

**Algorithm:** compute the match a second time on centred values (`v − μ_member`, clamped to ±4).
If `centred − raw ≥ 15` and `n ≥ 5`: "You and Ken like the same things. Ken just grades harder (by
about a tier)." Example: Ana S,A,A,B and Ken A,B,B,C. Raw is 75%, centred is 100%.

Keep the raw number as the headline. People compare letters, and "75%" matches what they see in
the side-by-side table. The callout explains the gap.

### 4c. Nose similarity: a fallback when you share few bottles (M)

**Shows:** when two people have fewer than 2 bottles in common, or a "rough" match, compare their
*profiles* instead: "No bottles in common yet, but your noses line up: you're both into amber and
leather, and both off aquatics."

**Algorithm:** cosine similarity of the two people's lift vectors (§2) over the accords and notes
*both* have count ≥ 2 for. It needs ≥ 3 such tags. Map −1..1 to words (≥ 0.5 "line up",
≤ −0.3 "pull in opposite directions"), not a %. That way it isn't confused with the bottle match.
Shared tags with the same sign and |lift| ≥ 0.4 become the explanation.

Shown inside the pair row (4d) and in place of the "need 2+ in common" text. Never in the heatmap.
Two different numbers in one grid would mislead.

### 4d. Pair drill-down: "You × Ken" (M)

**Shows:** tapping a pair row expands it to explain the number. This is where disagreement and
"rank to sharpen" live too (§6, §7).

```
▾ You × Ken    88% · solid · 15 in common
  ─────────────────────────────────────────────────────────
  Both love      Grand Soir  S S · Tobacco Vanille  S A
  Split on       Sauvage     You A · Ken D
                 Bal d'Afrique  You C · Ken S
  Noses          both into amber, leather · you like iris, Ken doesn't
  Sharpen it     Rank Ombré Leather, Hacivat — Ken has strong views on them
```

**Algorithm:** for shared bottles, `diff = v_me − v_them`. *Both love*: both ≥ A, sorted by sum.
*Split on*: |diff| ≥ 2, sorted by |diff|, max 3. *Noses*: from 4c. *Sharpen*: from §7.

**Effort:** 4a S, 4b S, 4c M, 4d M. **Schema:** none.

---

## 5. "You'd probably like X because…"

**Shows:** an upgraded *Try next* with a predicted tier and one sentence of reasons for each bottle.
Plus a mirror list, *Probably not for you*. The same prediction can appear in `TierSheet` for a
bottle you haven't ranked: "Probably A for you: Ken and Mia love it, and it's amber-heavy."

**Algorithm.** It blends two signals. Both are cheap at this scale (< 10 members, < 200 bottles).

1. **People signal** (collaborative), for each other member *o* who ranked *f*:
   ```
   w_o   = max(0, (shrunk_match(me, o) − 60) / 40)      // only people closer than chance
   cfDev = Σ w_o · (v_o,f − μ_o) / Σ w_o               // their enthusiasm relative to their own norm
   ```
2. **Nose signal** (content), over f's accords and notes where I have count ≥ 2:
   ```
   ctDev = Σ lift_me(t) · count_me(t) / Σ count_me(t)
   ```
3. Blend, trusting people more when there are close people:
   ```
   α    = Σw / (Σw + 1)
   pred = μ_me + α·cfDev + (1 − α)·ctDev               → nearest tier letter = "probably A"
   ```
4. Candidates: bottles I haven't ranked, with at least one signal. *Try next* = pred ≥ μ_me + 0.5,
   sorted by pred. *Probably not* = pred ≤ μ_me − 0.75.

**Explanations.** These are generated from the biggest contributors, never free text:
- The person term with the largest `w_o · (v_o − μ_o)`. "Ken (88% match) gave it S".
  If two people contribute, "Ken and Mia love it".
- Up to 2 tags with the largest positive `lift_me`: "and it's heavy on amber and vanilla, your two
  strongest pulls".
- One caveat, the most negative tag in f with lift ≤ −0.5: "though it has iris, which you usually
  rank a tier lower".
- When only the nose signal exists: "Nobody close to you has tried it, but it's amber + leather".

```
Try next — for you
  Ombré Leather     Tom Ford          probably A
    Ken (88%) gave it S, and it's leather + amber, your strongest pulls.
  Grand Soir        MFK               probably A
    Ken and Mia love it. It's amber-heavy.
  Hacivat           Nishane           probably B+
    Nobody close to you has tried it, but it's woody + fruity.
    Heads-up: it has pineapple, which you usually rank lower.
  ── Probably not for you ──
  Acqua di Gio      Armani            probably C   aquatic, your weakest accord
```

**Effort:** M (`predictTier`, `explain`, tests, replacing the body of the Try next section).
**Schema:** none. With §8b, dismissed bottles can be left out.

---

## 6. Disagreement highlights

| Idea | Shows | Algorithm | Effort |
|---|---|---|---|
| **Split on** (pair) | In the pair drill-down (4d): bottles you two rank ≥ 2 tiers apart | `\|v_me − v_o\| ≥ 2` over shared bottles | S |
| **Your hot takes** | Bottles where you're far from everyone else: "You put Sauvage in A; the room averages C" | For each of my bottles with ≥ 2 other rankers: `v_me − mean(others)`, keep \|·\| ≥ 1.5, max 5 | S |
| **Lone wolf vs. split room** | Labels on *Most divisive*: "Leo vs. everyone" or "Split down the middle" | If removing one ranker drops the spread to ≤ 1 → lone wolf (name them). Else if ≥ 2 people sit at each end → split. | S |
| **Note fault lines** | Room-level: "Iris divides the room: Ana and Mia ▲, Ken and Leo ▼" | Per tag, members with count ≥ 2. Fault line if at least one lift ≥ +0.5 and at least one ≤ −0.5. Sort by max − min lift. Replaces part of `noteInsights`. | S (after §2) |
| **Everyone avoids** | Mirror of *Everyone loves* | 2+ rankers, all ≤ C | S |

```
Your hot takes
  Sauvage          you A   room C (3)     ▲ 1.7 above
  Baccarat Rouge   you C   room A (4)     ▼ 1.8 below

Most divisive
  Bal d'Afrique    S Ken · D Leo, Ana     split down the middle
  Aventus          S Leo · B Ana, Ken, Mia   Leo vs. everyone
```

**Schema:** none.

---

## 7. Few shared items: turn the gap into a prompt

**Shows:** "Rank these to sharpen your match with Ken". Also, on the empty state and in *Quick
rank*, an ordering that prioritises the bottles that teach the most.

**Algorithm (per pair):** candidates are bottles *o* ranked and I haven't. The score is how
informative the bottle is: `|v_o − μ_o|` (their strong opinions separate tastes best), plus 0.5 if
others ranked it too (it improves several matches at once). Show the top 3.

**Room-wide variant:** `QuickRank` *already* orders unranked bottles by how many others ranked
them, which is the right default. The only addition (S) is to put the per-pair "sharpen" picks first
when you open Quick rank from a pair's drill-down.

```
No match with Leo yet — 1 bottle in common.
Rank these to get one:  [Aventus  S]  [Erba Pura  D]  [Lost Cherry  A]   → Quick rank
```

**Effort:** S. **Schema:** none.

---

## 8. Schema proposals: optional, additive, NOT created as files

Nothing in §3–§7 needs these. They're worth considering only after P1 lands and people use it.
Both are additive. If adopted they'd become `005_*.sql` / `006_*.sql`, follow the README's "apply
before frontend" order, and get PGlite coverage in `rls.test.ts`.

### 8a. A short "why" on a ranking

Lets explanations quote people: "Ken: 'smells like a library, in a good way'". This is the only
real source of *human* reasons.

```sql
-- DRAFT 005_ranking_reason.sql: a short optional reason on a ranking.
-- Additive. The table-level grant on rankings (001) already covers the new column for
-- select/insert/update. RLS is unchanged: others can read it; only the owner of the ranking writes it.
begin;
alter table public.rankings
  add column if not exists reason text;
alter table public.rankings drop constraint if exists rankings_reason_check;
alter table public.rankings add constraint rankings_reason_check
  check (reason is null or char_length(btrim(reason)) between 1 and 140);
commit;
```
```sql
-- ROLLBACK 005 (destroys any reasons written; back up first with `npm run backup`).
-- Roll back the frontend first, or its writes that include `reason` will fail.
begin;
alter table public.rankings drop constraint if exists rankings_reason_check;
alter table public.rankings drop column if exists reason;
commit;
```
Note: `useRoom.setTier` upserts the ranking row. When reasons exist, the tier upsert must not send
`reason: null` and wipe them, so send only the columns being changed.

### 8b. "Want to try" / "Not for me" for unranked bottles

Today "unranked" means "haven't tried", which mixes up curiosity and disinterest. This lets *Try
next* skip what you've ruled out, and *Want to try* feed the room's "who should bring a sample"
view.

```sql
-- DRAFT 006_interest.sql: a per-member interest flag on bottles they haven't ranked.
-- Same ownership model as rankings: room members read; only you write your own rows.
-- Uninvite cascades via the member FK, like rankings.
begin;
create table if not exists public.interest (
  room_id       uuid not null references public.rooms (id) on delete cascade,
  member_id     uuid not null,
  fragrance_id  uuid not null,
  kind          text not null check (kind in ('want', 'skip')),
  updated_at    timestamptz not null default now(),
  primary key (member_id, fragrance_id),
  foreign key (member_id, room_id)    references public.members (id, room_id)    on delete cascade,
  foreign key (fragrance_id, room_id) references public.fragrances (id, room_id) on delete cascade
);
create index if not exists interest_room_idx on public.interest (room_id);

revoke all on public.interest from anon, authenticated;
grant select, insert, update, delete on public.interest to authenticated;
alter table public.interest enable row level security;

drop policy if exists interest_select on public.interest;
create policy interest_select on public.interest for select to authenticated
  using (public.is_room_member(room_id));
drop policy if exists interest_insert on public.interest;
create policy interest_insert on public.interest for insert to authenticated
  with check (public.is_room_member(room_id) and public.owns_member(member_id));
drop policy if exists interest_update on public.interest;
create policy interest_update on public.interest for update to authenticated
  using (public.is_room_member(room_id) and public.owns_member(member_id))
  with check (public.is_room_member(room_id) and public.owns_member(member_id));
drop policy if exists interest_delete on public.interest;
create policy interest_delete on public.interest for delete to authenticated
  using (public.is_room_member(room_id) and public.owns_member(member_id));
commit;

-- Realtime is optional (it's personal data, so a refetch is fine). If wanted, run once,
-- outside the transaction:
--   alter publication supabase_realtime add table public.interest;
```
```sql
-- ROLLBACK 006 (drops all want/skip flags; back up first). Dropping the table also removes
-- it from the realtime publication.
begin;
drop table if exists public.interest;
commit;
```
Open question for the owner: should ranking a bottle delete its `interest` row (trigger), or should
the app just ignore interest for ranked bottles? The second is simpler and is the recommendation.

### Explicitly *not* proposed
- **Server-side taste profiles, materialized views or RPCs.** The data is tiny, and everything
  above is a few ms in the browser. Computing on the server would duplicate the math in SQL and
  widen the RLS surface for no gain.
- **Accord strength or weights.** The catalog's accords are a plain list with no strength. Inventing
  weights would be false precision.

---

## 9. How to know it's better (offline, in `npm test`)

Add `src/lib/taste.test.ts` with a synthetic room fixture: ~5 members with known preferences, ~40
bottles with accords and notes. It has no real data, so it needs no Supabase.
- **Unit:** the worked examples in this doc (lift table, shrinkage table, 75% vs 100% strictness
  case) as exact assertions.
- **Backtest:** leave-one-out over every ranking. Hide it, run `predictTier`, and measure mean
  absolute error against two baselines: (a) "your own mean" and (b) today's rule ("closest match's
  tier, else your mean"). Ship §5 only if it beats both. Use the same harness to accept or reject
  pyramid weighting (§3) and to tune K.

A one-off read of real room data (via `npm run backup`) would make a better backtest. That's for
the owner to run, and only if they choose to.

---

## 10. Suggested order

| Phase | Items | Effort | Schema |
|---|---|---|---|
| **P1** | `taste.ts` (baseline, lift, shrunk match) + tests · 4a confidence · *Your nose* card (§3) · `noteInsights` and tables on lift · accords jump link | M overall | none |
| **P2** | Try next with predictions and explanations (§5) + backtest · pair drill-down (4d) with Split on and Sharpen · hot takes · lone wolf / split labels · strictness callout (4b) | M | none |
| **P3** | Nose similarity fallback (4c) · note fault lines · everyone avoids · sharpen picks first in Quick rank (§7) · perfumer and house streaks | S–M each | none |
| **Later, if wanted** | 8a reasons in explanations · 8b want/skip | M each | 005 / 006 drafts above |

Risks to watch:
- Lift labels flip-flopping as people rank. K = 2 shrinkage and the count ≥ 2 floor damp this. Show
  counts so changes look earned.
- Over-claiming on tiny rooms. Every generated sentence should be traceable to the counts on screen.
- `tryNext` changes source when its sort key changes to shrunk. That's intended, but call it out in
  the release note.
