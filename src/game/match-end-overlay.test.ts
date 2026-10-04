import { describe, expect, it } from "vitest";

import { createMatchCompleteOverlayModel } from "./match-end-overlay";
import { createInitialMatch, finishRound } from "./match-flow";
import { MOVES } from "./constants";
import { deriveMatchStats, deriveRoundStories, pickBestRound } from "./match-story";
import { simulateMatch } from "./replay";
import type { FinalResultLabel } from "./match-end-overlay";
import type { MatchState, Move } from "./types";

function queues(seed: number): Move[][] {
  return Array.from({ length: 5 }, (_, round) =>
    Array.from(
      { length: 8 },
      (_, step) => MOVES[(seed + round * 3 + step * 7) % MOVES.length],
    ),
  );
}

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
      { label: "SCORE SWING", value: "+4", tone: "player" },
    ]);
  });

  it("summarises nodes, clashes and best round for the match story", () => {
    const replay = simulateMatch({ seed: 21, playerQueues: queues(21) });
    const match = {
      ...completeMatch(12, 8),
      stats: deriveMatchStats(replay),
    };
    const overlay = createMatchCompleteOverlayModel(match, { replay });
    const best = pickBestRound(deriveRoundStories(replay));

    expect(overlay.storyRows.map((row) => row.label)).toEqual([
      "NODES CLAIMED",
      "CLASHES WON",
      "BEST ROUND",
    ]);
    expect(overlay.storyRows[0].value).toBe(
      `${match.stats.playerPickupsCollected} - ${match.stats.rivalPickupsCollected}`,
    );
    expect(overlay.storyRows[1].value).toBe(
      `${match.stats.playerCollisionsWon} - ${match.stats.rivalCollisionsWon}`,
    );
    expect(overlay.storyRows[2].value).toContain(`R${best?.round}`);
  });

  it("offers distinct rematch and new-board actions plus replay and share", () => {
    const replay = simulateMatch({ seed: 21, playerQueues: queues(21) });

    expect(
      createMatchCompleteOverlayModel(completeMatch(12, 8), { replay }).actions,
    ).toEqual([
      { id: "rematch", label: "REMATCH THIS BOARD" },
      { id: "new-board", label: "NEW BOARD" },
      { id: "replay", label: "WATCH REPLAY" },
      { id: "share", label: "SHARE RESULT" },
    ]);
    expect(
      createMatchCompleteOverlayModel(completeMatch(12, 8)).actions.map(
        (action) => action.id,
      ),
    ).not.toContain("replay");
  });

  it.each([
    { playerScore: 12, rivalScore: 8, target: /beat your 12/i },
    { playerScore: 6, rivalScore: 10, target: /score 11\+/i },
    { playerScore: 9, rivalScore: 9, target: /beat your 9/i },
  ])("sets a concrete next target for $playerScore-$rivalScore", (scenario) => {
    expect(
      createMatchCompleteOverlayModel(
        completeMatch(scenario.playerScore, scenario.rivalScore),
      ).nextTarget,
    ).toMatch(scenario.target);
  });
});

describe("result share text", () => {
  it("carries seed, date and both scores and disclaims verification", () => {
    const match = { ...completeMatch(14, 9), seed: 4242 };
    const overlay = createMatchCompleteOverlayModel(match, {
      date: "2026-10-04",
    });

    expect(overlay.shareText).toContain("Victory 14-9");
    expect(overlay.shareText).toContain("seed 4242");
    expect(overlay.shareText).toContain("2026-10-04");
    expect(overlay.shareText).toMatch(/not a verified record/i);
    expect(overlay.shareDisclaimer).toMatch(/not a verified record/i);
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

describe("guided duel completion", () => {
  it("points a finished guided duel at the Standard Match", () => {
    const guided = {
      ...createInitialMatch("guided"),
      currentRound: 2,
      playerScore: 5,
      rivalScore: 3,
    };
    const model = createMatchCompleteOverlayModel(guided);

    expect(model.resultSubtitle).toMatch(/guided/i);
    expect(model.resultSubtitle).toMatch(/standard/i);
  });
});
