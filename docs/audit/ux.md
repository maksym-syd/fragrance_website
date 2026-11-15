# UX / design audit: Scent Tiers

Date: 2026-11-15 · Base: `580516e` (after design audit `c5fe039` and owner-only remove `e6abe34`)
Method: static code review only. Nothing was run against Supabase and no dev server was started.
Read: `index.html`, `src/App.tsx`, `src/pages/*`, `src/components/*`, `src/hooks/useRoom.ts`, `src/hooks/useAuth.ts`,
`src/styles.css`, `src/catalog.css`, `src/lib/{normalize,tiers,details}.ts`, `supabase/migrations/004_owner_only_remove.sql`.
Contrast was computed from the CSS tokens, with `color-mix(in oklab, …)` reproduced in a script.

Severity: **Blocker** stops a core flow · **Major** real harm or confusion in a common path · **Minor** a rough edge with a workaround · **Polish** consistency or delight.
Effort: **S** < ½ day · **M** ½–2 days · **L** > 2 days.

---

## 0. Status of known follow-ups

| Follow-up | Status | Evidence |
|---|---|---|
| Focus trap in TierSheet | **Still open** | `src/components/TierSheet.tsx:60-70` handles Escape only. Nothing handles Tab and the background isn't `inert`, so Tab leaves an `aria-modal` dialog. QuickRank already has a working `trapTab` at `src/components/QuickRank.tsx:179-192` that could be reused. See M2. |
| Accords jump link in Overlap JUMPS | **Still open** | `src/components/Overlap.tsx:25-33` has no accords entry, and the accords header at `src/components/AccordsSection.tsx:15` has no `id`, so a link would have no target. See m1. |
| New details in QuickRank | **Still open** | `src/components/QuickRank.tsx:116-124` shows house, concentration and the flat `notes` list only. Accords, the pyramid, year and perfumers are missing, and the tags have no label. See m2. |

Previously fixed items (quick rank, board search and filters, phone tab bar, overlap hierarchy, AA text contrast) were checked and are not re-reported. The recomputed text contrast all passes AA in both themes. The lowest pairs are muted on surface-2 at 4.87:1 in dark mode and ink on the 52 % heat cell at 5.26:1 in dark mode.

---

## 1. Summary

No blockers. Six majors, five of them cheap:

| # | Issue | Effort |
|---|---|---|
| M1 | A failed save or a network blip throws you out of the room to a full-page error | S |
| M2 | TierSheet: no focus trap; focus is lost when the sheet closes off the board and when inline confirms open | S–M |
| M3 | A wrong quick-add tap by a non-owner can't be undone or removed | M |
| M4 | Pasting a room link into "Join with a code" opens the wrong room and blames the invite list | S |
| M5 | On phones, Quick add sits below an 11-field form | S–M |
| M6 | "Couldn't save" stays on screen and doesn't say what failed or what to do | S |

---

## 2. Major

### M1. A failed write or a tab refocus while offline replaces the whole room with an error page
- **Evidence:** `src/hooks/useRoom.ts:195-198`: every failed write calls `load()`. `load()` sets `status: 'error'` when any query fails (`:72-75`, `:93-96`), and `src/pages/Room.tsx:22-33` then swaps the board, an open sheet or Quick rank for "Couldn't open this room". `useRoom.ts:115-119` also calls `load()` on every `visibilitychange`, so unlocking a phone on a flaky connection does the same.
- **Impact:** In an unsteady connection (the "rank on the sofa" case), one failed tap during Quick rank closes the dialog and loses its progress, its undo stack and the scroll position. The optimistic tier is rolled back without saying which bottle was affected.
- **Fix:** Separate a first-load failure from a later resync failure. After the room has loaded once, keep the data on a failed `load()`, set a `stale` flag and show a slim banner ("Offline. Changes may not be saved. Retry"). Leave `status: 'error'` for the first load only.
  ```
  ┌──────────────────────────────────────┐
  │ ⚠ Connection lost. Showing last data │
  │                              [Retry] │
  └──────────────────────────────────────┘
  ```
- **Effort:** S

