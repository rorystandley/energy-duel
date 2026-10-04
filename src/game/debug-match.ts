import { MOVES } from "./constants";
import { createSeededRandom } from "./random";
import { planRivalTurn } from "./robot-ai";
import { simulateMatch } from "./replay";
import type { ReplayRecord } from "./replay";
import type { MatchMode, MatchWinner, Move, RoundState } from "./types";

const MAX_ATTEMPTS = 4000;

/**
 * Plays seeded matches with a mirrored rival-AI player, blended with random
 * moves, until one finishes with `winner`. Debug end screens then show a real,
 * replayable match.
 */
export function findDebugReplay(
  mode: MatchMode,
  winner: Exclude<MatchWinner, null>,
  firstSeed = 1,
): ReplayRecord | null {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const seed = firstSeed + attempt;
    const random = createSeededRandom(seed ^ 0x5bd1e995);
    // Vary how sloppy the player is, so wins, losses and draws all turn up.
    const sloppiness = random();
    const replay = simulateMatch({
      seed,
      mode,
      playerQueues: (round) =>
        random() < sloppiness ? randomQueue(round.maxSteps, random) : mirroredPlan(round),
    });

    if (replay.result?.winner === winner) {
      return replay;
    }
  }

  return null;
}

function mirroredPlan(round: RoundState): Move[] {
  return planRivalTurn(round.board, round.player.tile, round.pickups, {
    playerTile: round.rival.tile,
    priorityOwner: round.priorityOwner === "player" ? "rival" : "player",
    seed: round.seed,
    steps: round.maxSteps,
  }).moves;
}

function randomQueue(steps: number, random: () => number): Move[] {
  return Array.from({ length: steps }, () => MOVES[Math.floor(random() * MOVES.length)]);
}
