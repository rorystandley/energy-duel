# Energy Duel release package (for review)

**Prepared:** 2026-10-05 against `main` at `3905cb8` (PR #12, fullscreen). **Status: draft for owner review. Nothing here has been published; the live Wavedash and itch.io pages are unchanged.**

Scope note: `main` contains the work of Tasks 01–12 as merged PRs #1–#12 (guided intro, fair rival, phone layout, round feedback, seeded matches, replay/rematch, Daily Duel, SDK boundary, achievements, daily leaderboard, cloud save, fullscreen). I did not independently re-review those PRs; claims below were checked against the code, docs and the running production build.

## 1. Build record

| Item | Value |
| --- | --- |
| Source commit | `3905cb8` |
| `npm test` | 21 files, 275 tests passed |
| `npm run build` | passed (JS 1,488 kB / 392 kB gzip; Vite's >500 kB chunk warning remains) |
| Uploaded build (not published) | **Build ID `mn74w7bh5qd9zsfwanykp44mpd8fp1bp`**, 5.83 MB, message "Release candidate 3905cb8 (playtest, not published)" |
| Playtest URL | https://wavedash.com/playtest/energy-duel/e03fc5ea-08a3-4a57-9501-5a4594f61b54 |
| URL verification | Partial. The URL resolves (HTTP 200) but redirects to Wavedash sign-in. **Gap:** I did not sign in, so I have not loaded the hosted build or seen the SDK, achievements, cloud save, leaderboard or fullscreen work inside the Wavedash iframe. The owner must open it signed in (checklist item 3). |
| Rollback candidate | **Gap.** The CLI (0.1.98) has no command to list builds and I could not see the portal. The current live build ID is therefore unknown. Before publishing, note the live build ID in Developer Portal > Builds; that build (immutable per Wavedash docs) is the rollback target. Fill in: `ROLLBACK_BUILD_ID = ________` |

The local checks in section 2 used `vite preview` of this same `dist`, not the hosted playtest.

## 2. Claim verification

Verified = confirmed in code/docs and/or seen in the production build in a browser.

| Claim | Evidence | Status |
| --- | --- | --- |
| Guided two-round intro, 4 moves in round 1 then 8, skippable | Seen: "ROUND 1 / 2", "YOUR QUEUE 0/4", Skip to Standard Match button | Verified |
| Standard Match: 5 rounds, up to 8 moves | Seen "ROUND 1 / 5", queue 0/8 on phone layout | Verified |
| Space = WAIT, Enter = execute | `GameScene.ts` key bindings; rules overlay lists both. Seen: WAIT in queue, Enter produced "Round 1 complete" | Verified |
| Simultaneous reveal; rival plans from public board only | `docs/DAILY_DUEL.md`: tests prove different hidden queues give identical rival plans | Verified (code/tests) |
| Small nodes 1, large nodes 3; clash priority swaps each round; loser's next move becomes WAIT | Rules overlay text and board | Verified |
| Round-end feedback and per-round replay | Seen: "You claimed a 3-point node at step 1", Watch Round Replay | Verified |
| End screen: score swing, nodes, clashes, best round, next target, Watch Replay, Share Result | Seen | Verified |
| Rematch same board / new board / Daily Duel | Key bindings R, N, T; docs | Verified (code), not clicked through |
| Daily Duel: one shared board per UTC date | `docs/DAILY_DUEL.md`; cross-timezone check recorded there | Verified (docs) |
| 5 achievements | `wavedash/achievements.json`, `docs/WAVEDASH_ACHIEVEMENTS.md` | Defined; **unlock on hosted build not verified** |
| Online Daily Duel leaderboard | `docs/DAILY_LEADERBOARD.md`: real submission and rank in sandbox "not done"; boards must be created/made public by the owner | **Not verified. Do not advertise as live until boards exist and a signed-in submission works.** |
| Cloud save and resume | `docs/CLOUD_SAVE.md`; local-first | Verified in code/tests; cloud sync on hosted build not verified |
| Fullscreen button | Visible in the UI; host API path from PR #12 | Button seen; hosted behaviour not verified |
| Phone layout with on-screen buttons | Seen at 390 x 844 emulated touch | Verified (emulated; **no real device test**) |
| Wavedash "Touch" input listing | Plan says update only after phone is verified | **Gap: real-device phone test pending** |

Not claimed anywhere below: multiplayer, ranked/cheat-proof play, difficulty levels, any playtime/retention figure (no measured data exists; Phase 0 baseline playtests have not been recorded).

## 3. Store copy (draft)

### Wavedash description

> Energy Duel is a neon, simultaneous turn-based strategy game. Two machines race for energy on a shared grid.
>
> You queue your moves. Your rival plans from the public board, not from your queue. Then both robots execute at the same time. No reacting mid-turn, only planning, prediction and commitment.
>
> **How it plays**
> - Queue up to 8 moves each round, then execute and watch both routes resolve step by step.
> - Small nodes score 1, large nodes score 3. Highest score after 5 rounds wins.
> - Paths that collide cause a clash. Priority swaps every round, and the loser is stunned for a move.
> - New blockers reshape the board each round.
>
> **Modes**
> - **Guided duel:** a short two-round introduction (skippable).
> - **Standard Match:** five rounds against the rival.
> - **Daily Duel:** one shared board per UTC date. Ranked on this device; also submitted to a casual, client-reported Wavedash leaderboard when that day's board is open.
>
> **Features**
> - Round summaries and replays of any round or the whole match
> - Rematch the same board or start a new one
> - Achievements, and progress and in-progress matches that carry across sessions when signed in to Wavedash
> - Plays on desktop and phone
>
> **Controls:** Arrows/WASD move, Space waits, Backspace undoes, C/Delete clears, Enter executes, H shows the rules. On phones, use the on-screen buttons.

(Remove the "also submitted to a casual leaderboard" clause and the achievements/progress sentence if checklist items 4-5 do not pass. Remove "and phone" if the real-device test fails.)

### itch.io description

> **Lock in 8 moves, watch them unfold, and fight for control of a neon arena.**
>
> Energy Duel is a simultaneous turn-based strategy game made for Gamedev.js Jam 2026 (theme: Machines). You and a rival robot both queue moves, then both execute at once. The rival plans from the public board only and never sees your queue.
>
> Collect energy nodes (1 or 3 points), win clashes, and finish 5 rounds with the highest score. Try the short guided duel, a Standard Match, or the Daily Duel, a shared board each UTC day. Rematch any board and watch replays.
>
> **Controls:** Arrow keys/WASD to queue a move, Space to WAIT, Backspace to undo, C/Delete to clear, Enter to execute, H for the rules. Touch buttons on phones.
>
> Free and open source (MIT): github.com/rorystandley/energy-duel. Also on Wavedash, where achievements and cloud-synced progress are available.

(itch.io builds run without Wavedash, so progress is local to the browser there; the Wavedash sentence is deliberate. Keep the existing AI disclosure: AI Assisted, Sounds.)

### Tags

- itch.io (current): Cyberpunk, grid, machines, Neon, Robots, simultaneous, tactics, Turn-based; genre Strategy. All remain accurate. Suggested addition: `singleplayer`. Do not add multiplayer.
- Wavedash: **Gap.** I could not read the current tag/genre/input fields (portal not visible). Suggested: Strategy, Turn-based, Tactics, Singleplayer, Neon. Input: Keyboard, Mouse, and Touch only after the real-device test.

## 4. Screenshots (real, from the production build)

Files in `docs/release-screenshots/`:

| File | Shows | Notes |
| --- | --- | --- |
| `desktop-1-welcome.png` | Welcome and controls card, 1280 x 800 | Caught while fading in; recapture if you want it crisper |
| `desktop-2-queued.png` | Guided round 1 with queue filled | Check it shows the board and queue clearly |
| `desktop-3-round-summary.png` | Round 1 complete panel | |
| `desktop-4-match-end.png` | Guided duel end screen (a real defeat, 3 to 10) | Consider swapping for a win after a Standard Match |
| `phone-1-standard-round.jpeg` | Standard round on a 390 x 844 emulated touch device | Emulated, not a physical phone |

Suggested set of 5 for upload: all of the above. Gap: no capture of a mid-reveal frame, a Daily Duel, a Standard Match end screen, or any Wavedash-hosted frame. The cover art exists at `public/branding/energy-duel-cover.png`.

## 5. Release notes (draft)

**Energy Duel 1.1** (name/number is your call; `package.json` still says 1.0.0)

- Added: a short guided duel for new players, with a skip option
- Added: Daily Duel, one shared board per UTC date
- Added: round summaries and replays, rematch on the same board, richer end screen with Share Result
- Added: phone layout with on-screen controls
- Added: achievements and stats; progress and in-progress matches save locally and sync to Wavedash cloud saves
- Added: in-game fullscreen button
- Added: Daily Duel leaderboard on Wavedash (casual, client-reported), once boards are open
- Fixed: the rival no longer sees your queued moves when planning
- Adjusted: controls are now Space = WAIT, Enter = execute (README previously said Space executes; corrected)

The Wavedash CLI can attach these as `--added/--fixed/--adjusted` items on `wavedash publish`.

## 6. README

Corrected the controls table in `README.md` (Space = WAIT, Enter = execute, plus undo/clear/rules/replay/rematch/Daily keys, touch buttons and a Modes list). Uncommitted; review the diff. The README's "Project Structure" block is also stale (`GameScene.ts` is about 5,000 lines and `src/game/` and `src/platform/` have many more modules). Left unchanged.

## 7. Open gaps

1. Hosted playtest not loaded (needs sign-in). 2. Live and rollback build IDs unknown. 3. Daily leaderboard boards unprovisioned/unverified on Wavedash. 4. Achievement unlock and cloud save not verified on the hosted build. 5. Real-device phone test not done. 6. Current Wavedash tags/inputs unreadable. 7. No measured player data (Phase 0 baseline absent), so no performance or enjoyment claims. 8. JS bundle 1.49 MB (load time not measured).

## 8. Production publication checklist

1. Record the live build ID as the rollback target (section 1).
2. Owner reviews copy, tags, screenshots and release notes above; approves or edits.
3. Open the playtest URL signed in. Play a guided duel and a Standard Match on desktop; confirm no console errors, fullscreen works, audio starts.
4. In the playtest: finish a match, confirm an achievement unlocks and `SAVED TO WAVEDASH` appears; reload and check resume/cloud save. Run `wavedash clear-playtest-data` afterwards if you don't want playtest progress.
5. Provision Daily Duel boards (`docs/DAILY_LEADERBOARD.md`), then submit one Daily attempt signed in and confirm a rank. If skipped, drop the leaderboard wording.
6. Test on a real phone through the Wavedash page; only then tick Touch in the listing.
7. Publish: `wavedash publish mn74w7bh5qd9zsfwanykp44mpd8fp1bp --title ... --summary ... --added ...` (or via the portal). Needs owner approval.
8. Update the Wavedash page (description, tags, screenshots) and the itch.io page (description, screenshots, changelog/devlog), and push the HTML5 build to itch.io if you want it to match.
9. Open the live game page signed out and signed in; verify description, controls and the Achievements tab.
10. If anything is wrong, re-publish `ROLLBACK_BUILD_ID`.
11. Merge README changes; commit the screenshots.
