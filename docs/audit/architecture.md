# Scent Tiers — architecture & data-safety audit

Read-only discovery, 2026-11-15, at commit `580516e`. Nothing was run against Supabase. Paths are relative to the repo root.

## 1. App structure

**Stack:** Vite + React 18 + TypeScript, react-router v6, `@supabase/supabase-js` (anon key in the browser), `@dnd-kit` for drag-and-drop, `html-to-image` for board export. Deployed on Vercel (`vercel.json`).

### Routes (`src/App.tsx`)
| Route | Component | Notes |
|---|---|---|
| (no Supabase env) | `SetupNeeded` | Shown when `VITE_SUPABASE_*` is missing (`src/lib/supabase.ts`) |
| (no session) | `pages/SignIn.tsx` | Google OAuth or magic link |
| `/` | `pages/Home.tsx` | Lists your rooms (RLS-filtered), create room, enter a code |
| `/r/:code` (index) | `components/MyTiers.tsx` | Your tier board (drag, or keys S/A/B/C/D/U) plus `QuickRank` modal |
| `/r/:code/overlap` | `components/Overlap.tsx` | Read-only taste-overlap maths (`lib/overlap.ts`) |
| `/r/:code/add` | `components/AddFragrance.tsx` | `FragranceForm` + quick-add list (`lib/popular.ts`, catalog) |
| `/r/:code/members` | `components/MembersPanel.tsx` | Rename yourself; owner: invites, join-by-code toggle, delete room |
| `*` | redirect to `/` | |

`pages/Room.tsx` picks a screen from `useRoom().status`: `not-invited` shows `JoinByCode`, `join` shows `JoinRoom`, `ready` shows `RoomView` (tabs + `TierSheet` detail/edit sheet + `SaveIndicator`).

### Hooks
- `hooks/useAuth.ts`: `useSession` (getSession + onAuthStateChange), `signInWithGoogle`, `sendMagicLink` (both redirect back to the current path), `signOut`.
- `hooks/useRoom.ts`: the only data layer for a room. It loads room, members, fragrances, rankings and (owner only) invites. It subscribes to realtime on `members`, `fragrances` and `rankings`, refetches on tab focus and after reconnect, and exposes every mutation (§3). `track()` drives the Saving/Saved indicator and reloads from the server on error. Most writes are optimistic.
- `hooks/useCatalog.ts`: lazily fetches the static `/catalog/catalog-<hash>.json` (Parfumo-derived, built by `scripts/build-catalog.ts`). It never touches the database.

### Lib
`types.ts` (row types), `tiers.ts`, `overlap.ts` (pure scoring), `normalize.ts` (`dedupeKey`, which mirrors the SQL dedupe index), `reference.ts` (`looseKey`, accent-insensitive dedupe), `details.ts` (pyramid/notes helpers), `catalog.ts` (search), `site.ts` (links).

### Auth flow
Supabase Auth only, with Google OAuth or email OTP magic link. The session persists in the browser (`persistSession`, `detectSessionInUrl`). There is no anonymous access: `anon` has every grant revoked. Authorization lives entirely in Postgres RLS (§2). The frontend `isOwner` checks only hide UI.

## 2. Data model (`supabase/migrations/001`–`004`)

Migrations 003 and 004 are marked **"APPLY BY HAND"** in the SQL Editor. There is no migration tracking, so nothing in the repo shows which of them production actually has.

