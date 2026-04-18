export type Move = "up" | "down" | "left" | "right" | "wait";

export type RobotId = "player" | "rival";

export type RoundPriorityOwner = RobotId;

export type RivalMood = "aggressive" | "greedy" | "safe";

export type PickupValue = 1 | 3;

export type MatchStatus =
  | "queuing"
  | "executing"
  | "round-complete"
  | "match-complete";

export type MatchWinner = RobotId | "draw" | null;

export interface TilePosition {
  row: number;
  col: number;
}

export interface PixelPosition {
  x: number;
  y: number;
}

export interface BoardState {
  size: number;
  blockers: TilePosition[];
}

export interface Pickup {
  id: string;
  tile: TilePosition;
  value: PickupValue;
}

export interface RobotState {
  id: RobotId;
  tile: TilePosition;
}

export interface ExecutionRobotState extends RobotState {
  board: BoardState;
  pickups: Pickup[];
  queue: Move[];
  score: number;
  stun: number;
}

export type StunState = Record<RobotId, number>;

export interface MatchState {
  currentRound: number;
  totalRounds: number;
  playerScore: number;
  rivalScore: number;
  status: MatchStatus;
  winner: MatchWinner;
  stats: MatchStats;
}

export interface MatchStats {
  playerPickupsCollected: number;
  rivalPickupsCollected: number;
  playerThreePointPickupsCollected: number;
  rivalThreePointPickupsCollected: number;
  playerCollisionsWon: number;
  rivalCollisionsWon: number;
}

export interface RoundState {
  round: number;
  priorityOwner: RoundPriorityOwner;
  board: BoardState;
  pickups: Pickup[];
  player: RobotState;
  rival: RobotState;
  playerQueue: Move[];
  rivalQueue: Move[];
  rivalMood: RivalMood | null;
  currentExecutionStep: number;
  stun: StunState;
}

export interface StepResult {
  step: number;
  playerQueuedMove: Move;
  rivalQueuedMove: Move;
  playerMove: Move;
  rivalMove: Move;
  playerWasStunned: boolean;
  rivalWasStunned: boolean;
  playerTile: TilePosition;
  rivalTile: TilePosition;
  collision: boolean;
  collisionWinner: RobotId | null;
  collisionLoser: RobotId | null;
  collectedPickupIds: string[];
  playerScoreDelta: number;
  rivalScoreDelta: number;
  stun: StunState;
}

export interface RoundResolution {
  finalRound: RoundState;
  playerScoreDelta: number;
  rivalScoreDelta: number;
  steps: StepResult[];
}

export interface StepResolution {
  round: RoundState;
  step: StepResult;
}

export interface StepExecutionResolution {
  playerState: ExecutionRobotState;
  rivalState: ExecutionRobotState;
  pickups: Pickup[];
  step: StepResult;
}
