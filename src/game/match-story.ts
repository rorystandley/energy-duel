import { sameTile } from "./board";
import type { ReplayRecord } from "./replay";
import type { MatchStats, Pickup, RobotId, StepResult } from "./types";

export interface RoundStory {
  round: number;
  playerPoints: number;
  rivalPoints: number;
  /** Player points minus rival points for the round. */
  net: number;
}

/** Who took `pickup` on `step`: the clash winner, otherwise whoever scored on its tile. */
export function getPickupCollector(
  step: StepResult,
  pickup: Pickup,
): RobotId | null {
  if (step.collision && step.collisionWinner) {
    return step.collisionWinner;
  }

  if (step.playerScoreDelta > 0 && sameTile(step.playerTile, pickup.tile)) {
    return "player";
  }

  if (step.rivalScoreDelta > 0 && sameTile(step.rivalTile, pickup.tile)) {
    return "rival";
  }

  return null;
}

export function deriveRoundStories(replay: ReplayRecord): RoundStory[] {
  return replay.rounds.map((round) => {
    const playerPoints = round.steps.reduce(
      (total, step) => total + step.playerScoreDelta,
      0,
    );
    const rivalPoints = round.steps.reduce(
      (total, step) => total + step.rivalScoreDelta,
      0,
    );

    return {
      round: round.round,
      playerPoints,
      rivalPoints,
      net: playerPoints - rivalPoints,
    };
  });
}

/** The round with the biggest player-minus-rival margin; ties go to more player points, then the earlier round. */
export function pickBestRound(stories: RoundStory[]): RoundStory | null {
  let best: RoundStory | null = null;

  for (const story of stories) {
    if (
      !best ||
      story.net > best.net ||
      (story.net === best.net && story.playerPoints > best.playerPoints)
    ) {
      best = story;
    }
  }

  return best;
}

/** Recomputes the match summary counters from a record, using the same collector rules as live play. */
export function deriveMatchStats(replay: ReplayRecord): MatchStats {
  const stats: MatchStats = {
    playerPickupsCollected: 0,
    rivalPickupsCollected: 0,
    playerThreePointPickupsCollected: 0,
    rivalThreePointPickupsCollected: 0,
    playerCollisionsWon: 0,
    rivalCollisionsWon: 0,
  };

  for (const round of replay.rounds) {
    for (const step of round.steps) {
      if (step.collisionWinner === "player") {
        stats.playerCollisionsWon += 1;
      } else if (step.collisionWinner === "rival") {
        stats.rivalCollisionsWon += 1;
      }

      for (const id of step.collectedPickupIds) {
        const pickup = round.pickups.find((candidate) => candidate.id === id);
        const collector = pickup ? getPickupCollector(step, pickup) : null;

        if (!pickup || !collector) {
          continue;
        }

        const prefix = collector === "player" ? "player" : "rival";

        stats[`${prefix}PickupsCollected`] += 1;

        if (pickup.value === 3) {
          stats[`${prefix}ThreePointPickupsCollected`] += 1;
        }
      }
    }
  }

  return stats;
}
