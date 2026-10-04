import { MOVES } from "./constants";
import {
  applyStepScore,
  createInitialMatch,
  createNextRoundState,
  createRoundState,
  finishRound,
  lockRoundQueues,
  startNextRound,
} from "./match-flow";
import { RULES_VERSION, SUPPORTED_RULES_VERSIONS } from "./match-rules";
import { resolveRound } from "./round-resolution";
import type {
  BoardState,
  MatchMode,
  MatchState,
  MatchWinner,
  Move,
  Pickup,
  RivalMood,
  RobotId,
  RoundPriorityOwner,
  RoundState,
  StepResult,
  TilePosition,
} from "./types";

export const REPLAY_FORMAT = "energy-duel.replay";
/** Shape of the serialized record. Independent of RULES_VERSION. */
export const REPLAY_FORMAT_VERSION = 1;

export interface ReplayRound {
  round: number;
  priorityOwner: RoundPriorityOwner;
  maxSteps: number;
  /** Board, pickups and robot tiles as they stood when queuing began. */
  board: BoardState;
  pickups: Pickup[];
  playerStart: TilePosition;
  rivalStart: TilePosition;
  /** Both queues exactly as committed at lock time. */
  playerQueue: Move[];
  rivalQueue: Move[];
  rivalMood: RivalMood | null;
  steps: StepResult[];
}

export interface ReplayResult {
  playerScore: number;
  rivalScore: number;
  winner: MatchWinner;
}

export interface ReplayRecord {
  format: typeof REPLAY_FORMAT;
  formatVersion: number;
  rulesVersion: number;
  seed: number;
  mode: MatchMode;
  rounds: ReplayRound[];
  /** Present once the match has finished; absent for an in-progress record. */
  result?: ReplayResult;
}

export type ReplayParseFailure =
  | "malformed"
  | "unsupported-format-version"
  | "unsupported-rules-version";

export type ReplayParseResult =
  | { ok: true; replay: ReplayRecord }
  | { ok: false; reason: ReplayParseFailure; message: string };

export function createReplay(match: MatchState): ReplayRecord {
  return {
    format: REPLAY_FORMAT,
    formatVersion: REPLAY_FORMAT_VERSION,
    rulesVersion: match.rulesVersion,
    seed: match.seed,
    mode: match.mode,
    rounds: [],
  };
}

/** Appends a finished round. `lockedRound` is the round as it was when locked, before any step ran. */
export function recordReplayRound(
  replay: ReplayRecord,
  lockedRound: RoundState,
  steps: StepResult[],
): ReplayRecord {
  const entry: ReplayRound = clone({
    round: lockedRound.round,
    priorityOwner: lockedRound.priorityOwner,
    maxSteps: lockedRound.maxSteps,
    board: lockedRound.board,
    pickups: lockedRound.pickups,
    playerStart: lockedRound.player.tile,
    rivalStart: lockedRound.rival.tile,
    playerQueue: lockedRound.playerQueue,
    rivalQueue: lockedRound.rivalQueue,
    rivalMood: lockedRound.rivalMood,
    steps,
  });

  return { ...replay, rounds: [...replay.rounds, entry] };
}

export function finalizeReplay(replay: ReplayRecord, match: MatchState): ReplayRecord {
  return {
    ...replay,
    result: {
      playerScore: match.playerScore,
      rivalScore: match.rivalScore,
      winner: match.winner,
    },
  };
}

export function serializeReplay(replay: ReplayRecord): string {
  return JSON.stringify(replay);
}

export function parseReplay(json: string): ReplayParseResult {
  let data: unknown;

  try {
    data = JSON.parse(json);
  } catch {
    return malformed("Replay is not valid JSON.");
  }

  if (!isRecord(data) || data.format !== REPLAY_FORMAT) {
    return malformed("Not an Energy Duel replay.");
  }

  if (data.formatVersion !== REPLAY_FORMAT_VERSION) {
    return {
      ok: false,
      reason: "unsupported-format-version",
      message: `Replay format v${String(data.formatVersion)} is not supported (this build reads v${REPLAY_FORMAT_VERSION}).`,
    };
  }

  if (
    typeof data.rulesVersion !== "number" ||
    !SUPPORTED_RULES_VERSIONS.includes(data.rulesVersion)
  ) {
    return {
      ok: false,
      reason: "unsupported-rules-version",
      message: `Replay was recorded under rules v${String(data.rulesVersion)}; this build plays rules v${RULES_VERSION} and cannot reproduce it.`,
    };
  }

  if (!isValidShape(data)) {
    return malformed("Replay data is incomplete or corrupt.");
  }

  return { ok: true, replay: data };
}

