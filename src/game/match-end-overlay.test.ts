import { describe, expect, it } from "vitest";

import { createMatchCompleteOverlayModel } from "./match-end-overlay";
import { createInitialMatch, finishRound } from "./match-flow";
import type { FinalResultLabel } from "./match-end-overlay";
import type { MatchState } from "./types";

describe("match-complete scene overlay smoke", () => {
  it.each([
    { playerScore: 12, rivalScore: 8, label: "Victory" },
    { playerScore: 6, rivalScore: 10, label: "Defeat" },
    { playerScore: 9, rivalScore: 9, label: "Draw" },
  ] satisfies Array<{
    playerScore: number;
    rivalScore: number;
    label: FinalResultLabel;
  }>)("keeps the $label headline in the overlay model", (scenario) => {
    const overlay = createMatchCompleteOverlayModel(
      completeMatch(scenario.playerScore, scenario.rivalScore),
    );

    expect(overlay.resultLabel).toBe(scenario.label);
    expect(overlay.resultLabel).not.toHaveLength(0);
    expect(overlay.resultSubtitle).not.toHaveLength(0);
  });

  it("keeps the final score rows renderable for match-complete", () => {
    const overlay = createMatchCompleteOverlayModel(completeMatch(12, 8));

    expect(overlay.scoreRows).toEqual([
      { label: "YOUR SCORE", value: "12", tone: "player" },
      { label: "ENEMY SCORE", value: "8", tone: "rival" },
      { label: "ROUND REACHED", value: "5 / 5", tone: "neutral" },
    ]);
  });

  it("omits extra final summary stats", () => {
    const overlay = createMatchCompleteOverlayModel({
      ...completeMatch(12, 8),
      stats: {
        playerPickupsCollected: 7,
        rivalPickupsCollected: 5,
        playerThreePointPickupsCollected: 3,
        rivalThreePointPickupsCollected: 1,
        playerCollisionsWon: 4,
        rivalCollisionsWon: 2,
      },
    });

    expect(overlay.statLines).toEqual([]);
  });
});

function completeMatch(playerScore: number, rivalScore: number): MatchState {
  return finishRound({
    ...createInitialMatch(),
    currentRound: 5,
    playerScore,
    rivalScore,
  });
}
