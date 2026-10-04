import { describe, expect, it } from "vitest";

import { createMovePreview } from "./preview";
import type { BoardState, RoundState, TilePosition } from "./types";

const OPEN_BOARD: BoardState = {
  size: 8,
  blockers: [],
};

describe("move preview", () => {
  it("exposes only the player's queued path", () => {
    const round: RoundState = {
      round: 1,
      seed: 0,
      priorityOwner: "player",
      board: OPEN_BOARD,
      pickups: [],
      player: { id: "player", tile: tile(2, 2) },
      rival: { id: "rival", tile: tile(2, 4) },
      playerQueue: ["right", "right"],
      rivalQueue: ["left", "left"],
      rivalMood: "aggressive",
      maxSteps: 8,
      currentExecutionStep: 0,
      stun: { player: 0, rival: 0 },
    };

    const preview = createMovePreview(round);

    expect(preview).toEqual({
      playerPath: [tile(2, 2), tile(2, 3), tile(2, 4)],
      committedSteps: 2,
      pickupClaims: [],
    });
    expect(preview).not.toHaveProperty("rivalPath");
    expect(preview).not.toHaveProperty("rivalQueue");
    expect(preview).not.toHaveProperty("rivalMood");
    expect(preview).not.toHaveProperty("collisions");
  });

  it("never previews beyond the round's step count", () => {
    const round: RoundState = {
      round: 1,
      seed: 0,
      priorityOwner: "player",
      board: OPEN_BOARD,
      pickups: [],
      player: { id: "player", tile: tile(2, 0) },
      rival: { id: "rival", tile: tile(7, 7) },
      playerQueue: ["right", "right", "right", "right", "right", "right"],
      rivalQueue: [],
      rivalMood: null,
      maxSteps: 4,
      currentExecutionStep: 0,
      stun: { player: 0, rival: 0 },
    };

    const preview = createMovePreview(round);

    expect(preview?.committedSteps).toBe(4);
    expect(preview?.playerPath).toHaveLength(5);
  });
});

function tile(row: number, col: number): TilePosition {
  return { row, col };
}
