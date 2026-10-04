import {
  MOVES_PER_ROUND,
  START_TILES,
  TOTAL_ROUNDS,
} from "./constants";
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
  previousBoard?: BoardState;
  previousPickups?: Pickup[];
  robotTiles?: RoundRobotTiles;
}

export function createInitialMatch(): MatchState {
  return {
    currentRound: 1,
    totalRounds: TOTAL_ROUNDS,
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

export function createRoundState(
  round: number,
  options: RoundSetupOptions = {},
): RoundState {
  const robotTiles = options.robotTiles ?? {};
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
  );
  const board = addBlockersForRound(
    boardBeforeNewBlockers,
    round,
    [
      ...occupiedTiles,
      ...pickups.map((pickup) => pickup.tile),
    ],
  );

  return {
    round,
    priorityOwner: getRoundPriorityOwner(round),
    board,
    pickups,
    player,
    rival,
    playerQueue: [],
    rivalQueue: [],
    rivalMood: null,
    currentExecutionStep: 0,
    stun: {
      player: 0,
      rival: 0,
    },
  };
}

export function getRoundPriorityOwner(round: number): RoundPriorityOwner {
  return round % 2 === 1 ? "player" : "rival";
}

export function canQueueMove(round: RoundState): boolean {
  return round.playerQueue.length < MOVES_PER_ROUND;
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
  return round.playerQueue.length === MOVES_PER_ROUND;
}

export function lockRoundQueues(round: RoundState): RoundState {
  const rivalPlan = planRivalTurn(round.board, round.rival.tile, round.pickups, {
    playerTile: round.player.tile,
    priorityOwner: round.priorityOwner,
    seed: round.round,
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
