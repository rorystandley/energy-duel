# Daily Duel online ranking (Wavedash)

Code: `src/game/daily-leaderboard.ts` (name, score, metadata, once-only submitter), `src/platform/wavedash.ts` (`submitLeaderboardScore`), `scripts/provision-daily-leaderboards.mjs` (operator tool).

**Casual ranking.** Scores are computed and sent by the player's own browser. Nothing verifies them, so this is a casual board, not cheat-resistant. The end screen says `CASUAL, CLIENT-REPORTED`. Replays are not attached or checked.

## Board per date and rules version

| Property | Value |
| --- | --- |
| Name | `daily-v<rulesVersion>-<YYYY-MM-DD>`, e.g. `daily-v1-2026-10-04` (UTC date of the attempt's *start*) |
| Sort order | `DESC` (1), higher is better |
| Display type | `NUMERIC` (0) |
| Score | `playerScore - rivalScore` (negative when behind, `0` on a draw) |
| Submit | `uploadLeaderboardScore(id, score, keepBest = true, undefined, metadata)` |
| Metadata | `{ date, rulesVersion, playerScore, rivalScore }`, four primitives, about 80 bytes (limit 16 keys / 2048 bytes) |

Date and version are in the name, so a different day or rules version is a different board and results are never mixed. Ties are equal scores; Wavedash ranks them. The client resolves the name with `getLeaderboard(name)` to an ID, then submits. The ID is cached only after a successful lookup.

## Provisioning: who makes the board public

Wavedash: boards created by ordinary players default to **Hidden**; boards created by the developer default to **Visible**. So the client **never calls `getOrCreateLeaderboard`**. A client-created daily board would exist but be hidden from the public Leaderboards tab, and a client cannot make it visible. The client only looks boards up and fails gracefully if there is none.

What Wavedash documents for operators (checked 2026-10-04):

- The `wavedash` CLI (0.1.98) has no leaderboard command.
- The HTTP API documents one leaderboard operation, `PATCH /api/games/{gameId}/leaderboards/by-name/{name}` (body: `visible`, `displayName`, `sortOrder`, `displayType`), with `Authorization: Bearer <API key>` from the Developer Portal. No create or list endpoint is documented.

So provisioning is two operator steps, and the second is not automated:

1. **Create each board** with the exact name, Descending, Numeric, as the game owner (Developer Portal leaderboards page). Do this ahead of time, e.g. 14 days at a time. *Not verified:* whether the portal offers this, or whether `getOrCreateLeaderboard` run by the owner's own signed-in account yields a Visible board. Check before relying on either.
2. **Make them public** and correct their settings:

```bash
# dry run: prints the names and the request it would send
node scripts/provision-daily-leaderboards.mjs --from 2026-10-04 --days 14

# live: edits the game in wavedash.toml (the LIVE game, no sandbox flag)
WAVEDASH_TOKEN=<portal API key> node scripts/provision-daily-leaderboards.mjs --from 2026-10-04 --days 14 --apply
```

The script exits non-zero and prints `MISSING` (no such board, create it first) or `FAILED` for any board that did not end up visible. It never reports a board as ok unless the API returned `visible: true`.

If a day's board is not provisioned, nothing breaks for players: Daily Duel plays and ranks locally, and the end screen says `TODAY'S ONLINE BOARD IS NOT OPEN YET`. A rules-version bump needs new boards (the script reads `RULES_VERSION`).

## End-screen states

The attempt just played and the saved best are separate rows, because `keepBest` leaves a better earlier score in place:

| State | Shown |
| --- | --- |
| Submitted | `THIS ATTEMPT  -2  RANK #40` and `SAVED BEST  +5  RANK #7 (KEPT)` (`THIS ATTEMPT` is the submission's rank; `SAVED BEST` the stored standing) |
| In flight | `SUBMITTING...` |
| Guest, signed out, no SDK | `NOT SUBMITTED - SIGN IN ON WAVEDASH` (local rank still shown) |
| No board | `TODAY'S ONLINE BOARD IS NOT OPEN YET` |
| Network/SDK failure after 2 retries (2 s, 8 s) | `SUBMIT FAILED - NOT RANKED` |

No rank is ever displayed unless Wavedash returned one. A failure is never shown as success.

## No duplicate submissions

Each finished attempt has one serial (`matchSerial`). `DailyLeaderboardSubmitter` sends once per serial in any state (pending, submitted, local, missing, failed); reopening the end screen, watching a replay or re-rendering never resubmits. Automatic retries cover only transient failures of the same attempt, and `keepBest` makes a repeated identical score a no-op. Unfinished attempts, Standard and guided matches are never submitted.

## Verification status

| Check | Status |
| --- | --- |
| Score derivation, name/date/version isolation, ties, metadata size, once-only, retries, guest/signed-out/missing-board/failure paths, end-screen rows | unit tests (`npm test`) |
| Real submission and rank in the Wavedash sandbox / `wavedash dev` | **not done**: needs the owner's sign-in and a provisioned board; the Chrome extension was unavailable earlier |
| `getLeaderboard`'s error text for a missing board | **not verified**; the adapter matches `not found` style messages. If Wavedash words it differently, a missing board shows `SUBMIT FAILED` instead of `NOT OPEN YET`, still not a false success |
| Whether players can resolve and submit to a *Hidden* board | **not verified** |
| Public Leaderboards tab populated | **no**; nothing was provisioned, nothing was published |