### Tables
| Table | Key columns | Constraints | FKs / ON DELETE |
|---|---|---|---|
| `rooms` | `id` uuid PK, `code` (unique, `^[A-Z0-9]{6}$`), `name` (1–60), `owner_id`, `join_by_code` bool default **true** (002) | | `owner_id → auth.users` **CASCADE** |
| `invites` | PK `(room_id, email)` | email lower/trimmed, has `@` | `room_id → rooms` CASCADE |
| `members` | `id` PK, `user_id` (default `auth.uid()`), `email` (default `auth.email()`), `display_name` (1–40) | unique `(room_id,user_id)`; unique `(room_id, lower(btrim(display_name)))` | `room_id → rooms` CASCADE; `user_id → auth.users` **CASCADE** |
| `fragrances` | `id` PK, `name` (1–80), `house` (1–60), `concentration` ∈ EDT/EDP/Parfum/Extrait, `notes text[]`, `added_by`; 003 adds `perfumers`, `accords`, `notes_top/heart/base text[]`, `release_year` (1700–2100) | unique dedupe index `(room_id, lower(strip-ws name), lower(strip-ws house))` | `room_id → rooms` CASCADE; `(added_by, room_id) → members` **SET NULL (added_by)** |
| `rankings` | PK `(member_id, fragrance_id)`, `tier` ∈ S/A/B/C/D, `updated_at` | composite FKs force same-room | `room_id → rooms` CASCADE; `(member_id,room_id) → members` **CASCADE**; `(fragrance_id,room_id) → fragrances` **CASCADE** |

**Cascade tree:** deleting an `auth.users` row removes every room that user owns, then all of those rooms' invites, members, fragrances and rankings. It also removes that user's member rows (and their rankings) in other rooms. Deleting a room removes everything in it. Deleting a member removes their rankings. Deleting a fragrance removes everyone's rankings of it.

**Trigger:** `invites_remove_member` runs AFTER DELETE on `invites`. It deletes the member with that email, unless that member is the owner, and their rankings go with them by cascade.

**RPCs (SECURITY DEFINER):**
- `create_room(name, display_name)` inserts a room and the creator's member row.
- `join_room_by_code(code, display_name)` upserts an invite and inserts a member. It returns the same error for "no such room" and "invite-only".

### RLS summary
| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| rooms | owner or invitee | only via `create_room` (no grant) | owner; columns `name`, `join_by_code` | **owner** |
| invites | owner, or your own row | owner | (no grant) | **owner** |
| members | joined + still invited | self, if invited/owner | self; `display_name` only | **self or owner** |
| fragrances | member | member (`added_by` must be own) | **any member; any column in the grant** | **owner only** (004; was any member in 001) |
| rankings | member | own | own | own |

Helper functions: `is_room_owner`, `can_access_room`, `is_room_member`, `owns_member`.

**Realtime:** `members`, `fragrances` and `rankings` are in `supabase_realtime`. `rooms` and `invites` are not, so other clients only see room renames and invite changes on refetch.

### Fragrance-site concepts
| Concept | Status |
|---|---|
| Ratings | **Yes**, as an S–D tier per member per fragrance (`rankings`). There are no numeric scores; `overlap.ts`/`export.ts` derive a score from the tier. |
| Notes / accords | **Yes**: `notes` (flat, used by overlap), `notes_top/heart/base`, `accords`, `perfumers`, `release_year`, all as columns on `fragrances` (no normalized notes table). |
| Collections | **Partly**: a "room" is a shared, invite-only list. There are no personal collections, wishlists or owned/tried flags beyond "has a ranking". |
| Reviews / comments | **No**. There is no free text per user and no comments table. |
| Global catalog | Static JSON only (`public/catalog`). Room fragrances are per-room copies with no FK to a catalog entry. |
| History / audit / soft delete | **None.** Every delete is hard and every update overwrites. |

## 3. Every write path

All UI writes go through `useRoom` with the user's JWT (RLS applies). Scripts use the **service-role key (bypasses RLS)** via `scripts/env.ts:4`.

