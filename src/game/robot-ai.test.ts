import { describe, expect, it } from "vitest";

import { createRoundState, lockRoundQueues } from "./match-flow";
import { planRivalTurn } from "./robot-ai";
import type { Move, RoundState } from "./types";

const PLAYER_QUEUES: Move[][] = [
  [],
  Array<Move>(8).fill("wait"),
  ["up", "up", "up", "up", "up", "up", "up", "up"],
  ["right", "right", "right", "down", "down", "left", "wait", "up"],
  ["down", "left", "right", "up", "down", "left", "right", "up"],
];

function lockWithQueue(round: RoundState, queue: Move[]): RoundState {
  return lockRoundQueues({ ...round, playerQueue: queue });
}

describe("fair rival planning", () => {
  it("plans the same rival turn whatever the player has committed", () => {
    for (let roundNumber = 1; roundNumber <= 5; roundNumber += 1) {
      const round = createRoundState(roundNumber);
      const [baseline, ...others] = PLAYER_QUEUES.map((queue) =>
        lockWithQueue(round, queue),
      );

      for (const locked of others) {
        expect(locked.rivalQueue).toEqual(baseline.rivalQueue);
        expect(locked.rivalMood).toBe(baseline.rivalMood);
      }
    }
  });

  it("is repeatable for identical public state and seed", () => {
    const round = createRoundState(1);
    const context = { playerTile: round.player.tile, priorityOwner: round.priorityOwner, seed: 7 };
    const first = planRivalTurn(round.board, round.rival.tile, round.pickups, context);
    const second = planRivalTurn(round.board, round.rival.tile, round.pickups, context);

    expect(second).toEqual(first);
  });

  it("varies its plans across explicit seeds", () => {
    const round = createRoundState(1);
    const plans = new Set(
      Array.from({ length: 20 }, (_, seed) =>
        planRivalTurn(round.board, round.rival.tile, round.pickups, {
          playerTile: round.player.tile,
          priorityOwner: round.priorityOwner,
          seed,
        }).moves.join(","),
      ),
    );

    expect(plans.size).toBeGreaterThan(1);
  });
});
