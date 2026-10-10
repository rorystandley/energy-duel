# Daily Duel online ranking (Wavedash)

Code: `src/game/daily-leaderboard.ts` (name, score, metadata, once-only submitter), `src/platform/wavedash.ts` (`submitLeaderboardScore`), `scripts/provision-daily-leaderboards.mjs` (one-time owner tool).

**Casual ranking.** Scores are computed and sent by the player's own browser. Nothing verifies them, so this is a casual board, not cheat-resistant. The end screen says `CASUAL, CLIENT-REPORTED`. Replays are not attached or checked.

## One permanent board

| Property | Value |
| --- | --- |
| Name | `daily-duel` (constant `DAILY_LEADERBOARD_NAME`) |
| Sort order | `DESC` (1), higher is better |
| Display type | `NUMERIC` (0) |
| Score | `playerScore - rivalScore` (negative when behind, `0` on a draw) |
| Submit | `uploadLeaderboardScore(id, score, keepBest = true, undefined, metadata)` |
| Metadata | `{ date, rulesVersion, playerScore, rivalScore }`, four primitives, about 80 bytes (limit 16 keys / 2048 bytes) |

Each player's entry is their **best Daily Duel margin on any day** (`keepBest`). Metadata records the date and rules version of the run that set it. Ties are equal scores; Wavedash ranks them. The client resolves the name with `getLeaderboard(name)` to an ID, then submits. The ID is cached only after a successful lookup.

## One-time setup (owner)

Boards created by ordinary players default to **Hidden**; boards created by the developer default to **Visible**. So the client **never calls `getOrCreateLeaderboard`**; it only looks the board up and fails gracefully if there is none.

1. In the Developer Portal, create a leaderboard named exactly `daily-duel`, Descending, Numeric. *Not verified:* whether the portal offers this, or whether `getOrCreateLeaderboard` run by the owner's own signed-in account yields a Visible board.
2. Make sure it is public (also corrects sort order and display type):

```bash
node scripts/provision-daily-leaderboards.mjs                                   # dry run
WAVEDASH_TOKEN=<portal API key> node scripts/provision-daily-leaderboards.mjs --apply   # LIVE game
```

The script prints `MISSING` (create it first) or `FAILED` and exits non-zero unless the API returned `visible: true`. If the board does not exist, nothing breaks for players: Daily Duel plays and ranks locally and the end screen says `ONLINE BOARD IS NOT OPEN YET`.

A rules-version bump keeps the same board; scores from older rules stay on it. If that matters, rename the constant (e.g. `daily-duel-v2`) and repeat setup.

## End-screen states

The attempt just played and the saved best are separate rows, because `keepBest` leaves a better earlier score in place:

| State | Shown |
| --- | --- |
| Submitted | `THIS ATTEMPT  -2  RANK #40` and `SAVED BEST  +5  RANK #7 (KEPT)` (`THIS ATTEMPT` is the submission's rank; `SAVED BEST` the stored standing) |
| In flight | `SUBMITTING...` |
| Guest, signed out, no SDK | `NOT SUBMITTED - SIGN IN ON WAVEDASH` (local rank still shown) |
| No board | `ONLINE BOARD IS NOT OPEN YET` |
| Network/SDK failure after 2 retries (2 s, 8 s) | `SUBMIT FAILED - NOT RANKED` |

No rank is ever displayed unless Wavedash returned one. A failure is never shown as success.

## No duplicate submissions

Each finished attempt has one serial (`matchSerial`). `DailyLeaderboardSubmitter` sends once per serial in any state (pending, submitted, local, missing, failed); reopening the end screen, watching a replay or re-rendering never resubmits. Automatic retries cover only transient failures of the same attempt, and `keepBest` makes a repeated identical score a no-op. Unfinished attempts, Standard and guided matches are never submitted.

## Verification status

| Check | Status |
| --- | --- |
| Score derivation, name/date/version isolation, ties, metadata size, once-only, retries, guest/signed-out/missing-board/failure paths, end-screen rows | unit tests (`npm test`) |
| Real submission and rank in the Wavedash sandbox / `wavedash dev` | **not done**: needs the owner's sign-in and the created board; the Chrome extension was unavailable earlier |
| `getLeaderboard`'s error text for a missing board | **not verified**; the adapter matches `not found` style messages. If Wavedash words it differently, a missing board shows `SUBMIT FAILED` instead of `NOT OPEN YET`, still not a false success |
| Whether players can resolve and submit to a *Hidden* board | **not verified** |
| Public Leaderboards tab populated | **no**; the board has not been created or published |