### M2. Modal focus management: TierSheet trap, focus return and inline confirms
- **Evidence:**
  - No trap: `src/components/TierSheet.tsx:60-70` (follow-up still open). The phone tab bar (`styles.css:388`) and the board stay in the Tab order behind `aria-modal="true"` (`TierSheet.tsx:91`).
  - Focus return works only from the board. `src/pages/Room.tsx:73-80` finds `[data-frag-id]`, which exists only on My tiers chips (`MyTiers.tsx:285`). Sheets opened from Overlap (`Overlap.tsx:363`, `:532`) or Add ("Rank it now" at `AddFragrance.tsx:56`, or a room match in the name combobox at `FragranceForm.tsx:74-76`) drop focus to `<body>` when they close.
  - Inline confirms remove the focused button. "Remove for everyone…" (`TierSheet.tsx:178`) and every `ConfirmButton` (`ui.tsx:63-69`, used for Remove invite and Delete room) unmount the button that had focus. Focus goes to `<body>`. Inside the untrapped sheet, the next Tab starts at the top of the page. `role="alertdialog"` (`TierSheet.tsx:160`, `ui.tsx:71`) is announced as a dialog but has no name, isn't modal and never receives focus.
  - QuickRank: when the last card is ranked, the tier buttons unmount (`QuickRank.tsx:112` → `:157`). Focus falls to `<body>`, and `trapTab` (`:185-191`) only re-wraps from the first or last item or from the dialog itself, so the next Tab escapes.
- **Impact:** Keyboard and screen-reader users lose their place in the main rank, edit and remove flows. WCAG 2.4.3 (Focus Order) and 2.1.2-adjacent issues.
- **Fix:**
  1. Move `trapTab` into `ui.tsx` as `useModal(ref, onClose)`. It should handle Escape, Tab wrapping (including when focus is on `<body>`) and body scroll lock, and restore focus to `document.activeElement` from when it opened (as QuickRank already does at `:69`, `:86`). Use it in both dialogs. Keep the `data-frag-id` lookup as the first choice so focus still follows a chip that moved rows.
  2. Add `inert` to `.page` and the topbar while a sheet is open. React 18 needs `inert=""` set through a ref.
  3. Inline confirms: drop `role="alertdialog"` and use a plain `role="group"` with `aria-labelledby` pointing at the prompt. Focus the safe choice ("Keep it" or "Cancel") when the confirm opens, and give focus back to the arming button when it's cancelled.
  4. QuickRank done screen: focus the primary action ("See overlap" or "Done").
- **Effort:** S for 1, 3 and 4 · M with 2 and tests.

### M3. Quick add is one tap with no undo, and only the owner can remove
- **Evidence:** `src/components/AddFragrance.tsx:84` adds on a single tap. The list then re-flows because the added item disappears (`:21`), so the next tap lands on a different bottle. `supabase/migrations/004_owner_only_remove.sql:12-13` and `TierSheet.tsx:157` let only the owner remove a fragrance, "even if they added it". A non-owner sees no remove option and no hint about who can remove (`TierSheet.tsx:157-181`).
- **Impact:** A friend who mis-taps adds a bottle to everyone's Unranked pool and has to ask the owner to remove it. This is the main way junk gets into a shared room.
- **Fix (pick one):**
  - **(a)** Show the success line as a 10 s "Added Aventus · **Undo**", backed by an RPC or policy that lets `added_by` delete their own row when it has no rankings from other members, or within N minutes. This needs a migration (M).
  - **(b)** Without a schema change, make quick add a two-step "select, then Add 3" tray (S–M), and show non-owners "Only {owner} can remove bottles. Ask them on the Members page." in the sheet (S).
  ```
  Quick add                         92 picks
  [ search name, house or note        ]
  ☐ Aventus · Creed
  ☑ Santal 33 · Le Labo
  ☑ Baccarat Rouge 540 · MFK
  ─────────────────────────────────────
  [        Add 2 to the room         ]   ← sticky on phones
  ```
- **Effort:** M for (a) · S–M for (b)

