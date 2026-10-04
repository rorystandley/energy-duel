import { PICKUPS_PER_ROUND, PICKUP_VALUES } from "./constants";
import { copyTile, listOpenTiles } from "./board";
import { shuffle, type RandomSource } from "./random";
import type { BoardState, Pickup, PickupValue, TilePosition } from "./types";

export function createRoundPickups(
  board: BoardState,
  occupiedTiles: TilePosition[],
  existingPickups: Pickup[] = [],
  round = 1,
  random: RandomSource,
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
    random,
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

function takeRandomTiles(
  tiles: TilePosition[],
  count: number,
  random: RandomSource,
): TilePosition[] {
  if (tiles.length < count) {
    throw new Error(`Unable to place ${count} pickups on valid empty tiles.`);
  }

  return shuffle(tiles, random).slice(0, count).map(copyTile);
}
