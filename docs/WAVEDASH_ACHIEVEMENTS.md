# Wavedash achievements and stats

Code: `src/game/mastery.ts` (rules, tracker), `src/platform/wavedash.ts` (`commitProgress`). Definitions: `wavedash/achievements.json`.

## Definitions

| Achievement ID | Title | Unlocks when |
| --- | --- | --- |
| `FINISH_MATCH` | First Duel | a Standard or Daily match reaches its end screen |
| `WIN_MATCH` | Higher Score | final player score is strictly above the enemy's |
| `CLAIM_THREE_HIGH_VALUE_NODES` | Triple Surge | the player collects 3+ three-point nodes in one match |
| `WIN_CLASH_ON_ENEMY_PRIORITY` | Against the Odds | the player wins a clash in a round where the enemy had priority (the enemy is stunned) |
| `COMPLETE_DAILY_DUEL` | Daily Duelist | a Daily Duel is finished, win or lose |

| Stat ID | Meaning |
| --- | --- |
| `MATCHES_COMPLETED` | lifetime finished Standard + Daily matches |
| `MATCHES_WON` | lifetime wins |
| `DAILY_DUELS_COMPLETED` | lifetime finished Daily Duels |

Only the numeric stats needed for lifetime wins and daily completions exist; the two per-match achievements need no stat. Achievements are standard (client-set), not stat-triggered. The guided intro and unfinished or abandoned matches never count. Replays, rematches' replays and re-opening the end screen never re-count; a rematch is a new match.

## Behaviour

- Local feedback first: the end screen lists new unlocks (`ACHIEVEMENT` rows) immediately for everyone, including guests. Unlocks are remembered on the device (`energy-duel.mastery.v1`), so they are announced once per device.
- Wavedash writes wait for stats **and** achievements to load (probe: a no-op `setStat`), because the SDK silently drops earlier writes and reads 0 before load. Lifetime stats are written as `baseline + this session's total`, never read-modify-write, so a retry cannot double-count.
- A write counts as stored only when the SDK emits `StatsStored { success: true }`. The end screen shows `SAVED TO WAVEDASH` only then; otherwise `SAVING...`, `SAVED ON THIS DEVICE` (guest/signed out) or `WAVEDASH SAVE RETRYING LATER`.
- Failed writes retry twice (2s, 8s), then again on the next finished match and on next launch (every write re-sends the full unlocked set).
- Known SDK limit: a failed store clears the SDK's dirty flags. The adapter re-dirties stats on retry; achievements cannot be re-dirtied in-session, so they are repaired on the next launch.
- Unlocks earned as a guest on a device are sent to the account the next time that device launches signed in; guest stat counts are not.

## Sandbox vs production — read before running anything

The `wavedash` CLI (0.1.98) `stat create` / `achievement create` take only `--game-id` (default: `wavedash.toml`, the **live** game). There is no sandbox flag, and Wavedash's docs do not describe a separate sandbox definition set. Creating these therefore edits the game's real definitions, which may populate the public Achievements tab. They were run on 2026-10-04 with the owner's approval; do not run them again (duplicates). `wavedash dev` runs the local build against the platform; `wavedash clear-playtest-data` removes playtest progress.

```bash
wavedash stat create --identifier MATCHES_COMPLETED --name "Matches completed"
wavedash stat create --identifier MATCHES_WON --name "Matches won"
wavedash stat create --identifier DAILY_DUELS_COMPLETED --name "Daily Duels completed"
wavedash achievement create --identifier FINISH_MATCH --title "First Duel" --description "Finish a Standard Match or Daily Duel."
wavedash achievement create --identifier WIN_MATCH --title "Higher Score" --description "Win a match by finishing with a higher score than the enemy."
wavedash achievement create --identifier CLAIM_THREE_HIGH_VALUE_NODES --title "Triple Surge" --description "Claim three high-value (3-point) nodes in a single match."
wavedash achievement create --identifier WIN_CLASH_ON_ENEMY_PRIORITY --title "Against the Odds" --description "Win a clash in a round where the enemy holds collision priority."
wavedash achievement create --identifier COMPLETE_DAILY_DUEL --title "Daily Duelist" --description "Finish a Daily Duel, win or lose."
```

## Verification status

| Check | Status |
| --- | --- |
| Unit tests for every trigger, non-trigger, duplicate and retry path | done (`npm test`) |
| Definitions created on the game (CLI, 2026-10-04; `achievement list --json` returns all 5) | done — on the live game's definitions, not a sandbox |
| Real unlock through `wavedash dev` / playtest | **not done**: `wavedash dev` served locally but the Chrome extension was unreachable and sign-in needs the owner |
| Public Achievements tab populated | **no** — it showed nothing at last review and has not been re-checked |
