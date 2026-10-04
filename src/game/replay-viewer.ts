import { deriveSeed } from "./random";
import { getPickupCollector } from "./match-story";
import type { ReplayRecord, ReplayRound } from "./replay";
import type { Move, RoundState, StepResult, TilePosition } from "./types";

/**
 * Read-only playback of a recorded round. Everything here is derived from the
 * record and returns fresh copies, so viewing a replay can never touch the
 * live match, round or record.
 */
export interface ReplayViewState {
  /** Index into `replay.rounds`. */
  roundIndex: number;
  /** 0 = the starting position, k = after k resolved steps. */
  step: number;
  /** Rounds the viewer may move between, inclusive. */
  firstRound: number;
  lastRound: number;
}

export interface ReplayFrame {
  /** Board-shaped state for the renderer: tiles, pickups still unclaimed and stun after `step` steps. */
  round: RoundState;
  roundNumber: number;
  step: number;
  stepCount: number;
  /** Match score at this point, including earlier rounds. */
  playerScore: number;
  rivalScore: number;
  lastStep: StepResult | null;
  /** Tiles each robot has occupied from the start up to this step. */
  trails: { player: TilePosition[]; rival: TilePosition[] };
  narration: string[];
}

/** Opens at `roundIndex` (default: the last recorded round). Pass `onlyThisRound` to stop navigation leaving it. */
export function openReplayViewer(
  replay: ReplayRecord,
  options: { roundIndex?: number; onlyThisRound?: boolean } = {},
): ReplayViewState | null {
  if (replay.rounds.length === 0) {
    return null;
  }

  const last = replay.rounds.length - 1;
  const roundIndex = clamp(options.roundIndex ?? last, 0, last);

  return {
    roundIndex,
    step: 0,
    firstRound: options.onlyThisRound ? roundIndex : 0,
    lastRound: options.onlyThisRound ? roundIndex : last,
  };
}

export function stepReplayViewer(
  replay: ReplayRecord,
  view: ReplayViewState,
  delta: number,
): ReplayViewState {
  const stepCount = replay.rounds[view.roundIndex]?.steps.length ?? 0;

  return { ...view, step: clamp(view.step + delta, 0, stepCount) };
}

export function shiftReplayRound(
  view: ReplayViewState,
  delta: number,
): ReplayViewState {
  const roundIndex = clamp(view.roundIndex + delta, view.firstRound, view.lastRound);

  return roundIndex === view.roundIndex ? view : { ...view, roundIndex, step: 0 };
}

export function restartReplayRound(view: ReplayViewState): ReplayViewState {
  return { ...view, step: 0 };
}

export function buildReplayFrame(
  replay: ReplayRecord,
  view: ReplayViewState,
): ReplayFrame {
  const recorded = replay.rounds[view.roundIndex];
  const stepCount = recorded.steps.length;
  const step = clamp(view.step, 0, stepCount);
  const played = recorded.steps.slice(0, step);
  const lastStep = played.length > 0 ? played[played.length - 1] : null;
  const claimed = new Set(played.flatMap((result) => result.collectedPickupIds));
  let playerScore = 0;
  let rivalScore = 0;

  for (const earlier of replay.rounds.slice(0, view.roundIndex)) {
    for (const result of earlier.steps) {
      playerScore += result.playerScoreDelta;
      rivalScore += result.rivalScoreDelta;
    }
  }

  for (const result of played) {
    playerScore += result.playerScoreDelta;
    rivalScore += result.rivalScoreDelta;
  }

  const playerTile = lastStep ? lastStep.playerTile : recorded.playerStart;
  const rivalTile = lastStep ? lastStep.rivalTile : recorded.rivalStart;

  const round: RoundState = clone({
    round: recorded.round,
    seed: deriveSeed(replay.seed, "rival", recorded.round),
    priorityOwner: recorded.priorityOwner,
    board: recorded.board,
    pickups: recorded.pickups.filter((pickup) => !claimed.has(pickup.id)),
    player: { id: "player", tile: playerTile },
    rival: { id: "rival", tile: rivalTile },
    playerQueue: recorded.playerQueue,
    rivalQueue: recorded.rivalQueue,
    rivalMood: recorded.rivalMood,
    maxSteps: recorded.maxSteps,
    currentExecutionStep: step,
    stun: lastStep ? lastStep.stun : { player: 0, rival: 0 },
  });

  return {
    round,
    roundNumber: recorded.round,
    step,
    stepCount,
    playerScore,
    rivalScore,
    lastStep: lastStep ? clone(lastStep) : null,
    trails: {
      player: clone([recorded.playerStart, ...played.map((r) => r.playerTile)]),
      rival: clone([recorded.rivalStart, ...played.map((r) => r.rivalTile)]),
    },
    narration: describeStep(recorded, step),
  };
}

function describeStep(round: ReplayRound, step: number): string[] {
  if (step === 0) {
    return [
      `Round ${round.round} start.`,
      `Priority: ${round.priorityOwner === "player" ? "you" : "enemy"}.`,
      "Step forward to watch it play out.",
    ];
  }

  const result = round.steps[step - 1];
  const lines = [
    `You: ${describeMove(result.playerMove, result.playerWasStunned, result.playerQueuedMove)}`,
    `Enemy: ${describeMove(result.rivalMove, result.rivalWasStunned, result.rivalQueuedMove)}`,
  ];

  if (result.collision && result.collisionWinner) {
    lines.push(
      result.collisionWinner === "player"
        ? "Clash: you won it and stunned the enemy."
        : "Clash: the enemy won it and stunned you.",
    );
  }

  for (const id of result.collectedPickupIds) {
    const pickup = round.pickups.find((candidate) => candidate.id === id);
    const collector = pickup ? getPickupCollector(result, pickup) : null;

    if (pickup && collector) {
      lines.push(
        `${collector === "player" ? "You" : "Enemy"} claimed a ${pickup.value}-point node.`,
      );
    }
  }

  return lines;
}

function describeMove(move: Move, stunned: boolean, queued: Move): string {
  return stunned
    ? `stunned, lost ${queued.toUpperCase()}`
    : move.toUpperCase();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
