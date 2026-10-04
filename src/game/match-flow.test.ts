import { describe, expect, it } from "vitest";

import {
  canQueueMove,
  createInitialMatch,
  createRestartMatch,
  createRoundState,
  finishRound,
  isPlayerQueueReady,
  lockRoundQueues,
  queuePlayerMove,
  skipGuidedIntro,
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

  it("defaults to Standard: five rounds, eight steps", () => {
    const match = createInitialMatch();
    expect(match.mode).toBe("standard");
    expect(match.totalRounds).toBe(5);
    expect(createRoundState(1).maxSteps).toBe(8);
  });

  it("sets round length from the mode rules", () => {
    const guided = createInitialMatch("guided");
    expect(guided.totalRounds).toBe(2);
    expect(createRoundState(1, { mode: "guided" }).maxSteps).toBe(4);
    expect(createRoundState(2, { mode: "guided" }).maxSteps).toBe(8);
  });

  it("is ready to execute at the round's step count, not before", () => {
    let round = createRoundState(1, { mode: "guided" });
    for (let i = 0; i < 3; i += 1) round = queuePlayerMove(round, "up");
    expect(isPlayerQueueReady(round)).toBe(false);
    round = queuePlayerMove(round, "up");
    expect(isPlayerQueueReady(round)).toBe(true);
    expect(canQueueMove(round)).toBe(false);
    expect(queuePlayerMove(round, "up").playerQueue).toHaveLength(4);
  });

  it("plans a rival queue as long as the round", () => {
    const round = lockRoundQueues(createRoundState(1, { mode: "guided" }));
    expect(round.rivalQueue).toHaveLength(4);
    const standard = lockRoundQueues(createRoundState(1));
    expect(standard.rivalQueue).toHaveLength(8);
  });

  it("finishes the guided intro after round two", () => {
    const round2 = { ...createInitialMatch("guided"), currentRound: 2 };
    expect(finishRound(round2).status).toBe("match-complete");
    const round1 = createInitialMatch("guided");
    expect(finishRound(round1).status).toBe("round-complete");
    expect(startNextRound(finishRound(round1)).currentRound).toBe(2);
  });

  it("skips from the guide to a fresh Standard match", () => {
    const mid = { ...createInitialMatch("guided"), playerScore: 3, currentRound: 2 };
    const skipped = skipGuidedIntro(mid);
    expect(skipped).toEqual(createInitialMatch("standard"));
  });

  it("leaves a Standard match untouched when asked to skip the guide", () => {
    const standard = { ...createInitialMatch(), playerScore: 4 };
    expect(skipGuidedIntro(standard)).toBe(standard);
  });

  it("restarts into Standard after a guided duel", () => {
    const done = finishRound({ ...createInitialMatch("guided"), currentRound: 2 });
    expect(createRestartMatch(done)).toEqual(createInitialMatch("standard"));
    expect(createRestartMatch(createInitialMatch("standard")).mode).toBe("standard");
  });
});
