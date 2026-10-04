import { describe, expect, it, vi } from "vitest";

import type { ProgressCommitResult, ProgressRequest } from "../platform/wavedash";
import { createInitialMatch } from "./match-flow";
import {
  ACHIEVEMENT_IDS,
  MASTERY_STORAGE_KEY,
  MasteryTracker,
  evaluateMatchMastery,
  loadUnlockedAchievements,
} from "./mastery";
import type { MatchMode, MatchState, MatchStats } from "./types";

function finished(
  mode: MatchMode,
  playerScore: number,
  rivalScore: number,
  stats: Partial<MatchStats> = {},
): MatchState {
  const match = createInitialMatch(mode, mode === "daily" ? { dailyDate: "2026-10-04" } : {});
  return {
    ...match,
    status: "match-complete",
    playerScore,
    rivalScore,
    winner: playerScore > rivalScore ? "player" : rivalScore > playerScore ? "rival" : "draw",
    stats: { ...match.stats, ...stats },
  };
}

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  } as Storage;
}

describe("evaluateMatchMastery triggers and non-triggers", () => {
  it("finish: any completed standard match, win or lose", () => {
    expect(evaluateMatchMastery(finished("standard", 3, 9))?.achievements).toEqual([
      ACHIEVEMENT_IDS.finishMatch,
    ]);
  });

  it("finish: an unfinished match and the guided tutorial earn nothing", () => {
    expect(evaluateMatchMastery({ ...finished("standard", 9, 3), status: "round-complete" })).toBeNull();
    expect(evaluateMatchMastery({ ...finished("standard", 9, 3), status: "executing" })).toBeNull();
    expect(evaluateMatchMastery(finished("guided", 9, 3))).toBeNull();
  });

  it("win: only a strictly higher player score", () => {
    expect(evaluateMatchMastery(finished("standard", 9, 3))?.achievements).toContain(
      ACHIEVEMENT_IDS.winMatch,
    );
    expect(evaluateMatchMastery(finished("standard", 5, 5))?.achievements).not.toContain(
      ACHIEVEMENT_IDS.winMatch,
    );
    expect(evaluateMatchMastery(finished("standard", 3, 9))?.achievements).not.toContain(
      ACHIEVEMENT_IDS.winMatch,
    );
  });

  it("three high-value nodes: needs three player three-point pickups, not the rival's or two", () => {
    const has = (stats: Partial<MatchStats>) =>
      evaluateMatchMastery(finished("standard", 1, 1, stats))?.achievements.includes(
        ACHIEVEMENT_IDS.claimThreeHighValueNodes,
      );
    expect(has({ playerThreePointPickupsCollected: 3 })).toBe(true);
    expect(has({ playerThreePointPickupsCollected: 5 })).toBe(true);
    expect(has({ playerThreePointPickupsCollected: 2 })).toBe(false);
    expect(has({ playerPickupsCollected: 9, rivalThreePointPickupsCollected: 4 })).toBe(false);
  });

  it("enemy-priority clash: only clashes won while the rival held priority", () => {
    const has = (stats: Partial<MatchStats>) =>
      evaluateMatchMastery(finished("standard", 1, 1, stats))?.achievements.includes(
        ACHIEVEMENT_IDS.winClashOnEnemyPriority,
      );
    expect(has({ playerClashesWonOnRivalPriority: 1 })).toBe(true);
    expect(has({ playerCollisionsWon: 4, playerClashesWonOnRivalPriority: 0 })).toBe(false);
    expect(has({ rivalCollisionsWon: 3 })).toBe(false);
  });

  it("daily: completing a Daily Duel counts even in defeat; Standard never does", () => {
    const daily = evaluateMatchMastery(finished("daily", 0, 8));
    expect(daily?.achievements).toContain(ACHIEVEMENT_IDS.completeDailyDuel);
    expect(daily?.statIncrements).toEqual({
      MATCHES_COMPLETED: 1,
      MATCHES_WON: 0,
      DAILY_DUELS_COMPLETED: 1,
    });
    expect(evaluateMatchMastery(finished("standard", 8, 0))?.achievements).not.toContain(
      ACHIEVEMENT_IDS.completeDailyDuel,
    );
  });

  it("stat increments: a standard win adds one completed and one won", () => {
    expect(evaluateMatchMastery(finished("standard", 8, 0))?.statIncrements).toEqual({
      MATCHES_COMPLETED: 1,
      MATCHES_WON: 1,
      DAILY_DUELS_COMPLETED: 0,
    });
  });
});

