import { describe, expect, it } from "vitest";

import { getGuideCoach, type GuideCoachInput } from "./guide-coach";

function input(overrides: Partial<GuideCoachInput> = {}): GuideCoachInput {
  return {
    mode: "guided",
    round: 1,
    status: "queuing",
    queueLength: 0,
    maxSteps: 4,
    priorityOwner: "player",
    lastCollisionWinner: null,
    ...overrides,
  };
}

describe("guided coach", () => {
  it("is silent outside the guided intro", () => {
    expect(getGuideCoach(input({ mode: "standard" }))).toBeNull();
  });

  it("teaches node values before the first move", () => {
    const coach = getGuideCoach(input());
    expect(coach?.topic).toBe("values");
    expect(coach?.text).toMatch(/3/);
  });

  it("teaches the path preview once a move is queued", () => {
    expect(getGuideCoach(input({ queueLength: 1 }))?.topic).toBe("preview");
  });

  it("prompts to execute when the queue is full", () => {
    expect(getGuideCoach(input({ queueLength: 4 }))?.topic).toBe("ready");
  });

  it("teaches collision priority when round two begins, naming the owner", () => {
    const coach = getGuideCoach(
      input({ round: 2, maxSteps: 8, priorityOwner: "rival" }),
    );
    expect(coach?.topic).toBe("priority");
    expect(coach?.text).toMatch(/enemy/i);
  });

  it("explains a clash at the moment it happens", () => {
    const coach = getGuideCoach(
      input({ status: "executing", lastCollisionWinner: "rival" }),
    );
    expect(coach?.topic).toBe("clash");
    expect(coach?.text).toMatch(/stunned/i);
  });

  it("is quiet during execution without a clash", () => {
    expect(getGuideCoach(input({ status: "executing" }))).toBeNull();
  });
});
