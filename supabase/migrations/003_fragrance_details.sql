-- Fragrance details: perfumers, accords, a top/heart/base pyramid and release year.
--
-- APPLY BY HAND: paste this whole file into the Supabase SQL Editor and click Run.
-- Do this BEFORE deploying the frontend that uses these columns, or every new insert fails.
--
-- Purely additive: no existing column, row or policy changes. `notes` stays the flat list the
-- overlap math reads. Safe to run twice: every statement below is idempotent.

begin;

alter table public.fragrances
  add column if not exists perfumers    text[] not null default '{}',
  add column if not exists accords      text[] not null default '{}',
  add column if not exists notes_top    text[] not null default '{}',
  add column if not exists notes_heart  text[] not null default '{}',
  add column if not exists notes_base   text[] not null default '{}',
  add column if not exists release_year int;

-- Postgres has no "add constraint if not exists", so replace it. 1700 predates the oldest
-- catalog entry (1709); the upper bound only catches typos like 20244.
alter table public.fragrances drop constraint if exists fragrances_release_year_check;
alter table public.fragrances add constraint fragrances_release_year_check
  check (release_year is null or release_year between 1700 and 2100);

-- 001_init.sql grants UPDATE per column, so new columns are not editable without this.
-- (INSERT and SELECT are table-wide grants and already cover them.)
grant update (perfumers, accords, notes_top, notes_heart, notes_base, release_year)
  on public.fragrances to authenticated;

commit;
