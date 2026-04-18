import { PICKUPS_PER_ROUND, PICKUP_VALUES } from "./constants";
import { copyTile, listOpenTiles } from "./board";
import type { BoardState, Pickup, PickupValue, TilePosition } from "./types";

export function createRoundPickups(
  board: BoardState,
  occupiedTiles: TilePosition[],
  existingPickups: Pickup[] = [],
  round = 1,
): Pickup[] {
  const carriedPickups = existingPickups.map(copyPickup);

  if (carriedPickups.length > PICKUPS_PER_ROUND) {
    throw new Error(`Expected at most ${PICKUPS_PER_ROUND} carried pickups.`);
  }

  const missingValues = getMissingPickupValues(carriedPickups);
  const selectedTiles = takeRandomTiles(
    listOpenTiles(board, [
      ...occupiedTiles,
      ...carriedPickups.map((pickup) => pickup.tile),
    ]),
    missingValues.length,
  );
  const replacementPickups = selectedTiles.map((tile, index) => ({
    id: `pickup-r${round}-${index + 1}`,
    tile,
    value: missingValues[index],
  }));
  const pickups = [...carriedPickups, ...replacementPickups];

  if (pickups.length !== PICKUPS_PER_ROUND) {
    throw new Error(`Expected ${PICKUPS_PER_ROUND} pickups after replacement.`);
  }

  return pickups;
}

function getMissingPickupValues(existingPickups: Pickup[]): PickupValue[] {
  const remainingValues = existingPickups.map((pickup) => pickup.value);
  const missingValues: PickupValue[] = [];

  for (const pickupValue of PICKUP_VALUES) {
    const existingIndex = remainingValues.indexOf(pickupValue);

    if (existingIndex === -1) {
      missingValues.push(pickupValue);
      continue;
    }

    remainingValues.splice(existingIndex, 1);
  }

  return missingValues;
}

function copyPickup(pickup: Pickup): Pickup {
  return {
    ...pickup,
    tile: copyTile(pickup.tile),
  };
}

function takeRandomTiles(tiles: TilePosition[], count: number): TilePosition[] {
  if (tiles.length < count) {
    throw new Error(`Unable to place ${count} pickups on valid empty tiles.`);
  }

  const shuffled = tiles.map(copyTile);

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const current = shuffled[index];
    shuffled[index] = shuffled[swapIndex];
    shuffled[swapIndex] = current;
  }

  return shuffled.slice(0, count);
}
