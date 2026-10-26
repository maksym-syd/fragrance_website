# Scent Tiers

A shared fragrance tier list for a group of friends. The point is to show **where your tastes overlap and differ**: taste-match %, a similarity map, unanimous favourites, the most divisive bottles, note-level preferences and "try next" picks from your closest match.

Vite + React + TypeScript, plain CSS, Supabase (Postgres, Auth, Realtime), deployed on Vercel. All free tiers.

## How access works

- Every page requires sign-in: **Google** or an **email magic link** (Supabase Auth).
- Whoever creates a room is its **owner**. A room has a 6-character code and a URL like `/r/K7P2QX`.
- Friends can join in two ways:
  - **With the code** (on by default): anyone who signs in and enters the code, or opens `/r/CODE`, can click **Join room**. Their email is added to the invite list automatically.
  - **By email invite:** the owner adds friends' emails on the room's *Members* tab.
- The owner can switch off *"Anyone with the code can join"* to make the room invite-only. Then everyone not on the list sees *"You're not invited to this room — ask the owner to add &lt;their email&gt;"*.
- Either way people are signed in, so their tiers are saved to their account and follow them across devices.
- All of this is enforced by **Row Level Security** in Postgres (`auth.uid()` / `auth.email()`), not just hidden in the UI. In an invite-only room, knowing the code is not enough.
- Members read and write only in rooms they belong to, and you can only change *your own* rankings. Any member can add a fragrance or remove one for everyone. Only the owner can manage invites or delete the room.
- Removing someone's invite cuts their access immediately and deletes their membership and rankings in that room. The UI asks you to confirm first. While code joining is on, they could rejoin with the code, so turn it off first if you want someone out for good.

## Local development

```bash
npm install
cp .env.example .env.local   # fill in values from step 1 below
npm run dev                  # http://localhost:5173
npm test                     # overlap math + RLS policy tests (offline, no Supabase needed)
```

## Setup and deploy

