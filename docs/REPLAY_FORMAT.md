# Replay format and determinism

A match is reproducible from `seed`, `rulesVersion`, `mode` and the player's committed queue for each round. No replay UI exists yet; the scene records `ReplayRecord` objects (`src/game/replay.ts`) for it to read later.

## Where randomness comes from

- `createMatchSeed()` (`src/game/random.ts`) is the only entropy source. It runs once per match, when `createInitialMatch` has no explicit seed.
- Each round's blocker and pickup placement draws from `createSeededRandom(deriveSeed(matchSeed, "round", n))`. A round's board never depends on how much earlier rounds consumed.
- The rival is planned from `deriveSeed(matchSeed, "rival", n)` plus the board, its own tile, pickups, the player's *start tile* and priority. It never sees the player's queue (covered by `replay.test.ts` and `robot-ai.test.ts`).
- Presentation randomness (`Math.random` for glow alpha and audio noise) is cosmetic and never touches rules.

## Record shape (`formatVersion` 1)

```jsonc
{
  "format": "energy-duel.replay",
  "formatVersion": 1,        // shape of this JSON
  "rulesVersion": 1,         // behaviour of the rules, see below
  "seed": 123456789,         // uint32
  "mode": "standard",        // or "guided"
  "rounds": [{
    "round": 1, "priorityOwner": "player", "maxSteps": 8,
    "board": { "size": 8, "blockers": [{ "row": 2, "col": 2 }] },
    "pickups": [{ "id": "pickup-r1-1", "tile": {}, "value": 1 }],
    "playerStart": {}, "rivalStart": {},
    "playerQueue": ["up"], "rivalQueue": ["left"], "rivalMood": "greedy",
    "steps": [ /* StepResult per step: moves, stun, collision, pickups, score deltas */ ]
  }],
  "result": { "playerScore": 0, "rivalScore": 0, "winner": "draw" }  // only once finished
}
```

Each round stores the board and pickups as they stood at lock time, both queues, and every resolved step.

## API

- `createReplay`, `recordReplayRound`, `finalizeReplay` build a record (used by `GameScene`).
- `serializeReplay` / `parseReplay` convert to and from JSON. `parseReplay` returns `{ ok: false, reason, message }` for bad input.
- `simulateMatch({ seed, mode, playerQueues })` plays a match headlessly through the same code the game uses.
- `verifyReplay` re-simulates a record from its seed and player queues and compares every round, the rival queues and the result.

## Compatibility boundary

- **`formatVersion`** changes only when the JSON shape changes. Unknown versions are rejected with reason `unsupported-format-version`.
- **`rulesVersion`** (`RULES_VERSION` in `match-rules.ts`) must be bumped whenever anything that affects the outcome for a given seed and queues changes: board or pickup generation, `deriveSeed`/PRNG, rival planning, step or collision resolution, mode lengths, constants such as start tiles or blockers. Records from versions not in `SUPPORTED_RULES_VERSIONS` are rejected with `unsupported-rules-version` and a message naming both versions. They are never replayed under the wrong rules.
- When bumping, keep an old version in `SUPPORTED_RULES_VERSIONS` only if the old behaviour is still reproducible (for example by keeping a versioned code path). Otherwise drop it.
- Changing `replay.test.ts` expectations or the seed-to-board mapping without bumping `rulesVersion` is a compatibility break.

## Out of scope

Replay playback UI, same-seed rematch, Daily Duel and Wavedash score or UGC submission.
