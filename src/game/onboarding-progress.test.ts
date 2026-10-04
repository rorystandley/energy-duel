import { describe, expect, it } from "vitest";

import {
  readGuideOutcome,
  recordGuideOutcome,
  type ProgressStorage,
} from "./onboarding-progress";

function memoryStorage(): ProgressStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

const brokenStorage: ProgressStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

describe("guided intro progress", () => {
  it("starts with no recorded outcome", () => {
    expect(readGuideOutcome(memoryStorage())).toBeNull();
  });

  it("records completion and skipping", () => {
    const storage = memoryStorage();
    recordGuideOutcome(storage, "skipped");
    expect(readGuideOutcome(storage)).toBe("skipped");
    recordGuideOutcome(storage, "completed");
    expect(readGuideOutcome(storage)).toBe("completed");
  });

  it("never downgrades completed to skipped", () => {
    const storage = memoryStorage();
    recordGuideOutcome(storage, "completed");
    recordGuideOutcome(storage, "skipped");
    expect(readGuideOutcome(storage)).toBe("completed");
  });

  it("does not depend on storage or Wavedash being available", () => {
    expect(() => recordGuideOutcome(brokenStorage, "completed")).not.toThrow();
    expect(readGuideOutcome(brokenStorage)).toBeNull();
    expect(() => recordGuideOutcome(undefined, "completed")).not.toThrow();
    expect(readGuideOutcome(undefined)).toBeNull();
  });
});