### 1. Create the Supabase project
1. Go to [supabase.com](https://supabase.com) → **New project** (free tier). Pick a region near you and save the database password.
2. Open **Project Settings → API** and copy:
   - **Project URL** → `VITE_SUPABASE_URL`
   - **Publishable** key (`sb_publishable_…`, or the legacy **anon** key) → `VITE_SUPABASE_ANON_KEY`
   - **Secret** key (`sb_secret_…`, or the legacy **service_role** key) → `SUPABASE_SERVICE_ROLE_KEY` (scripts only; never expose it in the browser or prefix it with `VITE_`)

### 2. Run the migration
Open **SQL Editor → New query**, paste the whole of `supabase/migrations/001_init.sql`, and click **Run**. Then do the same with `002_join_by_code.sql`. Run the migration files in number order.
(Or with the Supabase CLI: `supabase link --project-ref <ref> && supabase db push`.)

This creates the tables, constraints, RLS policies and the `create_room` function, and adds `members`, `fragrances` and `rankings` to the `supabase_realtime` publication. To confirm, check **Database → Publications → supabase_realtime** for those three tables.

### 3. Enable Google sign-in
1. In [Google Cloud Console](https://console.cloud.google.com/):
   1. Create (or pick) a project.
   2. **APIs & Services → OAuth consent screen**: choose *External*, fill in the app name and support email, and add the scopes `email`, `profile` and `openid`. While the app is in *Testing*, add your friends as **test users**, or click **Publish app**. With only these basic scopes, publishing needs no Google review.
   3. **APIs & Services → Credentials → Create credentials → OAuth client ID** → *Web application*.
      - **Authorized JavaScript origins:** `http://localhost:5173` and `https://YOUR-APP.vercel.app`
      - **Authorized redirect URIs:** `https://YOUR-PROJECT.supabase.co/auth/v1/callback`. This must be the *Supabase* callback, which is shown on the Google provider page in Supabase. Do not use your app's URL here.
   4. Copy the **Client ID** and **Client secret**.
2. In Supabase, go to **Authentication → Sign In / Providers → Google**, enable it, and paste the client ID and secret.

### 4. Allow your redirect URLs (Google *and* magic links need this)
Supabase **Authentication → URL Configuration**:
- **Site URL:** `https://YOUR-APP.vercel.app`
- **Redirect URLs** (add each):
  - `http://localhost:5173/**`
  - `https://YOUR-APP.vercel.app/**`
  - optional, for Vercel preview deploys: `https://*-YOUR-VERCEL-TEAM.vercel.app/**`

The app sends people back to the page they started on (e.g. `/r/K7P2QX`). That's why the wildcard `/**` is needed.

Email magic links work out of the box (the **Email** provider is enabled by default). The free tier's built-in mailer is rate-limited to a few emails per hour, which is enough for a friend group. For more, set up custom SMTP under **Authentication → Emails**.

### 5. Deploy to Vercel
1. Push this folder to a GitHub repo.
2. Go to [vercel.com](https://vercel.com) → **Add New → Project** and import the repo. Vercel detects Vite (build `npm run build`, output `dist`).
3. Under **Environment Variables**, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Do **not** add the service role key.
4. Click **Deploy**. `vercel.json` rewrites all paths to `index.html`, so links like `/r/K7P2QX` work on refresh.
5. Take the final domain back to steps 3 and 4 (Google origins, Site URL, Redirect URLs) if it differs from what you entered.

> Vite inlines `VITE_*` variables **at build time**. If you change them in Vercel, redeploy.

### 6. Verify the security rules against your real project (recommended)
```bash
npm run verify-rls
```
This creates two throwaway users. One builds a room; the other, signed in with the public anon key exactly as a browser would be, tries to read and write it. The script checks that an outsider can't see the room, fragrances, rankings, members or invites, and can't join or invite themselves. It also checks that access works after an invite and disappears after an uninvite. Then it deletes everything it created. It needs `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`.

`npm test` also runs these policies offline: `src/lib/rls.test.ts` loads the real migration into [PGlite](https://pglite.dev) (Postgres compiled to WASM) with a small stand-in for Supabase's `auth` schema.

### 7. Optional: demo data
```bash
npm run seed -- --yes --invite you@example.com
```
This creates a "Demo Sniff Club" with 4 fake members (Ana, Ken, Mia, Leo), 13 fragrances and ~38 rankings, and invites your email. Open the printed `/r/CODE`, join, and look at **Overlap**. The fake members are confirmed auth users at `@example.com` addresses with no password, so they can't sign in. You can delete them under **Authentication → Users**. It requires the `--yes` flag and the service role key.

## Security notes
- The anon key is public by design. RLS is what protects the data, and every table has it enabled with no access for signed-out users.
- With code joining **on**, the room code works like a password: anyone with an account who has the code can join. A code has about a billion possible values, so guessing one is impractical, but don't post it publicly. With code joining **off**, the invite list is the only way in, and a leaked link is useless to anyone whose email isn't on it.
- Anyone you invite can add fragrances, remove them for everyone, and see everyone's rankings and display names. Only the owner sees members' email addresses in the UI. The data itself is still readable by any member through the API, because members can select the `members` table. Invite people you trust.
- Supabase Realtime can't filter `DELETE` events by room. Signed-in users may receive bare primary-key IDs (UUIDs, no content) of rows deleted in other rooms. The app ignores IDs it doesn't recognise.

## Project layout
```
supabase/migrations/001_init.sql  schema, constraints, RLS, create_room(), realtime
scripts/seed.ts                   demo room (flag + service key)
scripts/verify-rls.ts             live RLS check
src/lib/overlap.ts                pure scoring math (+ overlap.test.ts)
src/lib/rls.test.ts               RLS policy tests in PGlite
src/hooks/useRoom.ts              room data, realtime subscription, optimistic writes
src/pages/                        SignIn, Home, Room (+ not-invited and join screens)
src/components/                   MyTiers (dnd-kit), TierSheet, Overlap, AddFragrance, MembersPanel, ExportBoard
```

## Scoring
Tiers count as S=5, A=4, B=3, C=2, D=1; no ranking means "haven't tried".
- **Taste match** for a pair = `100 − mean(|diff|) / 4 × 100` over the fragrances both people ranked. It needs at least 2 in common.
- **Everyone loves:** ranked by 2+ people, and every one of them gave A or better.
- **Most divisive:** highest minus lowest tier ≥ 3.
- **Try next:** fragrances you haven't ranked that your closest match rated S or A.
- **By note:** each person's average tier across fragrances carrying that note tag.
