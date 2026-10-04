import { describe, expect, it } from "vitest";

import { getModeRules, getMovesForRound } from "./match-rules";

describe("match mode rules", () => {
  it("keeps Standard at five rounds of eight steps", () => {
    expect(getModeRules("standard").totalRounds).toBe(5);
    for (let round = 1; round <= 5; round += 1) {
      expect(getMovesForRound("standard", round)).toBe(8);
    }
  });

  it("gives the guided intro two rounds: four steps, then eight", () => {
    expect(getModeRules("guided").totalRounds).toBe(2);
    expect(getMovesForRound("guided", 1)).toBe(4);
    expect(getMovesForRound("guided", 2)).toBe(8);
  });
});