### M4. Pasting a room link into "Join with a code" opens the wrong room
- **Evidence:** `src/lib/normalize.ts` `normalizeCode` strips non-alphanumerics and keeps the first 6 characters, so `https://…/r/K7P2QX` becomes `HTTPSF`. `src/pages/Home.tsx:142` normalises on change, and the button enables at 6 characters (`:144`). The user lands on `/r/HTTPSF`, which leads to JoinByCode and then "You're not invited to this room" (`Room.tsx:164-181`). That screen blames the invite list for what was a paste error.
- **Impact:** People are usually sent links, not codes. Pasting the link into the obvious field gives a confusing dead end that seems to say the friend didn't invite them.
- **Fix:** In `onChange` (or on paste), check the raw input first for `/r/([A-Z0-9]{6})` and use that capture before normalising. Also add a one-line hint under the field: "Paste the link or type the 6-character code".
- **Effort:** S

### M5. On phones, Quick add is below an 11-field form
- **Evidence:** `src/components/AddFragrance.tsx:41-96` puts the form card first. It has Name, House, Concentration, Year, Perfumers, Accords, Top, Heart, Base and Other notes, then the credit (`FragranceForm.tsx:122-223`). The 2-column layout only starts at 900 px (`styles.css:976`). The empty board says "The quick-add list makes it fast" (`MyTiers.tsx:72`) and links here, but at 375 px the list starts roughly 1,100 px down.
- **Impact:** First-run friction in the moment that decides whether a new room fills up.
- **Fix:** Below 900 px, lead with one search. The name combobox already searches the catalog and the room. Put quick add directly under it, and put the detail fields behind "More details (optional)". Concentration and year can stay visible.
  ```
  375px
  ┌───────────────────────────┐
  │ Add a fragrance           │
  │ [Start typing: Aventus  ] │  ← catalog + room matches
  │ [House                  ] │
  │ ▸ More details (optional) │  ← accords, pyramid, perfumers
  │ [      Add fragrance    ] │
  ├───────────────────────────┤
  │ Quick add       92 picks  │
  │ [search…               ]  │
  │ Aventus · Creed        (+)│
  │ …                         │
  └───────────────────────────┘
  ```
  In edit mode inside the sheet, open "More details" by default because that's why the user opened edit.
- **Effort:** S (reorder + `<details>`) – M (if the catalog pick should auto-expand the filled sections)

### M6. "Couldn't save" stays on screen with no context or next step
- **Evidence:** `src/hooks/useRoom.ts:196` sets `save: 'error'`, and nothing resets it. The idle timer is only set on success (`:201`). `src/pages/Room.tsx:118-125` shows "Couldn't save" fixed above the tab bar until the next successful write. The same text appears for a failed room delete (`MembersPanel.tsx:190-193`, which ignores `!res.ok`), for invite toggles and for renames.
- **Impact:** Users can't tell what failed: the reload has already rolled the optimistic change back. A failed **Delete room** looks like a save problem and leaves the owner on the Members page with no explanation.
- **Fix:** Pass a short label to `track(label, fn)` and show "Couldn't move Aventus to S · Retry" for about 6 s, then idle. On a failed delete, show an inline error in the DangerZone card.
- **Effort:** S

---

## 3. Minor

### m1. Overlap: no jump link to "By accord" (follow-up)
`Overlap.tsx:25-33`, `AccordsSection.tsx:15-18`. Use `SectionHead` in AccordsSection (export it from Overlap or move it to `ui.tsx`) so it gets `id="by-accord"`. Add `['by-accord', 'Accords']` after `by-note`. Also, the "By note" empty state still says "…to see which **accords** you share" (`Overlap.tsx:454`), which is now confusing next to a real accords section. Change it to "which notes you share". **S**

### m2. Quick rank shows less than the sheet (follow-up)
`QuickRank.tsx:114-133` vs `TierSheet.tsx:21-40`. Accords say the most at a glance, and they're missing. Reuse a compact `FragranceDetails` (accords plus a single pyramid line) without the edit link, and add the year:
```
Aventus
Creed · EDP · 2010
woody  fruity  smoky           ← accords as tags
Top pineapple, bergamot · Heart birch · Base musk
(A) Sam   (S) Lee
```
Keep the card height stable (cap at 2 tag lines) so the tier buttons don't move between cards. A tap target that jumps is worse than missing data. **S**

