import {
  canEnterTile,
  copyTile,
  moveTile,
  sameTile,
} from "./board";
import type {
  BoardState,
  ExecutionRobotState,
  Move,
  Pickup,
  RobotId,
  RobotState,
  RoundResolution,
  RoundState,
  StepExecutionResolution,
  StepResolution,
  StepResult,
  StunState,
  TilePosition,
} from "./types";

const NEXT_STEP_STUN = 1;

interface StepAction {
  queuedMove: Move;
  move: Move;
  wasStunned: boolean;
}

export function resolveRound(round: RoundState): RoundResolution {
  let nextRound = copyRound(round);
  const steps: StepResult[] = [];
  let playerScoreDelta = 0;
  let rivalScoreDelta = 0;

  while (nextRound.currentExecutionStep < nextRound.maxSteps) {
    const resolution = resolveNextStep(nextRound);
    nextRound = resolution.round;
    playerScoreDelta += resolution.step.playerScoreDelta;
    rivalScoreDelta += resolution.step.rivalScoreDelta;
    steps.push(resolution.step);
  }

  return {
    finalRound: nextRound,
    playerScoreDelta,
    rivalScoreDelta,
    steps,
  };
}

export function resolveNextStep(round: RoundState): StepResolution {
  if (round.currentExecutionStep >= round.maxSteps) {
    throw new Error("Cannot resolve a round that has already finished.");
  }

  const stepIndex = round.currentExecutionStep;
  const resolution = resolveStep(
    createExecutionRobotState(
      round.player,
      round.board,
      round.pickups,
      round.playerQueue,
      round.stun.player,
    ),
    createExecutionRobotState(
      round.rival,
      round.board,
      round.pickups,
      round.rivalQueue,
      round.stun.rival,
    ),
    stepIndex,
    round.priorityOwner,
  );
  const nextRound: RoundState = {
    ...copyRound(round),
    pickups: resolution.pickups.map(copyPickup),
    player: executionStateToRobot(resolution.playerState),
    rival: executionStateToRobot(resolution.rivalState),
    currentExecutionStep: stepIndex + 1,
    stun: resolution.step.stun,
  };

  return {
    round: nextRound,
    step: resolution.step,
  };
}

export function resolveStep(
  playerState: ExecutionRobotState,
  rivalState: ExecutionRobotState,
  stepIndex: number,
  priorityOwner: RobotId,
): StepExecutionResolution {
  const board = copyBoard(playerState.board);
  const playerAction = resolveStepAction(playerState, stepIndex);
  const rivalAction = resolveStepAction(rivalState, stepIndex);
  const nextStun: StunState = {
    player: stunAfterStepStart(playerState.stun),
    rival: stunAfterStepStart(rivalState.stun),
  };
  const playerTarget = validDestination(
    board,
    playerState.tile,
    playerAction.move,
  );
  const rivalTarget = validDestination(
    board,
    rivalState.tile,
    rivalAction.move,
  );
  const collisionType = getCollisionType(
    playerState,
    rivalState,
    playerTarget,
    rivalTarget,
  );
  const collision = collisionType !== null;
  const collisionWinner = collision
    ? getCollisionWinner(
        priorityOwner,
        playerAction.wasStunned,
        rivalAction.wasStunned,
      )
    : null;
  const collisionLoser = collisionWinner ? otherRobot(collisionWinner) : null;
  const nextPlayerState = copyExecutionRobotState(playerState);
  const nextRivalState = copyExecutionRobotState(rivalState);
  let nextPickups = playerState.pickups.map(copyPickup);
  let playerScoreDelta = 0;
  let rivalScoreDelta = 0;
  let collectedPickupIds: string[] = [];

  if (collision && collisionWinner && collisionLoser) {
    const winningState =
      collisionWinner === "player" ? nextPlayerState : nextRivalState;
    const winningTarget =
      collisionWinner === "player" ? playerTarget : rivalTarget;
    winningState.tile = copyTile(winningTarget);
    nextStun[collisionLoser] = stunForNextStep();

    const collection = collectPickupForRobot(
      nextPickups,
      executionStateToRobot(winningState),
    );
    nextPickups = collection.remainingPickups;
    collectedPickupIds = collection.collectedPickupIds;

    if (collisionWinner === "player") {
      playerScoreDelta = collection.scoreDelta;
      nextPlayerState.score += playerScoreDelta;
    } else {
      rivalScoreDelta = collection.scoreDelta;
      nextRivalState.score += rivalScoreDelta;
    }
  } else {
    nextPlayerState.tile = playerTarget;
    nextRivalState.tile = rivalTarget;

    const collection = collectPickups(
      nextPickups,
      executionStateToRobot(nextPlayerState),
      executionStateToRobot(nextRivalState),
    );
    nextPickups = collection.remainingPickups;
    collectedPickupIds = collection.collectedPickupIds;
    playerScoreDelta = collection.playerScoreDelta;
    rivalScoreDelta = collection.rivalScoreDelta;
    nextPlayerState.score += playerScoreDelta;
    nextRivalState.score += rivalScoreDelta;
  }

  nextPlayerState.stun = nextStun.player;
  nextRivalState.stun = nextStun.rival;
  nextPlayerState.board = copyBoard(board);
  nextRivalState.board = copyBoard(board);
  nextPlayerState.pickups = nextPickups.map(copyPickup);
  nextRivalState.pickups = nextPickups.map(copyPickup);

  return {
    playerState: nextPlayerState,
    rivalState: nextRivalState,
    pickups: nextPickups.map(copyPickup),
    step: {
      step: stepIndex + 1,
      playerQueuedMove: playerAction.queuedMove,
      rivalQueuedMove: rivalAction.queuedMove,
      playerMove: playerAction.move,
      rivalMove: rivalAction.move,
      playerWasStunned: playerAction.wasStunned,
      rivalWasStunned: rivalAction.wasStunned,
      playerTile: copyTile(nextPlayerState.tile),
      rivalTile: copyTile(nextRivalState.tile),
      collision,
      collisionWinner,
      collisionLoser,
      collectedPickupIds,
      playerScoreDelta,
      rivalScoreDelta,
      stun: nextStun,
    },
  };
}