describe("MasteryTracker", () => {
  const stored: ProgressCommitResult = { status: "stored" };

  function sinkReturning(...results: ProgressCommitResult[]) {
    const requests: ProgressRequest[] = [];
    let call = 0;
    return {
      requests,
      commitProgress: vi.fn(async (request: ProgressRequest) => {
        requests.push(request);
        return results[Math.min(call++, results.length - 1)];
      }),
    };
  }

  const noSleep = async () => {};

  it("guests get local feedback once, and never hammer the platform", async () => {
    const sink = sinkReturning({ status: "unavailable", reason: "guest" });
    const storage = memoryStorage();
    const tracker = new MasteryTracker({ sink, storage, sleep: noSleep });

    const first = tracker.recordMatch(1, finished("standard", 8, 2));
    expect(first.unlocked).toEqual([ACHIEVEMENT_IDS.finishMatch, ACHIEVEMENT_IDS.winMatch]);
    await tracker.sync();
    expect(tracker.syncState).toBe("local");
    expect(sink.commitProgress).toHaveBeenCalledTimes(1);

    // A second win unlocks nothing new.
    expect(tracker.recordMatch(2, finished("standard", 8, 2)).unlocked).toEqual([]);

    // Unlocks survive a reload on the same device.
    expect([...loadUnlockedAchievements(storage)].sort()).toEqual(["FINISH_MATCH", "WIN_MATCH"]);
    const reloaded = new MasteryTracker({ sink, storage, sleep: noSleep });
    expect(reloaded.recordMatch(1, finished("standard", 8, 2)).unlocked).toEqual([]);
  });

  it("duplicate calls for the same match change nothing", async () => {
    const sink = sinkReturning(stored);
    const tracker = new MasteryTracker({ sink, sleep: noSleep });
    const match = finished("daily", 8, 2);

    expect(tracker.recordMatch(7, match).unlocked.length).toBeGreaterThan(0);
    await tracker.sync();
    const again = tracker.recordMatch(7, match);
    await tracker.sync();

    expect(again).toEqual({ unlocked: [], duplicate: true });
    const lastWrite = sink.requests.at(-1)!.build(() => 10);
    expect(lastWrite.stats).toEqual({
      MATCHES_COMPLETED: 11,
      MATCHES_WON: 11,
      DAILY_DUELS_COMPLETED: 11,
    });
  });

  it("writes lifetime stats as baseline + session total, so retries never double-count", async () => {
    const sink = sinkReturning({ status: "failed", message: "network" }, stored);
    const tracker = new MasteryTracker({ sink, sleep: noSleep });

    tracker.recordMatch(1, finished("standard", 8, 2));
    await tracker.sync();

    expect(sink.commitProgress).toHaveBeenCalledTimes(2);
    expect(tracker.syncState).toBe("saved");
    // The platform's cached value moved to 5 after the first (failed) attempt wrote 4.
    // The baseline is read once, so the retry still computes 3 + 1, not 5 + 1.
    const first = sink.requests[0].build((id) => (id === "MATCHES_COMPLETED" ? 3 : 0));
    const second = sink.requests[1].build((id) => (id === "MATCHES_COMPLETED" ? 4 : 0));
    expect(first.stats.MATCHES_COMPLETED).toBe(4);
    expect(second.stats.MATCHES_COMPLETED).toBe(4);
  });

  it("sends the full unlocked set with every write, so a lost store is repaired", async () => {
    const sink = sinkReturning(stored);
    const tracker = new MasteryTracker({ sink, sleep: noSleep });
    tracker.recordMatch(1, finished("standard", 8, 2));
    tracker.recordMatch(2, finished("daily", 1, 5));
    await tracker.sync();
    expect(sink.requests.at(-1)!.build(() => 0).achievements.sort()).toEqual([
      "COMPLETE_DAILY_DUEL",
      "FINISH_MATCH",
      "WIN_MATCH",
    ]);
  });

  it("gives up after the retry budget and reports failed; a later match retries", async () => {
    const sink = sinkReturning({ status: "failed", message: "down" });
    const sleep = vi.fn(async (_ms: number) => {});
    const tracker = new MasteryTracker({ sink, sleep, retryDelaysMs: [1, 2] });

    tracker.recordMatch(1, finished("standard", 8, 2));
    await tracker.sync();
    expect(tracker.syncState).toBe("failed");
    expect(sink.commitProgress).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([1, 2]);

    tracker.recordMatch(2, finished("standard", 3, 4));
    await tracker.sync();
    expect(sink.commitProgress).toHaveBeenCalledTimes(6);
  });

  it("does not retry signed-out or SDK errors, but does retry not-ready", async () => {
    const signedOut = sinkReturning({ status: "unavailable", reason: "signed-out" });
    const a = new MasteryTracker({ sink: signedOut, sleep: noSleep });
    a.recordMatch(1, finished("standard", 8, 2));
    await a.sync();
    expect(signedOut.commitProgress).toHaveBeenCalledTimes(1);
    expect(a.syncState).toBe("local");

    const notReady = sinkReturning({ status: "unavailable", reason: "not-ready" }, stored);
    const b = new MasteryTracker({ sink: notReady, sleep: noSleep });
    b.recordMatch(1, finished("standard", 8, 2));
    await b.sync();
    expect(notReady.commitProgress).toHaveBeenCalledTimes(2);
    expect(b.syncState).toBe("saved");
  });

  it("ignores corrupt or foreign saved data", () => {
    expect(loadUnlockedAchievements(memoryStorage({ [MASTERY_STORAGE_KEY]: "{nope" })).size).toBe(0);
    const foreign = JSON.stringify({ schemaVersion: 1, unlocked: ["WIN_MATCH", "HACKED", 4] });
    expect([...loadUnlockedAchievements(memoryStorage({ [MASTERY_STORAGE_KEY]: foreign }))]).toEqual([
      "WIN_MATCH",
    ]);
    expect(loadUnlockedAchievements(undefined).size).toBe(0);
  });
});