### m3. Touch targets under 44 px on phone-critical controls
All of these pass WCAG 2.5.8 (24 px, or the spacing exception), but they miss the 44 px goal the rest of the app meets:
- `btn-link` (`styles.css:232-242`, ~28 px tall): **Sign out** (`App.tsx:42`), **Edit details** (`TierSheet.tsx:35`), **Remove for everyone…** (`:178`), **Rank it now** (`AddFragrance.tsx:56`). Under `.invite > .btn-link { padding: 0 }` (`styles.css:877`), **Send link** and **Remove** are about 20 px tall and stacked 8 px apart (`MembersPanel.tsx:157-171`). These are destructive actions next to each other.
- Sheet close `.btn-icon` is 40 px (`styles.css:244`).
- `.btn-sm` is 36 px (`styles.css:228`): Quick rank, Export, Show all, and the confirm buttons.
- `.overlap-nav a` is 36 px (`styles.css:651`). `.segmented button` is 36 px (`styles.css:797`). `.token-x` is 28 px (`catalog.css:53-55`).

Fix: under `@media (pointer: coarse)`, set `.btn-sm, .overlap-nav a, .segmented button, .btn-icon { min-height: 44px }` and `.btn-link { padding-block: 12px; margin-block: -8px }` (the margin keeps the visual rhythm). On invite rows, put Send link and Remove on one line, at opposite ends. **S**

### m4. Edits are discarded silently
`TierSheet.tsx:50`: Escape while editing calls `setEditing(false)`, and × (`:106`) closes the sheet. Neither checks for unsaved changes. Backdrop click is already guarded (`:86`). Fix: keep a `dirty` flag from FragranceForm. When it's dirty, × and Escape first show "Discard changes? [Keep editing] [Discard]". **S**

### m5. Form validation is invisible or not linked
- The submit button is disabled while Name or House is empty (`FragranceForm.tsx:219`) and nothing says why. That's fine on desktop, but on a phone the button is below the fold.
- The year error (`:199`) and duplicate error (`:216`) aren't linked with `aria-describedby`, and the duplicate error has no live region.
- "Already in this room." is a dead end. In add mode it should be a button that opens the existing bottle (`onOpen`), as the combobox room option already does.

Fix: keep the button enabled, validate on submit, focus the first invalid field and link the messages to their fields. **S**

### m6. Concentration "radiogroup" doesn't behave like one
`FragranceForm.tsx:171-183`: `role="radiogroup"` has no accessible name (the `<legend>` names the fieldset, not the group). Every option is a Tab stop, there's no arrow-key movement, and clicking the checked radio unchecks it, which isn't standard for radios. Either use real `<input type="radio">` with a "None" option, or use `aria-pressed` toggle buttons inside the fieldset. The second is closer to the current behaviour. **S**

### m7. Quick-add search ignores accents
`AddFragrance.tsx:22-25` uses `toLowerCase().includes`. "hermes" doesn't find *Terre d'Hermès*, "lancome" doesn't find *Lancôme* and "gio" doesn't find *Acqua di Giò* (`src/lib/popular.ts:8,15,20`). The board search already folds accents (`MyTiers.tsx:27`). Move `fold` to `lib/normalize.ts` and use it in both places. **S**

### m8. Similarity map on phones: short names collide and there's no full-name fallback
`Overlap.tsx:299` uses `display_name.slice(0, 3)` (Alex/Alexandra → "Ale"/"Ale"; Мария/Марина → "Мар"/"Мар"). The full name is only in `title`, which phones don't show. Row headers are cut to 76 px (`styles.css:717`). Fix: make the shortest unique prefix per room (at least 2 letters) and add a legend under the table ("Ale = Alex · Alx = Alexandra") when any prefix is shorter than the full name. **S**

### m9. Members can't leave a room
RLS allows it (`supabase/migrations/001_init.sql:228-229` `members_delete`: `user_id = auth.uid() or owner`), but `MembersPanel.tsx` has no "Leave room" button. The only way out is for the owner to remove your invite, which also deletes your rankings. Add a ConfirmButton "Leave room…" for non-owners that says whether rankings are kept. **S**

### m10. Magic-link "sent" state has no way back
`SignIn.tsx:54-57` replaces the form. A mistyped email can only be fixed by reloading. Add "Wrong address? **Use a different email**", which resets the state, and disable resend for about 60 s, since Supabase rate-limits it. The raw Supabase error message is shown as-is (`:28`); map the rate-limit error to plain words. **S**

