import {
  BASE_BLOCKERS,
  BOARD_ORIGIN,
  BOARD_SIZE,
  CELL_SIZE,
} from "./constants";
import { shuffle, type RandomSource } from "./random";
import type { BoardState, Move, PixelPosition, TilePosition } from "./types";

export function createInitialBoard(): BoardState {
  return {
    size: BOARD_SIZE,
    blockers: BASE_BLOCKERS.map(copyTile),
  };
}

export function copyBoard(board: BoardState): BoardState {
  return {
    ...board,
    blockers: board.blockers.map(copyTile),
  };
}

export function addBlockersForRound(
  board: BoardState,
  round: number,
  reservedTiles: TilePosition[] = [],
  random: RandomSource,
): BoardState {
  const nextBoard = copyBoard(board);
  const blockersToAdd = getBlockersToAddForRound(round, nextBoard.blockers.length);

  if (blockersToAdd === 0) {
    return nextBoard;
  }

  const candidates = shuffle(listOpenTiles(nextBoard, reservedTiles), random);

  if (candidates.length < blockersToAdd) {
    throw new Error(`Unable to add ${blockersToAdd} blockers for round ${round}.`);
  }

  for (let index = 0; index < blockersToAdd; index += 1) {
    nextBoard.blockers.push(copyTile(candidates[index]));
  }

  return nextBoard;
}

function getBlockersToAddForRound(round: number, currentBlockerCount: number): number {
  if (!shouldAddBlockerForRound(round)) {
    return 0;
  }

  return currentBlockerCount < getExpectedBlockerCount(round) ? 1 : 0;
}

function shouldAddBlockerForRound(round: number): boolean {
  return round > 1;
}

function getExpectedBlockerCount(round: number): number {
  return BASE_BLOCKERS.length + round - 1;
}

export function copyTile(tile: TilePosition): TilePosition {
  return { row: tile.row, col: tile.col };
}

export function tileKey(tile: TilePosition): string {
  return `${tile.row}:${tile.col}`;
}

export function sameTile(a: TilePosition, b: TilePosition): boolean {
  return a.row === b.row && a.col === b.col;
}

export function manhattanDistance(a: TilePosition, b: TilePosition): number {
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
}

export function isInsideBoard(board: BoardState, tile: TilePosition): boolean {
  return (
    tile.row >= 0 &&
    tile.row < board.size &&
    tile.col >= 0 &&
    tile.col < board.size
  );
}

export function hasBlocker(board: BoardState, tile: TilePosition): boolean {
  return board.blockers.some((blocker) => sameTile(blocker, tile));
}

export function canEnterTile(board: BoardState, tile: TilePosition): boolean {
  return isInsideBoard(board, tile) && !hasBlocker(board, tile);
}

export function moveTile(tile: TilePosition, move: Move): TilePosition {
  switch (move) {
    case "up":
      return { row: tile.row - 1, col: tile.col };
    case "down":
      return { row: tile.row + 1, col: tile.col };
    case "left":
      return { row: tile.row, col: tile.col - 1 };
    case "right":
      return { row: tile.row, col: tile.col + 1 };
    case "wait":
      return copyTile(tile);
  }
}

export function getTileCenter(
  tile: TilePosition,
  origin: PixelPosition = BOARD_ORIGIN,
): PixelPosition {
  return {
    x: origin.x + tile.col * CELL_SIZE + CELL_SIZE / 2,
    y: origin.y + tile.row * CELL_SIZE + CELL_SIZE / 2,
  };
}

export function listOpenTiles(
  board: BoardState,
  reservedTiles: TilePosition[] = [],
): TilePosition[] {
  const reserved = new Set(reservedTiles.map(tileKey));
  const openTiles: TilePosition[] = [];

  for (let row = 0; row < board.size; row += 1) {
    for (let col = 0; col < board.size; col += 1) {
      const tile = { row, col };

      if (canEnterTile(board, tile) && !reserved.has(tileKey(tile))) {
        openTiles.push(tile);
      }
    }
  }

  return openTiles;
}
