import { describe, expect, it } from "vitest";

import { MOVES } from "./constants";
import { createInitialMatch, createRoundState, lockRoundQueues } from "./match-flow";
import { deriveMatchStats } from "./match-story";
import { simulateMatch } from "./replay";
import type { ReplayRecord } from "./replay";
import {
  buildReplayFrame,
  openReplayViewer,
  restartReplayRound,
  shiftReplayRound,
  stepReplayViewer,
} from "./replay-viewer";
import type { Move } from "./types";

function queues(seed: number): Move[][] {
  return Array.from({ length: 5 }, (_, round) =>
    Array.from(
      { length: 8 },
      (_, step) => MOVES[(seed + round * 3 + step * 5) % MOVES.length],
    ),
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }

  return value;
}

function sampleReplay(): ReplayRecord {
  return simulateMatch({ seed: 2026, playerQueues: queues(3) });
}

describe("replay viewer navigation", () => {
  it("opens on the last round, or a chosen one, locked if asked", () => {
    const replay = sampleReplay();

    expect(openReplayViewer(replay)).toMatchObject({ roundIndex: 4, step: 0 });
    expect(openReplayViewer(replay, { roundIndex: 1 })).toMatchObject({
      roundIndex: 1,
      firstRound: 0,
      lastRound: 4,
    });
    expect(openReplayViewer(replay, { roundIndex: 2, onlyThisRound: true })).toMatchObject({
      firstRound: 2,
      lastRound: 2,
    });
    expect(openReplayViewer({ ...replay, rounds: [] })).toBeNull();
  });

  it("clamps steps to the round and rounds to the allowed range", () => {
    const replay = sampleReplay();
    let view = openReplayViewer(replay, { roundIndex: 0 })!;

    view = stepReplayViewer(replay, view, -3);
    expect(view.step).toBe(0);
    view = stepReplayViewer(replay, view, 99);
    expect(view.step).toBe(8);
    expect(restartReplayRound(view).step).toBe(0);

    view = shiftReplayRound(view, -1);
    expect(view.roundIndex).toBe(0);
    expect(view.step).toBe(8);
    view = shiftReplayRound(view, 1);
    expect(view).toMatchObject({ roundIndex: 1, step: 0 });

    const locked = openReplayViewer(replay, { roundIndex: 3, onlyThisRound: true })!;
    expect(shiftReplayRound(locked, 1)).toBe(locked);
  });
});

describe("replay frames", () => {
  it("starts from the recorded board and steps through resolved results", () => {
    const replay = sampleReplay();
    const round = replay.rounds[1];
    const start = buildReplayFrame(replay, openReplayViewer(replay, { roundIndex: 1 })!);

    expect(start.round.player.tile).toEqual(round.playerStart);
    expect(start.round.pickups).toEqual(round.pickups);
    expect(start.lastStep).toBeNull();

    const end = buildReplayFrame(replay, {
      ...openReplayViewer(replay, { roundIndex: 1 })!,
      step: round.steps.length,
    });
    const final = round.steps[round.steps.length - 1];

    expect(end.round.player.tile).toEqual(final.playerTile);
    expect(end.round.rival.tile).toEqual(final.rivalTile);
    expect(end.lastStep).toEqual(final);
  });

  it("removes claimed nodes and accumulates match score across rounds", () => {
    const replay = sampleReplay();
    const lastIndex = replay.rounds.length - 1;
    const full = buildReplayFrame(replay, {
      roundIndex: lastIndex,
      step: replay.rounds[lastIndex].steps.length,
      firstRound: 0,
      lastRound: lastIndex,
    });

    expect(full.playerScore).toBe(replay.result?.playerScore);
    expect(full.rivalScore).toBe(replay.result?.rivalScore);

    for (let index = 0; index < replay.rounds.length; index += 1) {
      const recorded = replay.rounds[index];
      const claimed = recorded.steps.flatMap((step) => step.collectedPickupIds);
      const frame = buildReplayFrame(replay, {
        roundIndex: index,
        step: recorded.steps.length,
        firstRound: 0,
        lastRound: lastIndex,
      });

      expect(frame.round.pickups.map((pickup) => pickup.id)).toEqual(
        recorded.pickups
          .map((pickup) => pickup.id)
          .filter((id) => !claimed.includes(id)),
      );
    }
  });

  it("describes clashes and claims in plain words", () => {
    const replay = sampleReplay();
    const lines = replay.rounds.flatMap((round, roundIndex) =>
      round.steps.flatMap((_, stepIndex) =>
        buildReplayFrame(replay, {
          roundIndex,
          step: stepIndex + 1,
          firstRound: 0,
          lastRound: 4,
        }).narration,
      ),
    );

    expect(lines.some((line) => /claimed a \d-point node/.test(line))).toBe(true);
    expect(lines.every((line) => line.length > 0)).toBe(true);
  });
});

describe("replay isolation", () => {
  it("never mutates the record, even when frames are scribbled on", () => {
    const replay = sampleReplay();
    const before = JSON.stringify(replay);
    const view = { roundIndex: 2, step: 5, firstRound: 0, lastRound: 4 };
    const frame = buildReplayFrame(replay, view);

    frame.round.board.blockers.length = 0;
    frame.round.pickups.length = 0;
    frame.round.player.tile.row = 99;
    frame.trails.player.length = 0;
    frame.lastStep!.playerScoreDelta = 1000;

    expect(JSON.stringify(replay)).toBe(before);
    expect(buildReplayFrame(replay, view).round.player.tile.row).not.toBe(99);
  });

  it("works on a frozen record, so it cannot be writing to it", () => {
    const frozen = deepFreeze(sampleReplay());

    expect(() => {
      for (let index = 0; index < frozen.rounds.length; index += 1) {
        for (let step = 0; step <= 8; step += 1) {
          buildReplayFrame(frozen, {
            roundIndex: index,
            step,
            firstRound: 0,
            lastRound: 4,
          });
        }
      }
    }).not.toThrow();
  });

  it("leaves live match and round state untouched while a replay is walked", () => {
    const match = deepFreeze(createInitialMatch("standard", { seed: 77 }));
    const live = deepFreeze(
      lockRoundQueues({
        ...createRoundState(2, { seed: 77 }),
        playerQueue: Array<Move>(8).fill("up"),
      }),
    );
    const matchBefore = JSON.stringify(match);
    const roundBefore = JSON.stringify(live);
    const replay = sampleReplay();
    let view = openReplayViewer(replay, { roundIndex: 0 })!;

    for (let hop = 0; hop < 12; hop += 1) {
      view = stepReplayViewer(replay, view, 1);
      view = hop % 4 === 3 ? shiftReplayRound(view, 1) : view;
      buildReplayFrame(replay, view);
    }

    expect(JSON.stringify(match)).toBe(matchBefore);
    expect(JSON.stringify(live)).toBe(roundBefore);
  });
});

describe("match stats from a record", () => {
  it("agrees with the scores the record finished on", () => {
    const replay = sampleReplay();
    const stats = deriveMatchStats(replay);
    const points = (key: "playerScoreDelta" | "rivalScoreDelta") =>
      replay.rounds.reduce(
        (total, round) =>
          total + round.steps.reduce((sum, step) => sum + step[key], 0),
        0,
      );

    expect(points("playerScoreDelta")).toBe(replay.result?.playerScore);
    expect(points("rivalScoreDelta")).toBe(replay.result?.rivalScore);
    expect(stats.playerPickupsCollected).toBeGreaterThanOrEqual(
      stats.playerThreePointPickupsCollected,
    );
  });
});
