import { describe, expect, it } from "vitest";

import { dailySeed } from "./daily";
import {
  SAVE_FORMAT,
  SAVE_VERSION,
  createEmptySave,
  mergeSaves,
  parseSave,
  sameSaveContent,
  serializeSave,
  withDailyBest,
  withStandardBest,
} from "./save";
import type { ResumableMatch, SaveData } from "./save";

const QUEUE = ["up", "up", "right", "right", "wait", "down", "left", "wait"] as const;

function match(overrides: Partial<ResumableMatch> = {}): ResumableMatch {
  return { mode: "standard", seed: 7, rulesVersion: 1, playerQueues: [[...QUEUE]], ...overrides };
}

function save(overrides: Partial<SaveData> = {}): SaveData {
  return { ...createEmptySave(), ...overrides };
}

describe("parseSave", () => {
  it("round-trips a full save", () => {
    const original = save({
      savedAt: 50,
      preferences: { value: { musicVolume: 0.2, sfxVolume: 0.9, muted: true }, updatedAt: 40 },
      progress: { onboardingSeen: true, tutorial: "completed" },
      bests: {
        standard: [{ rulesVersion: 1, playerScore: 9, rivalScore: 4, margin: 5 }],
        daily: [{ date: "2026-10-04", rulesVersion: 1, playerScore: 8, rivalScore: 6, margin: 2 }],
      },
      inProgress: { value: match(), updatedAt: 45 },
    });
    const parsed = parseSave(serializeSave(original));

    expect(parsed).toEqual({ status: "ok", save: original, migratedFrom: null });
  });

  it("treats non-JSON, foreign JSON and a missing version as corrupt", () => {
    expect(parseSave("{nope").status).toBe("corrupt");
    expect(parseSave("[]").status).toBe("corrupt");
    expect(parseSave(JSON.stringify({ format: "other", version: 1 })).status).toBe("corrupt");
    expect(parseSave(JSON.stringify({ format: SAVE_FORMAT })).status).toBe("corrupt");
    expect(parseSave(JSON.stringify({ format: SAVE_FORMAT, version: 0 })).status).toBe("corrupt");
  });

  it("reports a newer schema as unsupported without reading it", () => {
    expect(parseSave(JSON.stringify({ format: SAVE_FORMAT, version: SAVE_VERSION + 1 }))).toEqual({
      status: "unsupported",
      version: SAVE_VERSION + 1,
    });
  });

  it("keeps good sections when one section is bad", () => {
    const parsed = parseSave(
      JSON.stringify({
        ...save({ progress: { onboardingSeen: true, tutorial: "skipped" } }),
        preferences: { value: { musicVolume: 9, sfxVolume: "loud", muted: 1 }, updatedAt: 5 },
        bests: { standard: "nope", daily: [{ date: "2026-13-40" }] },
        inProgress: { value: { mode: "standard", seed: -1 }, updatedAt: 5 },
      }),
    );

    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    expect(parsed.save.progress).toEqual({ onboardingSeen: true, tutorial: "skipped" });
    expect(parsed.save.preferences.value).toBeNull();
    expect(parsed.save.bests).toEqual({ standard: [], daily: [] });
    expect(parsed.save.inProgress.value).toBeNull();
  });

  it("rejects an in-progress match that is not at a plausible boundary", () => {
    const parse = (value: unknown) => {
      const result = parseSave(JSON.stringify({ ...save(), inProgress: { value, updatedAt: 1 } }));
      return result.status === "ok" ? result.save.inProgress.value : "corrupt";
    };

    expect(parse(match())).not.toBeNull();
    expect(parse(match({ playerQueues: [] }))).toBeNull();
    expect(parse(match({ playerQueues: Array(5).fill([...QUEUE]) }))).toBeNull();
    expect(parse(match({ playerQueues: [[...QUEUE].slice(1)] }))).toBeNull();
    expect(parse(match({ playerQueues: [[...QUEUE.slice(1), "teleport" as never]] }))).toBeNull();
    expect(parse({ ...match(), mode: "guided" })).toBeNull();
  });

  it("requires a daily save's seed to belong to its date and rules version", () => {
    const parse = (value: ResumableMatch) => {
      const result = parseSave(JSON.stringify({ ...save(), inProgress: { value, updatedAt: 1 } }));
      return result.status === "ok" ? result.save.inProgress.value : "corrupt";
    };
    const daily = match({ mode: "daily", dailyDate: "2026-10-04", seed: dailySeed("2026-10-04", 1) });

    expect(parse(daily)).toEqual(daily);
    expect(parse({ ...daily, dailyDate: "2026-10-05" })).toBeNull();
    expect(parse({ ...daily, dailyDate: undefined })).toBeNull();
  });
});