### m11. Export image: long names overflow and the state isn't announced
- `.export-item { white-space: nowrap }` (`styles.css:923`) in a column of about 350 px (1200 px wide, 3 columns, `ExportBoard.tsx:91`). Names up to 80 characters (`FragranceForm.tsx:143`) overflow the white card. Use `overflow-wrap: anywhere` on items longer than about 28 characters, or `max-width: 100%` on the item.
- "Rendering…" and "Export failed — retry" aren't in a live region. On failure there's no hint (for example "try again on Wi-Fi" or "too many bottles"). **S**

### m12. Tables: max-width on header cells doesn't apply
`styles.css:771` `.grid-table thead th { max-width: 90px }` combined with `.ellipsis` (`Overlap.tsx:467`, `:522`, `AccordsSection.tsx:27`). In an auto-layout table, `max-width` on cells is ignored, so a long display name (40 characters allowed, `Room.tsx:154`) widens every column. On phones, Side by side also gives no sign that it scrolls sideways. Wrap the name in an inner `<span class="ellipsis" style="display:block;max-width:90px">`. Add a right-edge fade on `.scroll-x` when it overflows (scroll-driven shadow: `background-attachment: local`). **S**

### m13. The sheet vanishes when its bottle is removed elsewhere
`Room.tsx:83`, `:113`: if a realtime delete removes the open bottle, `open` becomes `null` and the sheet unmounts. No message is shown, `openId` stays set and focus is lost. Show "{name} was removed from the room" in the save toast and call `closeSheet`. **S**

---

## 4. Polish

| # | Issue | Evidence | Proposal | Effort |
|---|---|---|---|---|
| p1 | Display font has no Cyrillic or CJK | Fraunces from Google Fonts covers Latin, Latin-ext and Vietnamese only (`index.html:29`). Cyrillic room names, sheet titles, verdicts, tier captions and the export title fall back to Georgia (CJK to the system serif) in the middle of a line. | Add `'Noto Serif'` (Cyrillic) and `'Noto Serif SC/JP'` (only if the friends use them) to `--font-display` with `unicode-range`-limited `@font-face` loading, or accept Georgia and set it explicitly so the fallback is deliberate. Inter covers Cyrillic. | S |
| p2 | Emoji or astral-plane names break initials | `MembersPanel.tsx:37` `slice(0,1)` and `Overlap.tsx:299` `slice(0,3)` split surrogate pairs and show "�". | Use `[...name][0]` or `Intl.Segmenter`. | S |
| p3 | Font-name confusion | `--font-mono` is an alias for the **label** font (`styles.css:10`) but `.mono` uses the **code** font (`:134`). As a result, accord counts use JetBrains Mono (`AccordsSection.tsx:41`) while note counts use Inter with tabular figures (`Overlap.tsx:481`). | Replace `mono` with `num` in AccordsSection. Rename the alias to `--font-ui` in a later clean-up. | S |
| p4 | No type or spacing scale | 18 distinct font sizes (12, 12.5, 13, 14, 15, 16, 18, 20 px; 1.05–2.4 rem) and about 17 gap values (1–40 px) in `styles.css`. | Add `--text-xs/sm/md/lg/xl/2xl` and `--space-1…8` tokens. Migrate when touching each section, not as one big change. | M |
| p5 | Single-tier filter with an empty tier says nothing | `MyTiers.tsx:175-206`: the empty-state copy only appears when searching. Selecting "S" with nothing in S shows a bare label band. | "Nothing in S yet. Your holy grails go here." | S |
| p6 | Quick rank: key repeat ranks several bottles | `QuickRank.tsx:70-78` doesn't check `e.repeat`. Holding "B" ranks a run of bottles. | `if (e.repeat) return;` | S |
| p7 | Room code chip isn't named or copyable | `Room.tsx:90`: `aria-label` on a plain `<span>` is ignored by most screen readers, and the chip in the header looks tappable but does nothing. | Make it a `CopyButton` showing the code, with the visible text "Room code K7P2QX". | S |
| p8 | JoinRoom has no way out and stale errors | `Room.tsx:196-208` has no "Back home" link (JoinByCode at `:159` has one) and doesn't clear `error` before a retry (`:189-193`). | Match JoinByCode. | S |
| p9 | Members forms have no busy state | Invite (`MembersPanel.tsx:140`) and name Save (`:78`) can be double-submitted. The "Name updated" message stays after further typing (`:80`). | `busy` flag; clear `msg` on change. | S |
| p10 | Share on phones | `MembersPanel.tsx:24-27` offers only Copy link. | On `pointer: coarse` with `navigator.share`, show "Share link…" (the share sheet) next to Copy. | S |
| p11 | Unused or legacy code | `.tag-btn` (`styles.css:277`), `.pad` (`:150`), `tierVar` (`lib/tiers.ts:11`) and `parseNotes` (`lib/normalize.ts`) aren't used by the UI. | Remove them after checking scripts and tests. | S |
| p12 | Sign-in Google button gives no feedback | `SignIn.tsx:50`: no pending state or error handling around `signInWithOAuth`. A slow redirect looks like nothing happened. | "Opening Google…" plus disable; show an error on rejection. | S |
| p13 | Low-contrast component borders | `--line` is 1.41:1 on the surface (`styles.css:17`). It's the only boundary for `.btn` (secondary), the segmented control and the unchecked switch track (`:838`). This passes WCAG 1.4.11 because text or the thumb identifies them, but in bright light the secondary buttons look like plain text. | Use `--line-strong` (3.5:1) for interactive borders only, and keep `--line` for cards and dividers. | S |
| p14 | No skip link | The topbar is small, but on desktop the room header and tabs come before the board. | Visually hidden "Skip to content" link targeting `main`. | S |

