import { describe, expect, it } from "vitest";

import {
  createInitialMatch,
  finishRound,
  startNextRound,
} from "./match-flow";

describe("match flow", () => {
  it("finishes the match instead of advancing after the final round", () => {
    const finalRound = {
      ...createInitialMatch(),
      currentRound: 5,
      playerScore: 12,
      rivalScore: 8,
    };

    const finished = finishRound(finalRound);
    const afterAdvanceAttempt = startNextRound(finished);

    expect(finished.status).toBe("match-complete");
    expect(finished.winner).toBe("player");
    expect(afterAdvanceAttempt).toBe(finished);
    expect(afterAdvanceAttempt.currentRound).toBe(5);
  });

  it("reports draws at match completion", () => {
    const finalRound = {
      ...createInitialMatch(),
      currentRound: 5,
      playerScore: 9,
      rivalScore: 9,
    };

    expect(finishRound(finalRound)).toMatchObject({
      status: "match-complete",
      winner: "draw",
    });
  });

  it("starts new matches with clean scores and summary stats", () => {
    expect(createInitialMatch()).toMatchObject({
      currentRound: 1,
      playerScore: 0,
      rivalScore: 0,
      status: "queuing",
      winner: null,
      stats: {
        playerPickupsCollected: 0,
        rivalPickupsCollected: 0,
        playerThreePointPickupsCollected: 0,
        rivalThreePointPickupsCollected: 0,
        playerCollisionsWon: 0,
        rivalCollisionsWon: 0,
      },
    });
  });
});
