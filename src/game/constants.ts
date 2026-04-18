import type { Move, TilePosition } from "./types";

export const GAME_TITLE = "Energy Duel";
export const GAME_WIDTH = 960;
export const GAME_HEIGHT = 720;

export const BOARD_SIZE = 8;
export const CELL_SIZE = 64;
export const BOARD_ORIGIN = { x: 224, y: 96 } as const;

export const TOTAL_ROUNDS = 5;
export const MOVES_PER_ROUND = 8;
export const PICKUPS_PER_ROUND = 4;

export const LOW_PICKUP_VALUE = 1;
export const HIGH_PICKUP_VALUE = 3;
export const PICKUP_VALUES = [1, 1, 3, 3] as const;

export const MOVES: Move[] = ["up", "down", "left", "right", "wait"];

export const START_TILES: Record<"player" | "rival", TilePosition> = {
  player: { row: 7, col: 0 },
  rival: { row: 0, col: 7 },
};

export const BASE_BLOCKERS: TilePosition[] = [
  { row: 2, col: 2 },
  { row: 2, col: 5 },
  { row: 3, col: 4 },
  { row: 4, col: 3 },
  { row: 5, col: 2 },
  { row: 5, col: 5 },
];