function resolveStepAction(
  state: ExecutionRobotState,
  stepIndex: number,
): StepAction {
  const queuedMove = state.queue[stepIndex] ?? "wait";

  if (!hasPendingStun(state.stun)) {
    return {
      queuedMove,
      move: queuedMove,
      wasStunned: false,
    };
  }

  return {
    queuedMove,
    move: "wait",
    wasStunned: true,
  };
}

function stunAfterStepStart(stunSteps: number): number {
  return hasPendingStun(stunSteps)
    ? clearStunAfterSkippedStep(stunSteps)
    : stunSteps;
}

function hasPendingStun(stunSteps: number): boolean {
  return stunSteps > 0;
}

function clearStunAfterSkippedStep(stunSteps: number): number {
  return Math.max(0, stunSteps - 1);
}

function stunForNextStep(): number {
  return NEXT_STEP_STUN;
}

function getCollisionWinner(
  priorityOwner: RobotId,
  playerWasStunned: boolean,
  rivalWasStunned: boolean,
): RobotId {
  if (playerWasStunned && !rivalWasStunned) {
    return "rival";
  }

  if (rivalWasStunned && !playerWasStunned) {
    return "player";
  }

  return priorityOwner;
}

function getCollisionType(
  playerState: ExecutionRobotState,
  rivalState: ExecutionRobotState,
  playerTarget: TilePosition,
  rivalTarget: TilePosition,
): "same-target" | "swap" | null {
  if (sameTile(playerTarget, rivalTarget)) {
    return "same-target";
  }

  if (
    sameTile(playerTarget, rivalState.tile) &&
    sameTile(rivalTarget, playerState.tile)
  ) {
    return "swap";
  }

  return null;
}

function otherRobot(robot: RobotId): RobotId {
  return robot === "player" ? "rival" : "player";
}

function validDestination(
  board: BoardState,
  from: TilePosition,
  move: Move,
): TilePosition {
  const target = moveTile(from, move);
  return canEnterTile(board, target) ? target : copyTile(from);
}

function collectPickups(
  pickups: Pickup[],
  player: RobotState,
  rival: RobotState,
): {
  remainingPickups: Pickup[];
  collectedPickupIds: string[];
  playerScoreDelta: number;
  rivalScoreDelta: number;
} {
  const collectedPickupIds: string[] = [];
  let playerScoreDelta = 0;
  let rivalScoreDelta = 0;
  const remainingPickups = pickups.filter((pickup) => {
    if (sameTile(player.tile, pickup.tile)) {
      playerScoreDelta += pickup.value;
      collectedPickupIds.push(pickup.id);
      return false;
    }

    if (sameTile(rival.tile, pickup.tile)) {
      rivalScoreDelta += pickup.value;
      collectedPickupIds.push(pickup.id);
      return false;
    }

    return true;
  });

  return {
    remainingPickups,
    collectedPickupIds,
    playerScoreDelta,
    rivalScoreDelta,
  };
}

function collectPickupForRobot(
  pickups: Pickup[],
  robot: RobotState,
): {
  remainingPickups: Pickup[];
  collectedPickupIds: string[];
  scoreDelta: number;
} {
  const collectedPickupIds: string[] = [];
  let scoreDelta = 0;
  const remainingPickups = pickups.filter((pickup) => {
    if (!sameTile(robot.tile, pickup.tile)) {
      return true;
    }

    scoreDelta += pickup.value;
    collectedPickupIds.push(pickup.id);
    return false;
  });

  return {
    remainingPickups,
    collectedPickupIds,
    scoreDelta,
  };
}

function copyRobot(robot: RobotState): RobotState {
  return {
    ...robot,
    tile: copyTile(robot.tile),
  };
}

function copyPickup(pickup: Pickup): Pickup {
  return {
    ...pickup,
    tile: copyTile(pickup.tile),
  };
}

function createExecutionRobotState(
  robot: RobotState,
  board: BoardState,
  pickups: Pickup[],
  queue: Move[],
  stun: number,
  score = 0,
): ExecutionRobotState {
  return {
    ...copyRobot(robot),
    board: copyBoard(board),
    pickups: pickups.map(copyPickup),
    queue: [...queue],
    score,
    stun,
  };
}

function copyExecutionRobotState(
  state: ExecutionRobotState,
): ExecutionRobotState {
  return {
    ...copyRobot(state),
    board: copyBoard(state.board),
    pickups: state.pickups.map(copyPickup),
    queue: [...state.queue],
    score: state.score,
    stun: state.stun,
  };
}

function executionStateToRobot(state: ExecutionRobotState): RobotState {
  return {
    id: state.id,
    tile: copyTile(state.tile),
  };
}

function copyBoard(board: BoardState): BoardState {
  return {
    ...board,
    blockers: board.blockers.map(copyTile),
  };
}

function copyRound(round: RoundState): RoundState {
  return {
    ...round,
    board: copyBoard(round.board),
    pickups: round.pickups.map(copyPickup),
    player: copyRobot(round.player),
    rival: copyRobot(round.rival),
    playerQueue: [...round.playerQueue],
    rivalQueue: [...round.rivalQueue],
    stun: { ...round.stun },
  };
}