describe("migrations", () => {
  const MIGRATIONS = {
    1: (data: Record<string, unknown>) => ({
      ...data,
      // v2 renamed progress.tutorial to progress.guide
      progress: { ...(data.progress as object), tutorial: (data.progress as { guide?: string }).guide },
    }),
  };

  it("runs each step from the file's version up to the current one", () => {
    const old = JSON.stringify({
      format: SAVE_FORMAT,
      version: 1,
      progress: { onboardingSeen: true, guide: "completed" },
    });
    const parsed = parseSave(old, MIGRATIONS, 2);

    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    expect(parsed.migratedFrom).toBe(1);
    expect(parsed.save.progress.tutorial).toBe("completed");
  });

  it("is corrupt, not silently reset, when a step is missing or throws", () => {
    const old = JSON.stringify({ format: SAVE_FORMAT, version: 1 });

    expect(parseSave(old, {}, 2).status).toBe("corrupt");
    expect(
      parseSave(old, { 1: () => { throw new Error("boom"); } }, 2).status,
    ).toBe("corrupt");
  });
});

describe("mergeSaves (the conflict policy)", () => {
  it("takes preferences and the in-progress match from the newer side, whole", () => {
    const local = save({
      preferences: { value: { musicVolume: 0.1, sfxVolume: 0.1, muted: false }, updatedAt: 10 },
      inProgress: { value: match({ seed: 1 }), updatedAt: 10 },
    });
    const cloud = save({
      preferences: { value: { musicVolume: 0.9, sfxVolume: 0.9, muted: true }, updatedAt: 20 },
      inProgress: { value: match({ seed: 2 }), updatedAt: 5 },
    });
    const merged = mergeSaves(local, cloud);

    expect(merged.preferences.value?.musicVolume).toBe(0.9);
    expect(merged.inProgress.value?.seed).toBe(1);
  });

  it("lets a newer cleared match beat an older saved one, so a finished match stays finished", () => {
    const local = save({ inProgress: { value: null, updatedAt: 30 } });
    const cloud = save({ inProgress: { value: match(), updatedAt: 20 } });

    expect(mergeSaves(local, cloud).inProgress.value).toBeNull();
    expect(mergeSaves(cloud, local).inProgress.value).toBeNull();
  });

  it("gives a timestamp tie to the local side", () => {
    const local = save({ inProgress: { value: match({ seed: 1 }), updatedAt: 9 } });
    const cloud = save({ inProgress: { value: match({ seed: 2 }), updatedAt: 9 } });

    expect(mergeSaves(local, cloud).inProgress.value?.seed).toBe(1);
  });

  it("only grows earned progress: tutorial, onboarding and bests", () => {
    const local = save({
      progress: { onboardingSeen: false, tutorial: "skipped" },
      bests: {
        standard: [{ rulesVersion: 1, playerScore: 5, rivalScore: 5, margin: 0 }],
        daily: [{ date: "2026-10-04", rulesVersion: 1, playerScore: 9, rivalScore: 3, margin: 6 }],
      },
    });
    const cloud = save({
      progress: { onboardingSeen: true, tutorial: "completed" },
      bests: {
        standard: [{ rulesVersion: 1, playerScore: 8, rivalScore: 2, margin: 6 }],
        daily: [
          { date: "2026-10-04", rulesVersion: 1, playerScore: 6, rivalScore: 5, margin: 1 },
          { date: "2026-10-03", rulesVersion: 1, playerScore: 4, rivalScore: 2, margin: 2 },
        ],
      },
    });
    const merged = mergeSaves(local, cloud);

    expect(merged.progress).toEqual({ onboardingSeen: true, tutorial: "completed" });
    expect(merged.bests.standard).toEqual([cloud.bests.standard[0]]);
    expect(merged.bests.daily.map((best) => [best.date, best.margin])).toEqual([
      ["2026-10-04", 6],
      ["2026-10-03", 2],
    ]);
  });

  it("is idempotent and order-independent for everything but exact ties", () => {
    const a = save({ progress: { onboardingSeen: true, tutorial: null }, savedAt: 3 });
    const b = save({
      bests: { standard: [{ rulesVersion: 1, playerScore: 7, rivalScore: 1, margin: 6 }], daily: [] },
      savedAt: 8,
    });

    expect(sameSaveContent(mergeSaves(a, b), mergeSaves(b, a))).toBe(true);
    expect(sameSaveContent(mergeSaves(mergeSaves(a, b), b), mergeSaves(a, b))).toBe(true);
    expect(mergeSaves(a, b).savedAt).toBe(8);
  });
});

describe("best helpers", () => {
  it("return the same object when nothing improves", () => {
    const base = withStandardBest(createEmptySave(), { rulesVersion: 1, playerScore: 9, rivalScore: 4 });

    expect(base.bests.standard).toHaveLength(1);
    expect(withStandardBest(base, { rulesVersion: 1, playerScore: 5, rivalScore: 4 })).toBe(base);
    expect(withStandardBest(base, { rulesVersion: 1, playerScore: 12, rivalScore: 4 })).not.toBe(base);
    // A different rules version is its own board of results.
    expect(withStandardBest(base, { rulesVersion: 2, playerScore: 1, rivalScore: 4 }).bests.standard).toHaveLength(2);
  });

  it("tracks daily bests per date and rules version", () => {
    const attempt = { date: "2026-10-04", rulesVersion: 1, playerScore: 9, rivalScore: 4, margin: 5 };
    const base = withDailyBest(createEmptySave(), attempt);

    expect(withDailyBest(base, { ...attempt, playerScore: 5, margin: 1 })).toBe(base);
    expect(withDailyBest(base, { ...attempt, date: "2026-10-05" }).bests.daily).toHaveLength(2);
  });
});
