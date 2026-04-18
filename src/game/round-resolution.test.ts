import { describe, expect, it } from "vitest";

import { resolveNextStep } from "./round-resolution";
import type { BoardState, Move, RoundState, TilePosition } from "./types";

const OPEN_BOARD: BoardState = {
  size: 8,
  blockers: [],
};

describe("round resolution stun timing", () => {
  it("makes the collision loser skip the immediately following step only", () => {
    let round = createForcedCollisionRound();

    const collisionStep = resolveNextStep(round);
    round = collisionStep.round;

    expect(collisionStep.step.step).toBe(1);
    expect(collisionStep.step.collision).toBe(true);
    expect(collisionStep.step.collisionWinner).toBe("player");
    expect(collisionStep.step.collisionLoser).toBe("rival");
    expect(collisionStep.step.rivalQueuedMove).toBe("left");
    expect(collisionStep.step.rivalMove).toBe("left");
    expect(collisionStep.step.rivalWasStunned).toBe(false);
    expect(collisionStep.step.rivalTile).toEqual(tile(1, 3));
    expect(round.stun).toEqual({ player: 0, rival: 1 });

    const skippedStep = resolveNextStep(round);
    round = skippedStep.round;

    expect(skippedStep.step.step).toBe(2);
    expect(skippedStep.step.collision).toBe(false);
    expect(skippedStep.step.rivalQueuedMove).toBe("left");
    expect(skippedStep.step.rivalMove).toBe("wait");
    expect(skippedStep.step.rivalWasStunned).toBe(true);
    expect(skippedStep.step.rivalTile).toEqual(tile(1, 3));
    expect(round.currentExecutionStep).toBe(2);
    expect(round.stun).toEqual({ player: 0, rival: 0 });

    const recoveredStep = resolveNextStep(round);

    expect(recoveredStep.step.step).toBe(3);
    expect(recoveredStep.step.rivalQueuedMove).toBe("left");
    expect(recoveredStep.step.rivalMove).toBe("left");
    expect(recoveredStep.step.rivalWasStunned).toBe(false);
    expect(recoveredStep.step.rivalTile).toEqual(tile(1, 2));
    expect(recoveredStep.round.stun).toEqual({ player: 0, rival: 0 });
  });

  it("makes the loser of a swap collision skip the immediately following step only", () => {
    let round = createForcedSwapCollisionRound();

    const collisionStep = resolveNextStep(round);
    round = collisionStep.round;

    expect(collisionStep.step.step).toBe(1);
    expect(collisionStep.step.collision).toBe(true);
    expect(collisionStep.step.collisionWinner).toBe("player");
    expect(collisionStep.step.collisionLoser).toBe("rival");
    expect(collisionStep.step.playerTile).toEqual(tile(2, 3));
    expect(collisionStep.step.rivalTile).toEqual(tile(2, 3));
    expect(collisionStep.step.rivalQueuedMove).toBe("left");
    expect(collisionStep.step.rivalMove).toBe("left");
    expect(collisionStep.step.rivalWasStunned).toBe(false);
    expect(round.stun).toEqual({ player: 0, rival: 1 });

    const skippedStep = resolveNextStep(round);
    round = skippedStep.round;

    expect(skippedStep.step.step).toBe(2);
    expect(skippedStep.step.collision).toBe(false);
    expect(skippedStep.step.rivalQueuedMove).toBe("right");
    expect(skippedStep.step.rivalMove).toBe("wait");
    expect(skippedStep.step.rivalWasStunned).toBe(true);
    expect(skippedStep.step.rivalTile).toEqual(tile(2, 3));
    expect(round.currentExecutionStep).toBe(2);
    expect(round.stun).toEqual({ player: 0, rival: 0 });

    const recoveredStep = resolveNextStep(round);

    expect(recoveredStep.step.step).toBe(3);
    expect(recoveredStep.step.rivalQueuedMove).toBe("right");
    expect(recoveredStep.step.rivalMove).toBe("right");
    expect(recoveredStep.step.rivalWasStunned).toBe(false);
    expect(recoveredStep.step.rivalTile).toEqual(tile(2, 4));
    expect(recoveredStep.round.stun).toEqual({ player: 0, rival: 0 });
  });

  it("applies the same one-step stun when the player loses priority", () => {
    let round = createForcedPlayerLossRound();

    const collisionStep = resolveNextStep(round);
    round = collisionStep.round;

    expect(collisionStep.step.collision).toBe(true);
    expect(collisionStep.step.collisionWinner).toBe("rival");
    expect(collisionStep.step.collisionLoser).toBe("player");
    expect(collisionStep.step.playerQueuedMove).toBe("right");
    expect(collisionStep.step.playerMove).toBe("right");
    expect(collisionStep.step.playerWasStunned).toBe(false);
    expect(round.stun).toEqual({ player: 1, rival: 0 });

    const skippedStep = resolveNextStep(round);
    round = skippedStep.round;

    expect(skippedStep.step.playerQueuedMove).toBe("right");
    expect(skippedStep.step.playerMove).toBe("wait");
    expect(skippedStep.step.playerWasStunned).toBe(true);
    expect(skippedStep.step.playerTile).toEqual(tile(1, 1));
    expect(round.stun).toEqual({ player: 0, rival: 0 });

    const recoveredStep = resolveNextStep(round);

    expect(recoveredStep.step.playerQueuedMove).toBe("right");
    expect(recoveredStep.step.playerMove).toBe("right");
    expect(recoveredStep.step.playerWasStunned).toBe(false);
    expect(recoveredStep.step.playerTile).toEqual(tile(1, 2));
    expect(recoveredStep.round.stun).toEqual({ player: 0, rival: 0 });
  });
});

function createForcedCollisionRound(): RoundState {
  return {
    round: 1,
    priorityOwner: "player",
    board: OPEN_BOARD,
    pickups: [],
    player: {
      id: "player",
      tile: tile(1, 1),
    },
    rival: {
      id: "rival",
      tile: tile(1, 3),
    },
    playerQueue: moves("right", "up", "wait"),
    rivalQueue: moves("left", "left", "left"),
    rivalMood: null,
    currentExecutionStep: 0,
    stun: {
      player: 0,
      rival: 0,
    },
  };
}

function createForcedSwapCollisionRound(): RoundState {
  return {
    round: 1,
    priorityOwner: "player",
    board: OPEN_BOARD,
    pickups: [],
    player: {
      id: "player",
      tile: tile(2, 2),
    },
    rival: {
      id: "rival",
      tile: tile(2, 3),
    },
    playerQueue: moves("right", "up", "wait"),
    rivalQueue: moves("left", "right", "right"),
    rivalMood: null,
    currentExecutionStep: 0,
    stun: {
      player: 0,
      rival: 0,
    },
  };
}

function createForcedPlayerLossRound(): RoundState {
  return {
    round: 2,
    priorityOwner: "rival",
    board: OPEN_BOARD,
    pickups: [],
    player: {
      id: "player",
      tile: tile(1, 1),
    },
    rival: {
      id: "rival",
      tile: tile(1, 3),
    },
    playerQueue: moves("right", "right", "right"),
    rivalQueue: moves("left", "up", "wait"),
    rivalMood: null,
    currentExecutionStep: 0,
    stun: {
      player: 0,
      rival: 0,
    },
  };
}

function moves(...firstMoves: Move[]): Move[] {
  return [...firstMoves, ...Array<Move>(8 - firstMoves.length).fill("wait")];
}

function tile(row: number, col: number): TilePosition {
  return { row, col };
}