### UI
| # | Action (trigger) | Code | Who | Confirmation | Hard/soft | Effects |
|---|---|---|---|---|---|---|
| U1 | Create room | `pages/Home.tsx:49` → `create_room` RPC | any signed-in user | none (form submit) | insert | room + owner member |
| U2 | Join (invited) | `pages/Room.tsx:191` → `useRoom.ts:293` insert `members` | invitee | form | insert | |
| U3 | Join by code | `pages/Room.tsx:140` → `useRoom.ts:310` RPC | anyone with the code while `join_by_code`=true | form | insert | **also inserts an invite row** for that email |
| U4 | Set/change tier | `MyTiers.tsx:85` (drag), `:106` (key), `TierSheet.tsx:81`, `QuickRank.tsx:50` → `useRoom.ts:207` upsert | self | none | upsert | `updated_at` is set by the client |
| U5 | Unrank ("Haven't tried", drag to Unranked, `U` key, QuickRank undo) | `TierSheet.tsx:81`, `MyTiers.tsx:85/106`, `QuickRank.tsx:61` → `useRoom.ts:207` delete | self | **none; one tap** | **hard** | own ranking row gone; no undo except re-ranking |
| U6 | Add fragrance | `AddFragrance.tsx:29`, quick-add `:84` → `useRoom.ts:231` insert | any member | none | insert | client dedupe (strict + loose) + DB unique index |
| U7 | Edit fragrance | `TierSheet.tsx:74` → `useRoom.ts:253` update | **any member, any bottle** | Save button | overwrite | changes name/house/notes **for everyone**; no history |
| U8 | Remove fragrance | `TierSheet.tsx:169` → `useRoom.ts:275` delete | owner (RLS 004) | inline two-step ("Remove for everyone") | **hard** | **cascades every member's ranking of it** |
| U9 | Rename self | `MembersPanel.tsx:69` → `useRoom.ts:335` | self | Save button | overwrite | |
| U10 | Invite email | `MembersPanel.tsx:103` → `useRoom.ts:352` | owner | form | insert | |
| U11 | Toggle join-by-code | `MembersPanel.tsx:116` → `useRoom.ts:326` | owner | **none; a checkbox flips it immediately** | update | |
| U12 | Remove invite / member | `MembersPanel.tsx:170` → `useRoom.ts:367` | owner | `ConfirmButton` (warns "their rankings will be deleted") | **hard** | trigger deletes the member, which cascades all their rankings |
| U13 | Delete room | `MembersPanel.tsx:191` → `useRoom.ts:378` | owner | `ConfirmButton` ("Delete forever") | **hard** | cascades invites, members, fragrances and rankings for everyone |
| U14 | Leave room | **not implemented** | | | | RLS `members_delete` lets a member delete their own row via the API, which cascades their rankings |

Read-only in the UI: `ExportBoard` (client-side PNG), `Overlap`, the catalog.

### Scripts (`npm run …`, all need `SUPABASE_SERVICE_ROLE_KEY`; `.env.local` points at **production**)
| Script | Writes? | Guard | Notes |
|---|---|---|---|
| `seed.ts` | inserts 4 auth users (`*.demo@example.com`), a room, invites, members, fragrances, rankings | `--yes --invite` flags | Creates **real users and a room in prod**. There is no teardown script. |
| `verify-rls.ts` | creates 2 auth users + a room, writes rows, then deletes the room (`:99`) and both users (`:101-102`) | none (it runs immediately) | Writes to prod. If it crashes before cleanup, test users/rooms are left behind. |
| `backfill-details.ts` | `update fragrances` by id with a name+house guard (`:70-80`) | plan → dry-run by default → `--no-dry-run`; takes a backup first; skips drifted rows; checks that counts and the rankings hash are unchanged | **The rollback SQL (`exports/backfill-rollback-*.sql`) restores by id unconditionally, so it overwrites any member edits made after the run** (stated in README:110). |
| `backup.ts` | none (selects only) | | Manual; JSON with emails goes to `exports/`. **No restore script exists.** |
| `export.ts` | none | | CSV with emails |
| `build-catalog.ts` | local files only (`public/catalog`, `catalog-manifest.ts`; deletes old catalog files) | | Never touches the database |

## 4. Risks (ranked)

### High
1. **Deleting an owner's auth account wipes their rooms for everyone.** The cascade runs `rooms.owner_id → auth.users ON DELETE CASCADE` → all children (001:16). An account deletion in the Supabase dashboard, or a GDPR request, silently destroys every friend's rankings in those rooms. There is no ownership transfer.
2. **No scheduled or off-site backups and no restore path.** `backup.ts` is manual and local. Nothing in the repo shows PITR or Supabase daily backups. Combined with hard deletes everywhere, every loss is permanent.
3. **Room delete (U13) and remove-member (U12) are a single confirm with no undo.** Both cascade-delete other people's rankings. A mistaken click by the owner is unrecoverable without a backup.
4. **Any member can rewrite any fragrance (U7).** RLS `fragrances_update` allows every member to change any granted column. Renaming a bottle changes what everyone's existing tier means, with no history, attribution or revert. Delete was locked to the owner in 004; edit was not.
5. **Scripts write to production by default.** `seed` and `verify-rls` create real auth users and rooms in the prod project because `.env.local` is prod. `verify-rls` has no confirmation flag.

