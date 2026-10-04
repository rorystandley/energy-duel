import { describe, expect, it } from "vitest";

import { findDebugReplay } from "./debug-match";
import { verifyReplay } from "./replay";

describe("debug match replays", () => {
  it.each(["player", "rival", "draw"] as const)(
    "finds a verifiable standard match that ends in %s",
    (winner) => {
      const replay = findDebugReplay("standard", winner);

      expect(replay?.result?.winner).toBe(winner);
      expect(replay?.rounds).toHaveLength(5);
      expect(replay && verifyReplay(replay).ok).toBe(true);
    },
  );

  it("also covers the guided duel", () => {
    expect(findDebugReplay("guided", "draw")?.rounds).toHaveLength(2);
  });
});