export interface ReplayVerification {
  ok: boolean;
  /** Where the re-simulation first diverged from the record. */
  mismatch?: string;
}

/** Re-simulates the record from seed, rules version and both queues, and compares everything. */
export function verifyReplay(replay: ReplayRecord): ReplayVerification {
  if (!SUPPORTED_RULES_VERSIONS.includes(replay.rulesVersion)) {
    return { ok: false, mismatch: `unsupported rules version ${replay.rulesVersion}` };
  }

  const reproduced = simulateMatch({
    seed: replay.seed,
    mode: replay.mode,
    playerQueues: replay.rounds.map((round) => round.playerQueue),
  });

  if (reproduced.rounds.length !== replay.rounds.length) {
    return { ok: false, mismatch: "round count" };
  }

  for (let index = 0; index < replay.rounds.length; index += 1) {
    if (!same(reproduced.rounds[index], replay.rounds[index])) {
      return { ok: false, mismatch: `round ${replay.rounds[index].round}` };
    }
  }

  if (replay.result && !same(reproduced.result, replay.result)) {
    return { ok: false, mismatch: "result" };
  }

  return { ok: true };
}

export interface SimulateMatchOptions {
  seed: number;
  mode?: MatchMode;
  /** One committed queue per round, in order; may stop short of the full match. */
  playerQueues: Move[][];
}

/**
 * Plays a match headlessly with the same code path the game uses. The result
 * is a replay record, so recording and verification cannot drift apart.
 */
export function simulateMatch(options: SimulateMatchOptions): ReplayRecord {
  let match = createInitialMatch(options.mode ?? "standard", { seed: options.seed });
  let replay = createReplay(match);
  let round = createRoundState(1, { mode: match.mode, seed: match.seed });

  for (const queue of options.playerQueues) {
    const locked = lockRoundQueues({ ...round, playerQueue: queue.slice() });
    const resolution = resolveRound(locked);

    match = applyStepScore(
      match,
      resolution.playerScoreDelta,
      resolution.rivalScoreDelta,
    );
    replay = recordReplayRound(replay, locked, resolution.steps);
    match = finishRound(match);

    if (match.status === "match-complete") {
      return finalizeReplay(replay, match);
    }

    match = startNextRound(match);
    round = createNextRoundState(match, resolution.finalRound);
  }

  return replay;
}

function malformed(message: string): ReplayParseResult {
  return { ok: false, reason: "malformed", message };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTile(value: unknown): boolean {
  return (
    isRecord(value) && Number.isInteger(value.row) && Number.isInteger(value.col)
  );
}

function isMoveList(value: unknown, length: number): boolean {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((move) => MOVES.includes(move as Move))
  );
}

function isValidShape(data: Record<string, unknown>): data is Record<string, unknown> & ReplayRecord {
  if (
    !Number.isInteger(data.seed) ||
    (data.mode !== "standard" && data.mode !== "guided") ||
    !Array.isArray(data.rounds)
  ) {
    return false;
  }

  const robots: RobotId[] = ["player", "rival"];

  return data.rounds.every((round: unknown) => {
    if (!isRecord(round) || !Number.isInteger(round.maxSteps)) {
      return false;
    }

    const maxSteps = round.maxSteps as number;

    return (
      Number.isInteger(round.round) &&
      robots.includes(round.priorityOwner as RobotId) &&
      isRecord(round.board) &&
      Array.isArray(round.board.blockers) &&
      round.board.blockers.every(isTile) &&
      Array.isArray(round.pickups) &&
      isTile(round.playerStart) &&
      isTile(round.rivalStart) &&
      isMoveList(round.playerQueue, maxSteps) &&
      isMoveList(round.rivalQueue, maxSteps) &&
      Array.isArray(round.steps) &&
      round.steps.length === maxSteps
    );
  });
}
