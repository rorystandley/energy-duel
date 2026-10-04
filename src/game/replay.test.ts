import { describe, expect, it } from "vitest";

import { BOARD_SIZE, MOVES, PICKUPS_PER_ROUND, START_TILES } from "./constants";
import { tileKey } from "./board";
import { createInitialMatch, createRoundState, lockRoundQueues } from "./match-flow";
import { RULES_VERSION } from "./match-rules";
import {
  REPLAY_FORMAT_VERSION,
  parseReplay,
  serializeReplay,
  simulateMatch,
  verifyReplay,
} from "./replay";
import { createSeededRandom } from "./random";
import type { Move, RoundState } from "./types";

function queuesFor(seed: number, rounds = 5, steps = 8): Move[][] {
  const random = createSeededRandom(seed ^ 0x9e3779b9);

  return Array.from({ length: rounds }, () =>
    Array.from({ length: steps }, () => MOVES[Math.floor(random() * MOVES.length)]),
  );
}

function assertValidBoard(round: RoundState): void {
  const blocked = new Set(round.board.blockers.map(tileKey));
  const occupied = new Set<string>();

  expect(blocked.size).toBe(round.board.blockers.length);
  expect(round.pickups).toHaveLength(PICKUPS_PER_ROUND);

  for (const tile of [
    round.player.tile,
    round.rival.tile,
    ...round.pickups.map((pickup) => pickup.tile),
  ]) {
    expect(tile.row).toBeGreaterThanOrEqual(0);
    expect(tile.row).toBeLessThan(BOARD_SIZE);
    expect(tile.col).toBeGreaterThanOrEqual(0);
    expect(tile.col).toBeLessThan(BOARD_SIZE);
    expect(blocked.has(tileKey(tile))).toBe(false);
    expect(occupied.has(tileKey(tile))).toBe(false);
    occupied.add(tileKey(tile));
  }
}

describe("seeded match setup", () => {
  it("creates identical rounds for the same seed", () => {
    for (const round of [1, 2, 5]) {
      const a = createRoundState(round, { seed: 1234 });
      const b = createRoundState(round, { seed: 1234 });

      expect(b).toEqual(a);
    }
  });

  it("creates varied valid boards for different seeds", () => {
    const signatures = new Set<string>();

    for (let seed = 1; seed <= 40; seed += 1) {
      const round = createRoundState(1, { seed });

      assertValidBoard(round);
      signatures.add(
        JSON.stringify([round.board.blockers, round.pickups.map((p) => p.tile)]),
      );
    }

    expect(signatures.size).toBeGreaterThan(30);
  });

  it("carries the seed and rules version through match creation", () => {
    const match = createInitialMatch("standard", { seed: 77 });

    expect(match.seed).toBe(77);
    expect(match.rulesVersion).toBe(RULES_VERSION);
    expect(createInitialMatch().seed).toEqual(expect.any(Number));
  });

  it("plans the rival without reading the player's queue", () => {
    const round = createRoundState(2, { seed: 9 });
    const a = lockRoundQueues({ ...round, playerQueue: queuesFor(1)[0] });
    const b = lockRoundQueues({ ...round, playerQueue: queuesFor(2)[0] });

    expect(a.rivalQueue).toEqual(b.rivalQueue);
    expect(a.rivalMood).toBe(b.rivalMood);
  });
});

