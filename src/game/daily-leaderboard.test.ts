import { describe, expect, it, vi } from "vitest";

import { createDailyMatch } from "./daily";
import {
  createDailySubmission,
  dailyLeaderboardName,
  dailyLeaderboardScore,
  DailyLeaderboardSubmitter,
} from "./daily-leaderboard";
import type { DailySubmission } from "./daily-leaderboard";
import { createMatchCompleteOverlayModel } from "./match-end-overlay";
import { createInitialMatch } from "./match-flow";
import type { LeaderboardSubmitRequest, LeaderboardSubmitResult } from "../platform/wavedash";
import type { MatchState } from "./types";

function finished(date: string, playerScore: number, rivalScore: number, rulesVersion?: number): MatchState {
  return {
    ...createDailyMatch(date, rulesVersion),
    status: "match-complete",
    playerScore,
    rivalScore,
  };
}

const submitted = (score: number, rank: number, best = { score, rank }): LeaderboardSubmitResult => ({
  status: "submitted",
  submitted: { score, rank },
  saved: best,
});

describe("daily leaderboard naming and score", () => {
  it("derives player minus rival, negative when behind and zero on a draw", () => {
    expect(dailyLeaderboardScore(12, 8)).toBe(4);
    expect(dailyLeaderboardScore(6, 10)).toBe(-4);
    expect(dailyLeaderboardScore(9, 9)).toBe(0);
  });

  it("uses one permanent board regardless of date or rules version", () => {
    expect(dailyLeaderboardName()).toBe("daily-duel");
  });

  it("builds a compact submission from the match's own date and rules version", () => {
    const request = createDailySubmission(finished("2026-10-04", 12, 8, 3))!;
    expect(request).toEqual({
      name: "daily-duel",
      score: 4,
      metadata: { date: "2026-10-04", rulesVersion: 3, playerScore: 12, rivalScore: 8 },
    });
    expect(JSON.stringify(request.metadata).length).toBeLessThan(2048);
  });

  it("keeps a run that outlives midnight on its starting date", () => {
    vi.useFakeTimers({ now: new Date("2026-10-05T00:30:00Z") });
    try {
      expect(createDailySubmission(finished("2026-10-04", 5, 3))!.metadata).toMatchObject({ date: "2026-10-04" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never ranks unfinished, standard or guided matches", () => {
    expect(createDailySubmission(createDailyMatch("2026-10-04"))).toBeNull();
    expect(createDailySubmission({ ...createInitialMatch(), status: "match-complete" })).toBeNull();
    expect(
      createDailySubmission({ ...createInitialMatch("guided"), status: "match-complete" }),
    ).toBeNull();
  });

  it("gives tied results identical leaderboard scores", () => {
    const a = createDailySubmission(finished("2026-10-04", 10, 7))!;
    const b = createDailySubmission(finished("2026-10-04", 15, 12))!;
    expect(a.score).toBe(b.score);
    expect(a.name).toBe(b.name);
  });
});

describe("DailyLeaderboardSubmitter", () => {
  const noSleep = async () => {};

  it("submits once per attempt however often it is asked", async () => {
    const sink = { submitLeaderboardScore: vi.fn(async () => submitted(4, 3)) };
    const submitter = new DailyLeaderboardSubmitter({ sink });
    const match = finished("2026-10-04", 12, 8);

    await Promise.all([submitter.submit(1, match), submitter.submit(1, match)]);
    await submitter.submit(1, match);

    expect(sink.submitLeaderboardScore).toHaveBeenCalledTimes(1);
    expect(submitter.get(1)?.state).toBe("submitted");
  });

  it("submits separate attempts separately, all to the one board", async () => {
    const sink = {
      submitLeaderboardScore: vi.fn(async (_request: LeaderboardSubmitRequest) => submitted(1, 1)),
    };
    const submitter = new DailyLeaderboardSubmitter({ sink });

    await submitter.submit(1, finished("2026-10-04", 5, 4));
    await submitter.submit(2, finished("2026-10-05", 5, 4));
    await submitter.submit(3, finished("2026-10-05", 5, 4, 2));

    const names = sink.submitLeaderboardScore.mock.calls.map(([r]) => r.name);
    expect(names).toEqual(["daily-duel", "daily-duel", "daily-duel"]);
  });

  it("keeps the saved best and this attempt apart", async () => {
    const sink = {
      submitLeaderboardScore: async () => submitted(-2, 40, { score: 5, rank: 7 }),
    };
    const submitter = new DailyLeaderboardSubmitter({ sink });
    const result = await submitter.submit(1, finished("2026-10-04", 3, 5));

    expect(result).toMatchObject({
      state: "submitted",
      attempt: { score: -2, rank: 40 },
      best: { score: 5, rank: 7 },
    });
  });

  it.each(["guest", "signed-out", "sdk-error"] as const)(
    "does not retry or claim success for %s",
    async (reason) => {
      const sink = {
        submitLeaderboardScore: vi.fn(async (): Promise<LeaderboardSubmitResult> => ({
          status: "unavailable",
          reason,
        })),
      };
      const result = await new DailyLeaderboardSubmitter({ sink, sleep: noSleep }).submit(
        1,
        finished("2026-10-04", 5, 4),
      );
      expect(result?.state).toBe("local");
      expect(result?.attempt).toBeUndefined();
      expect(sink.submitLeaderboardScore).toHaveBeenCalledTimes(1);
    },
  );

  it("reports a missing board as board-missing, not success", async () => {
    const sink = {
      submitLeaderboardScore: async (): Promise<LeaderboardSubmitResult> => ({
        status: "unavailable",
        reason: "board-missing",
      }),
    };
    const result = await new DailyLeaderboardSubmitter({ sink }).submit(1, finished("2026-10-04", 5, 4));
    expect(result).toMatchObject({ state: "board-missing", boardName: "daily-duel" });
    expect(result?.best).toBeUndefined();
  });

  it("retries transient failures, then succeeds without a duplicate entry", async () => {
    const sink = {
      submitLeaderboardScore: vi
        .fn<() => Promise<LeaderboardSubmitResult>>()
        .mockResolvedValueOnce({ status: "failed", message: "offline" })
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce(submitted(1, 2)),
    };
    const submitter = new DailyLeaderboardSubmitter({ sink, sleep: noSleep });

    await expect(submitter.submit(1, finished("2026-10-04", 5, 4))).resolves.toMatchObject({
      state: "submitted",
    });
    expect(sink.submitLeaderboardScore).toHaveBeenCalledTimes(3);
  });

  it("settles on failed once retries run out, and does not resubmit on reopen", async () => {
    const sink = {
      submitLeaderboardScore: vi.fn(async (): Promise<LeaderboardSubmitResult> => ({
        status: "failed",
        message: "offline",
      })),
    };
    const submitter = new DailyLeaderboardSubmitter({ sink, sleep: noSleep });
    const match = finished("2026-10-04", 5, 4);

    expect((await submitter.submit(1, match))?.state).toBe("failed");
    expect(sink.submitLeaderboardScore).toHaveBeenCalledTimes(3);
    await submitter.submit(1, match);
    expect(sink.submitLeaderboardScore).toHaveBeenCalledTimes(3);
  });

  it("ignores matches that are not finished Daily Duels", async () => {
    const sink = { submitLeaderboardScore: vi.fn() };
    const submitter = new DailyLeaderboardSubmitter({ sink });
    await expect(submitter.submit(1, createInitialMatch())).resolves.toBeNull();
    expect(sink.submitLeaderboardScore).not.toHaveBeenCalled();
  });
});

describe("end screen online rank", () => {
  const match = finished("2026-10-04", 3, 5);
  const rows = (online: DailySubmission | null) =>
    createMatchCompleteOverlayModel(match, { dailyOnline: online }).storyRows.filter((r) =>
      ["ONLINE RANK", "THIS ATTEMPT", "SAVED BEST"].includes(r.label),
    );

  it("shows nothing before a submission exists", () => {
    expect(rows(null)).toEqual([]);
  });

  it("separates the submitted attempt from the saved best and labels it casual", () => {
    const result = rows({
      state: "submitted",
      boardName: "daily-duel",
      attempt: { score: -2, rank: 40 },
      best: { score: 5, rank: 7 },
    });
    expect(result.map((r) => r.value)).toEqual([
      "CASUAL, CLIENT-REPORTED",
      "-2  RANK #40",
      "+5  RANK #7 (KEPT)",
    ]);
  });

  it.each([
    ["pending", "SUBMITTING..."],
    ["local", "NOT SUBMITTED - SIGN IN ON WAVEDASH"],
    ["board-missing", "ONLINE BOARD IS NOT OPEN YET"],
    ["failed", "SUBMIT FAILED - NOT RANKED"],
  ] as const)("never shows a rank for %s", (state, text) => {
    const result = rows({ state, boardName: "daily-duel" });
    expect(result).toEqual([{ label: "ONLINE RANK", value: text, tone: "neutral" }]);
  });
});
