# Save, restore and cloud sync

Code: `src/game/save.ts` (schema, parsing, migrations, conflict policy), `src/game/resume.ts` (snapshot and restore of a match), `src/game/save-sync.ts` (`SaveManager`: local-first persistence and background cloud sync), `src/platform/wavedash.ts` (`readCloudFile` / `writeCloudFile`), and the resume prompt in `GameScene`.

## What is saved

One JSON file, schema `energy-duel.save` v1:

| Section | Content | Conflict rule |
| --- | --- | --- |
| `preferences` | music/SFX volume, mute | newest `updatedAt` wins, whole |
| `progress` | `onboardingSeen`, tutorial `completed` / `skipped` | only grows: OR-ed; completed beats skipped |
| `bests` | best Standard result per rules version; best Daily Duel per UTC date + rules version | keep the better margin |
| `inProgress` | a solo match at a round boundary, or `null` | newest `updatedAt` wins, whole |

The in-progress match stores only `{ mode, seed, rulesVersion, dailyDate?, playerQueues[] }`: the player's committed queue for each completed round. Restoring replays those queues through the live rules (same path as `simulateMatch` / replay verification), so the board, rival decisions, scores and stats are re-derived, never trusted from the file. A Daily Duel keeps its starting UTC date and the seed must equal `dailySeed(date, rulesVersion)`, so a run that outlives midnight still belongs to its start date and board.

Saved only when a round has fully resolved and been recorded (`snapshotMatch`): never while queuing, never during the reveal animation, never once the match is over. Reloading resumes at the start of the next round's queuing; a half-queued round is not kept. The guided tutorial is not resumable. Finishing or abandoning a match writes `inProgress = null` with a new timestamp, so a stale copy on another device cannot bring it back.

## Local first, then cloud

Every change updates memory and `localStorage` (`energy-duel.save.v1`) synchronously, then schedules a cloud sync after 1.5 s of quiet. Nothing in gameplay awaits the cloud. Guests and itch.io players never leave local-only mode. The older keys (audio, onboarding, guided intro, daily history) still hold the runtime copies; the save mirrors them, imports them the first time it runs (schema v0), and writes remote changes back into them.

Cloud file: `saves/progress.json` via `uploadRemoteFile` / `downloadRemoteFile` (a local IndexedDB copy is written or read around each call, since the JS SDK has no direct text API). Each sync is **read, merge, write**: the cloud file is downloaded, merged with the local save, and uploaded only if the merge differs from what the cloud holds. Wavedash offers no conditional (etag) write, so two devices syncing within the same few hundred milliseconds can still race; the loser's change is merged in again at its next sync.

## The one conflict policy

`mergeSaves(local, cloud)` is used in both directions and the result is written to both sides. Earned progress only grows; choices follow the newest change; an exact timestamp tie goes to the local side. Clocks are device clocks, so a device with a badly wrong clock can win preference/match conflicts; progress and bests are unaffected.

## Recovery

| Situation | Behaviour |
| --- | --- |
| Local save is not valid JSON / not ours | Raw text copied to `energy-duel.save.v1.corrupt`, fresh save built from the old keys, warning logged |
| A section is invalid | That section falls back to its default; the others are kept |
| Local or cloud save from a newer schema | Left untouched; this session runs in memory; no cloud writes (`blocked`) |
| Cloud file corrupt | Copied to `saves/progress.corrupt.json`, then replaced by the local save |
| Saved match cannot be reproduced (rules version changed, bad queues) | Not offered, not erased; the next round boundary or new match overwrites it |
| Cloud read/write fails | Local save intact; retries after 5 s, 30 s, 120 s, and on the next change |
| Different Wavedash account on the same browser | **Not handled.** Local progress is merged into whichever account syncs next. |

## Migrations

Bump `SAVE_VERSION`, add `SAVE_MIGRATIONS[oldVersion]` (raw object to raw object), and extend `sanitizeSave`. Missing or throwing migrations make the file `corrupt` (and so backed up), never silently reset. `save.test.ts` runs a v1 to v2 migration as a worked example.

## Verification status

- Unit tests: schema round trip, bad sections, daily seed/date checks, migrations, merge policy, restore equals a live-simulated match, snapshot boundaries, local-only, cloud success/failure/retry, stale save, corrupt/unsupported local and cloud, legacy import, and the adapter's cloud-file calls.
- Browser (local dev build, headless Chromium): played a round, observed the save written with one completed round, reloaded, saw the resume prompt (round 2 of 5, correct score) and resumed to the same state.
- **Not verified:** the Wavedash sandbox with a signed-in player (needs an interactive sign-in), a real upload/download against Wavedash storage, and cross-device sync. No two-device evidence exists, so cross-device restore is not claimed.