describe("deterministic replay", () => {
  it("reproduces boards, scores and step results from seed and queues", () => {
    const queues = queuesFor(5);
    const first = simulateMatch({ seed: 2024, playerQueues: queues });
    const second = simulateMatch({ seed: 2024, playerQueues: queues });

    expect(first.rounds).toHaveLength(5);
    expect(second.rounds.map((round) => round.board)).toEqual(
      first.rounds.map((round) => round.board),
    );
    expect(second.rounds.map((round) => round.steps)).toEqual(
      first.rounds.map((round) => round.steps),
    );
    expect(second.result).toEqual(first.result);
    expect(first.result).toBeDefined();
    expect(first.rulesVersion).toBe(RULES_VERSION);
  });

  it("records starting positions, both queues and resolved steps per round", () => {
    const replay = simulateMatch({ seed: 3, playerQueues: queuesFor(3) });
    const [firstRound] = replay.rounds;

    expect(firstRound.playerStart).toEqual(START_TILES.player);
    expect(firstRound.rivalStart).toEqual(START_TILES.rival);
    expect(firstRound.playerQueue).toHaveLength(8);
    expect(firstRound.rivalQueue).toHaveLength(8);
    expect(firstRound.steps).toHaveLength(8);
    expect(firstRound.steps[0].playerQueuedMove).toBe(firstRound.playerQueue[0]);
  });

  it("produces different outcomes across seeds for the same queues", () => {
    const queues = queuesFor(5);
    const roundTwoRecords = new Set(
      [1, 2, 3, 4, 5, 6].map((seed) =>
        JSON.stringify(simulateMatch({ seed, playerQueues: queues }).rounds[1]),
      ),
    );

    expect(roundTwoRecords.size).toBeGreaterThan(1);
  });

  it("supports the shorter guided mode", () => {
    const replay = simulateMatch({
      seed: 8,
      mode: "guided",
      playerQueues: [queuesFor(8, 1, 4)[0], queuesFor(9, 1, 8)[0]],
    });

    expect(replay.rounds.map((round) => round.maxSteps)).toEqual([4, 8]);
    expect(replay.result).toBeDefined();
    expect(verifyReplay(replay).ok).toBe(true);
  });
});

describe("replay serialization", () => {
  it("round-trips through JSON and still verifies", () => {
    const replay = simulateMatch({ seed: 99, playerQueues: queuesFor(99) });
    const parsed = parseReplay(serializeReplay(replay));

    expect(parsed.ok).toBe(true);

    if (parsed.ok) {
      expect(parsed.replay).toEqual(replay);
      expect(verifyReplay(parsed.replay)).toEqual({ ok: true });
    }
  });

  it("detects tampered records", () => {
    const replay = simulateMatch({ seed: 99, playerQueues: queuesFor(99) });
    const tampered = JSON.parse(serializeReplay(replay));

    tampered.rounds[2].playerQueue[0] =
      tampered.rounds[2].playerQueue[0] === "up" ? "down" : "up";

    expect(verifyReplay(tampered).ok).toBe(false);

    const wrongScore = JSON.parse(serializeReplay(replay));
    wrongScore.result.playerScore += 1;

    expect(verifyReplay(wrongScore)).toEqual({ ok: false, mismatch: "result" });
  });

  it("rejects unsupported versions with a clear label", () => {
    const replay = simulateMatch({ seed: 1, playerQueues: queuesFor(1) });
    const futureFormat = parseReplay(
      JSON.stringify({ ...replay, formatVersion: REPLAY_FORMAT_VERSION + 1 }),
    );
    const futureRules = parseReplay(
      JSON.stringify({ ...replay, rulesVersion: RULES_VERSION + 1 }),
    );

    expect(futureFormat).toMatchObject({
      ok: false,
      reason: "unsupported-format-version",
    });
    expect(futureRules).toMatchObject({
      ok: false,
      reason: "unsupported-rules-version",
    });
    expect(futureRules.ok === false && futureRules.message).toContain(
      `rules v${RULES_VERSION + 1}`,
    );
  });

  it("rejects malformed input", () => {
    const replay = simulateMatch({ seed: 1, playerQueues: queuesFor(1) });
    const broken = JSON.parse(serializeReplay(replay));

    broken.rounds[0].playerQueue = ["up", "sideways"];

    for (const input of ["not json", "{}", "[]", JSON.stringify(broken)]) {
      expect(parseReplay(input)).toMatchObject({ ok: false, reason: "malformed" });
    }
  });
});