### Medium
6. **Backfill rollback clobbers later edits** (`scripts/lib/backfill.ts:295-300`). The rollback is a plain `update … where id = …` with no check against the backfilled value. The memory note says the rollout finished 2026-11-06; running the rollback now would overwrite 9+ days of member edits.
7. **Hand-applied migrations with no tracking.** If 004 was not applied, any member can still delete fragrances, and every member's rankings of that fragrance go with it. If 003 is missing, inserts fail. Nothing records which migrations production has.
8. **Removing a member is reversible by them.** With `join_by_code` on by default, a removed person can rejoin with the code. Their previous rankings are already gone, so removal is destructive without being effective (`MembersPanel.tsx` copy admits this).
9. **One-tap unrank (U5) has no undo.** "Haven't tried", a drag to Unranked, or the `U` key immediately hard-deletes your ranking. QuickRank's own undo is also a delete.
10. **Self-delete of membership is possible through the API** (`members_delete`), which cascades your rankings. There is no UI for it, so it isn't an accident path today, but it is undocumented.
11. **The join-by-code toggle has no confirmation (U11)** and defaults to open, so a room is joinable by anyone holding the 6-character code.

### Low
12. `rankings.updated_at` is set by the client, and there is no `BEFORE UPDATE` trigger, so it can't be trusted for audit.
13. The `rooms` and `invites` tables are not in realtime, so other clients see stale join/invite state until refetch.
14. Text arrays (`notes`, `accords`, …) have no length or element-size limits, so a member can store very large rows.
15. `remove_member_on_uninvite` matches members by `email` captured at join time. If a user's auth email changes, uninviting no longer removes them, though RLS still blocks them.
16. Room `name` has no uniqueness per owner (cosmetic only).

Uniqueness constraints that do exist: room code, `(room_id,email)` invite, `(room_id,user_id)` member, case-insensitive display name, fragrance name+house per room, one ranking per member×fragrance. No missing unique constraint was found that allows duplicate core data.

## 5. Proposals (not implemented)

1. **Backups:** turn on Supabase PITR or confirm daily backups on the plan. Add a scheduled `backup.ts` run to private storage (e.g. a GitHub Action with encrypted artifacts), and write a tested `restore.ts` (per-room restore from a snapshot).
2. **Soft delete:** add `deleted_at` to `rooms`, `fragrances` and `members`. RLS filters deleted rows; a nightly job purges after N days. The UI can then offer "Undo" and owner-side "Recently deleted".
3. **Owner account deletion:** change `rooms.owner_id` to `ON DELETE RESTRICT` (or transfer ownership to the oldest member via a trigger), so deleting a user can't silently erase shared rooms.
4. **Fragrance edit history:** add a `fragrance_revisions` table filled by an AFTER UPDATE trigger (old row, editor `auth.uid()`, timestamp). Optionally restrict edits of name/house to the owner or `added_by`.
5. **Ranking audit:** add a server-side `updated_at` trigger; optionally a `rankings_history` table (append-only) so accidental unranks and cascades are recoverable.
6. **Migration tracking:** move to the Supabase CLI migration table, or add a `schema_version` table that each hand-applied file inserts into, and have the app or `verify` check it.
7. **Scripts safety:** require an explicit `--prod`/project-ref confirmation (match the hostname) before any service-key write. Point `seed`/`verify-rls` at a separate staging project by default.
8. **Backfill rollback:** add a guard so each row only reverts if it still equals the backfilled value (`where id = … and notes = <after>`). Otherwise skip and report the row.
9. **Member removal:** when removing someone while `join_by_code` is on, warn or turn code-joining off, or keep a blocklist so removal is effective. Consider keeping (soft-deleting) their rankings.
10. **Constraints:** add `cardinality()` limits on text arrays and element length checks; optionally a limit on fragrances per room.
