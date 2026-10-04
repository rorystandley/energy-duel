import { START_TILES } from "./constants";
import { RULES_VERSION, getModeRules, getMovesForRound } from "./match-rules";
import { createMatchSeed, createSeededRandom, deriveSeed } from "./random";
import {
  addBlockersForRound,
  copyBoard,
  copyTile,
  createInitialBoard,
} from "./board";
import { createRoundPickups } from "./pickups";
import { planRivalTurn } from "./robot-ai";
import type {
  BoardState,
  MatchMode,
  MatchState,
  MatchStats,
  Move,
  Pickup,
  RobotId,
  RoundPriorityOwner,
  RoundState,
  TilePosition,
} from "./types";

type RoundRobotTiles = Partial<Record<RobotId, TilePosition>>;

interface RoundSetupOptions {
  mode?: MatchMode;
  /** Match seed; omit only for throwaway rounds that need no reproduction. */
  seed?: number;
  previousBoard?: BoardState;
  previousPickups?: Pickup[];
  robotTiles?: RoundRobotTiles;
}

export interface MatchOptions {
  seed?: number;
}

export function createInitialMatch(
  mode: MatchMode = "standard",
  options: MatchOptions = {},
): MatchState {
  return {
    mode,
    seed: options.seed ?? createMatchSeed(),
    rulesVersion: RULES_VERSION,
    currentRound: 1,
    totalRounds: getModeRules(mode).totalRounds,
    playerScore: 0,
    rivalScore: 0,
    status: "queuing",
    winner: null,
    stats: createInitialMatchStats(),
  };
}

function createInitialMatchStats(): MatchStats {
  return {
    playerPickupsCollected: 0,
    rivalPickupsCollected: 0,
    playerThreePointPickupsCollected: 0,
    rivalThreePointPickupsCollected: 0,
    playerCollisionsWon: 0,
    rivalCollisionsWon: 0,
  };
}

export function skipGuidedIntro(match: MatchState): MatchState {
  return match.mode === "guided" ? createInitialMatch("standard") : match;
}

export function createRestartMatch(
  _match: MatchState,
  options: MatchOptions = {},
): MatchState {
  return createInitialMatch("standard", options);
}

export function createRoundState(
  round: number,
  options: RoundSetupOptions = {},
): RoundState {
  const robotTiles = options.robotTiles ?? {};
  const matchSeed = options.seed ?? createMatchSeed();
  const random = createSeededRandom(deriveSeed(matchSeed, "round", round));
  const player = {
    id: "player" as RobotId,
    tile: copyTile(robotTiles.player ?? START_TILES.player),
  };
  const rival = {
    id: "rival" as RobotId,
    tile: copyTile(robotTiles.rival ?? START_TILES.rival),
  };
  const occupiedTiles = [player.tile, rival.tile];
  const boardBeforeNewBlockers = options.previousBoard
    ? copyBoard(options.previousBoard)
    : createInitialBoard();
  const pickups = createRoundPickups(
    boardBeforeNewBlockers,
    occupiedTiles,
    options.previousPickups,
    round,
    random,
  );
  const board = addBlockersForRound(
    boardBeforeNewBlockers,
    round,
    [
      ...occupiedTiles,
      ...pickups.map((pickup) => pickup.tile),
    ],
    random,
  );

  return {
    round,
    seed: deriveSeed(matchSeed, "rival", round),
    priorityOwner: getRoundPriorityOwner(round),
    board,
    pickups,
    player,
    rival,
    playerQueue: [],
    rivalQueue: [],
    rivalMood: null,
    maxSteps: getMovesForRound(options.mode ?? "standard", round),
    currentExecutionStep: 0,
    stun: {
      player: 0,
      rival: 0,
    },
  };
}

/** Builds the next round from the one just finished, carrying board, pickups and robot tiles. */
export function createNextRoundState(
  match: MatchState,
  previousRound: RoundState,
): RoundState {
  return createRoundState(match.currentRound, {
    mode: match.mode,
    seed: match.seed,
    previousBoard: previousRound.board,
    previousPickups: previousRound.pickups,
    robotTiles: {
      player: previousRound.player.tile,
      rival: previousRound.rival.tile,
    },
  });
}

export function getRoundPriorityOwner(round: number): RoundPriorityOwner {
  return round % 2 === 1 ? "player" : "rival";
}

export function canQueueMove(round: RoundState): boolean {
  return round.playerQueue.length < round.maxSteps;
}

export function queuePlayerMove(round: RoundState, move: Move): RoundState {
  if (!canQueueMove(round)) {
    return round;
  }

  return {
    ...round,
    playerQueue: [...round.playerQueue, move],
  };
}

export function removeLastPlayerMove(round: RoundState): RoundState {
  return {
    ...round,
    playerQueue: round.playerQueue.slice(0, -1),
  };
}

export function clearPlayerQueue(round: RoundState): RoundState {
  return {
    ...round,
    playerQueue: [],
  };
}

export function isPlayerQueueReady(round: RoundState): boolean {
  return round.playerQueue.length === round.maxSteps;
}

export function lockRoundQueues(round: RoundState): RoundState {
  const rivalPlan = planRivalTurn(round.board, round.rival.tile, round.pickups, {
    playerTile: round.player.tile,
    priorityOwner: round.priorityOwner,
    seed: round.seed,
    steps: round.maxSteps,
  });

  return {
    ...round,
    rivalQueue: rivalPlan.moves,
    rivalMood: rivalPlan.mood,
  };
}

export function applyStepScore(match: MatchState, playerDelta: number, rivalDelta: number): MatchState {
  return {
    ...match,
    playerScore: match.playerScore + playerDelta,
    rivalScore: match.rivalScore + rivalDelta,
  };
}

export function finishRound(match: MatchState): MatchState {
  if (match.status === "match-complete") {
    return match;
  }

  if (match.currentRound >= match.totalRounds) {
    return finishMatch(match);
  }

  return {
    ...match,
    status: "round-complete",
  };
}

export function startNextRound(match: MatchState): MatchState {
  if (match.status === "match-complete") {
    return match;
  }

  if (match.currentRound >= match.totalRounds) {
    return finishMatch(match);
  }

  return {
    ...match,
    currentRound: Math.min(match.currentRound + 1, match.totalRounds),
    status: "queuing",
  };
}

function finishMatch(match: MatchState): MatchState {
  return {
    ...match,
    status: "match-complete",
    winner: getWinner(match.playerScore, match.rivalScore),
  };
}

function getWinner(playerScore: number, rivalScore: number): RobotId | "draw" {
  if (playerScore > rivalScore) {
    return "player";
  }

  if (rivalScore > playerScore) {
    return "rival";
  }

  return "draw";
}
