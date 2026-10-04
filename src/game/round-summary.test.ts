import { describe, expect, it } from "vitest";

import { createInitialMatch, finishRound, startNextRound } from "./match-flow";
import { deriveRoundSummary } from "./round-summary";
import type { Pickup, StepResult } from "./types";

function step(overrides: Partial<StepResult> & { step: number }): StepResult {
  return {
    playerQueuedMove: "wait",
    rivalQueuedMove: "wait",
    playerMove: "wait",
    rivalMove: "wait",
    playerWasStunned: false,
    rivalWasStunned: false,
    playerTile: { row: 7, col: 0 },
    rivalTile: { row: 0, col: 7 },
    collision: false,
    collisionWinner: null,
    collisionLoser: null,
    collectedPickupIds: [],
    playerScoreDelta: 0,
    rivalScoreDelta: 0,
    stun: { player: 0, rival: 0 },
    ...overrides,
  };
}

const pickups: Pickup[] = [
  { id: "a", tile: { row: 6, col: 0 }, value: 1 },
  { id: "b", tile: { row: 1, col: 7 }, value: 3 },
];

const base = { round: 2, totalRounds: 5, startPickups: pickups };

describe("deriveRoundSummary", () => {
  it("handles a round with no pickups and no clash", () => {
    const summary = deriveRoundSummary({
      ...base,
      steps: [step({ step: 1 }), step({ step: 2 })],
    });

    expect(summary.playerPoints).toBe(0);
    expect(summary.rivalPoints).toBe(0);
    expect(summary.moment).toEqual({
      text: "No nodes claimed and no clashes.",
      tone: "neutral",
    });
    expect(summary.stunNote).toBeNull();
    expect(summary.title).toBe("ROUND 2 COMPLETE");
    expect(summary.continueLabel).toBe("CONTINUE TO ROUND 3");
  });

  it("totals points and highlights the highest-value node when there is no clash", () => {
    const summary = deriveRoundSummary({
      ...base,
      steps: [
        step({
          step: 1,
          playerTile: { row: 6, col: 0 },
          playerScoreDelta: 1,
          collectedPickupIds: ["a"],
        }),
        step({
          step: 3,
          rivalTile: { row: 1, col: 7 },
          rivalScoreDelta: 3,
          collectedPickupIds: ["b"],
        }),
      ],
    });

    expect(summary.playerPoints).toBe(1);
    expect(summary.rivalPoints).toBe(3);
    expect(summary.moment).toEqual({
      text: "Enemy claimed a 3-point node at step 3.",
      tone: "rival",
    });
  });

  it("reports a clash that decided a node and the resulting stun", () => {
    const summary = deriveRoundSummary({
      ...base,
      steps: [
        step({
          step: 2,
          collision: true,
          collisionWinner: "player",
          collisionLoser: "rival",
          playerScoreDelta: 3,
          collectedPickupIds: ["b"],
        }),
        step({ step: 3, rivalWasStunned: true }),
      ],
    });

    expect(summary.moment).toEqual({
      text: "You won the clash at step 2 and took the 3-point node.",
      tone: "player",
    });
    expect(summary.stunNote).toBe("Enemy lost step 3 (stunned).");
  });

  it("reports a clash with no node and a stun on the player", () => {
    const summary = deriveRoundSummary({
      ...base,
      steps: [
        step({
          step: 4,
          collision: true,
          collisionWinner: "rival",
          collisionLoser: "player",
        }),
        step({ step: 5, playerWasStunned: true }),
      ],
    });

    expect(summary.moment.text).toBe("Enemy won the clash at step 4.");
    expect(summary.stunNote).toBe("You lost step 5 (stunned).");
  });

  it("offers a result action on the final round", () => {
    const summary = deriveRoundSummary({
      ...base,
      round: 5,
      steps: [],
    });

    expect(summary.continueLabel).toBe("SEE RESULT");
  });
});

describe("round transition", () => {
  it("stays on round-complete until continued, leaving scores untouched", () => {
    const match = { ...createInitialMatch(), playerScore: 4, rivalScore: 2 };
    const complete = finishRound(match);

    expect(complete.status).toBe("round-complete");
    expect(complete.currentRound).toBe(1);

    const next = startNextRound(complete);

    expect(next.status).toBe("queuing");
    expect(next.currentRound).toBe(2);
    expect(next.playerScore).toBe(4);
    expect(next.rivalScore).toBe(2);
  });
});
