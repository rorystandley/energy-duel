# Daily Duel

One shared board per UTC date, played locally. Wavedash leaderboard submission is out of scope (Task 10). Code: `src/game/daily.ts`.

## Seed scheme

```
date = UTC calendar day, "YYYY-MM-DD"   (utcDateString: toISOString, never the local zone)
seed = deriveSeed(0x44414c59, "daily", rulesVersion, date)     // uint32
```

- Everything else follows from `seed` exactly as for any match (`docs/REPLAY_FORMAT.md`): round boards and pickups from `deriveSeed(seed, "round", n)`, rival decisions from `deriveSeed(seed, "rival", n)`.
- **Rival policy:** the same planner as Standard, seeded from the daily seed. It sees only public state (board, pickups, its own tile, the player's start tile, priority). It never receives the player's queue; `daily.test.ts` checks three different hidden queues give identical rival plans.
- **`rulesVersion` is part of the seed.** Bumping `RULES_VERSION` therefore gives every date a new board and a new local ranking; old results are kept but never ranked with new ones.
- A later-round board depends on the earlier rounds (blockers and uncollected pickups carry over), so only round one is identical for everyone; the rival's *policy* is shared, its later plans react to the board you leave behind.

## Attempts, ranking, rollover

- `MatchState.mode === "daily"` carries `dailyDate`, stamped once at start and copied into the replay record. It is never recomputed from the clock.
- **Rollover:** a run started at 23:59 UTC and finished after midnight is attributed to its starting date. The end screen says so and offers today's board. Verified in the browser with a faked clock.
- **Reloads:** an unfinished attempt is not saved and cannot be resumed (mid-match persistence is a later task). Reloading starts a new attempt on the then-current UTC date; nothing is recorded for the abandoned one.
- Practice is unlimited. `Practice this board` replays the same date and seed; `New board` starts a random Standard match; Standard Match never touches Daily history.
- Ranking: `margin = playerScore - rivalScore`, higher is better, ties share a rank. Both scores are shown. Ranks are among this device's attempts for the same date and rules version only.

## Saved results (`localStorage` key `energy-duel.daily.v1`)

`{ "schemaVersion": 1, "attempts": [{ date, rulesVersion, playerScore, rivalScore }] }`, capped at 400 attempts.

- Corrupt JSON or wrong shape: copied to `energy-duel.daily.v1.corrupt`, history starts empty.
- Newer `schemaVersion`: left untouched and not written (results for the session stay in memory).
- Invalid individual entries are dropped. Entries for other rules versions are kept but not ranked.
- Unavailable or throwing storage: results show for the session only.

## Entry points

Key `T` or the `DAILY DUEL` button (left panel, at a fresh Standard round one), the `DAILY DUEL` action on the match-end screen, and the last page of the phone rules overlay.

## Manual cross-context check

Two fresh Chromium contexts (`America/Los_Angeles` and `Pacific/Kiritimati`, empty storage) pressed `T`: both reported date `2026-10-04`, seed `2769199686`, identical blockers and pickups.
