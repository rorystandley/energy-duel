import { canEnterTile, copyTile, moveTile, sameTile } from "./board";
import type {
  BoardState,
  Move,
  Pickup,
  RoundState,
  TilePosition,
} from "./types";

export interface PreviewPickupClaim {
  pickup: Pickup;
  step: number;
}

export interface MovePreview {
  playerPath: TilePosition[];
  committedSteps: number;
  pickupClaims: PreviewPickupClaim[];
}

export function createMovePreview(round: RoundState): MovePreview | undefined {
  const committedSteps = Math.min(round.playerQueue.length, round.maxSteps);

  if (committedSteps === 0) {
    return undefined;
  }

  const playerPath = [copyTile(round.player.tile)];
  const pickupClaims: PreviewPickupClaim[] = [];
  const claimedPickupIds = new Set<string>();
  let currentTile = copyTile(round.player.tile);
  let stun = round.stun.player;

  for (let index = 0; index < committedSteps; index += 1) {
    const move = stun > 0 ? "wait" : round.playerQueue[index] ?? "wait";

    currentTile = validDestination(round.board, currentTile, move);
    stun = Math.max(0, stun - 1);
    playerPath.push(copyTile(currentTile));

    const pickup = round.pickups.find(
      (candidate) =>
        !claimedPickupIds.has(candidate.id) &&
        sameTile(candidate.tile, currentTile),
    );

    if (pickup) {
      claimedPickupIds.add(pickup.id);
      pickupClaims.push({
        pickup: copyPickup(pickup),
        step: index + 1,
      });
    }
  }

  return {
    playerPath,
    committedSteps,
    pickupClaims,
  };
}

function validDestination(
  board: BoardState,
  from: TilePosition,
  move: Move,
): TilePosition {
  const target = moveTile(from, move);
  return canEnterTile(board, target) ? target : copyTile(from);
}

function copyPickup(pickup: Pickup): Pickup {
  return {
    ...pickup,
    tile: copyTile(pickup.tile),
  };
}