---

## 5. Checked and fine (no action)

- **Phone layout at 375 px:** the tier rows collapse to a label band with full-width chips (`styles.css:496-517`). The bottom tab bar respects the safe area (`:388-397`), and the save toast sits above it (`:371`). `.room` padding clears the bar (`:149`). Inputs are 16 px, which avoids iOS zoom (`:102`). The sheet uses `92dvh` (`:586-587`).
- **Touch drag:** deliberately mouse-only (`MyTiers.tsx:43-45`), with tap-to-sheet on touch and `touch-action: manipulation`. The hint text switches by pointer type (`MyTiers.tsx:225-231`, `styles.css:414-419`). Keyboard ranking with S/A/B/C/D/U and arrows, plus a live announcement (`MyTiers.tsx:89-111`, `:233`), works well.
- **Long text:** chips, sheet titles, verdicts and room names wrap (`body { overflow-wrap: break-word }`, `.verdict { overflow-wrap: anywhere }`). Room list names truncate with an ellipsis. Combobox options use `overflow-wrap: anywhere`.
- **Loading, empty and error states:** splash, room skeleton with the same box sizes, home skeleton, home load error with retry, room error with retry, not-invited with copy-email, and empty states for the board, overlap (fewer than 2 members, no rankings), search, quick add and invites are all present.
- **Images:** the app shows no bottle images, so it has no missing-image states. `og.png`, `apple-touch-icon.png` and `favicon.svg` exist in `public/` and are referenced in `index.html:5-6,19`.
- **Dark mode:** every token is redefined, export is always light (`styles.css:889-903`), and `theme-color` is set for both schemes.
- **Contrast:** all text pairs are ≥ 4.5:1 in both themes, including the tier colours with `--on-tier` (lowest 5.26:1, D in dark) and the heat-map bands. The focus ring is 4.82:1 on the light background.
- **Reduced motion:** respected globally (`styles.css:980-982`) and for smooth scrolling (`:78`).

---

## 6. Suggested order

1. **One PR (S):** M4, M6, m1, m2, m7, p3, p6. These are small, independent fixes. Two of them close follow-ups.
2. **Modal PR (S–M):** M2, m4, m13 together, with a shared `useModal` hook. This closes the TierSheet follow-up.
3. **Resilience (S):** M1.
4. **Add flow (S–M):** M5, then M3 (b), with M3 (a) later if the friends want undo.
5. **Touch pass (S):** m3. Then do the real-iPhone check that's still listed as untested.
6. Everything else as time allows.
