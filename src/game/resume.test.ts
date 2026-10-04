import { describe, expect, it } from "vitest";

import { createDailyMatch } from "./daily";
import { createInitialMatch } from "./match-flow";
import { MOVES } from "./constants";
import { createReplay, simulateMatch, verifyReplay } from "./replay";
import { restoreMatch, snapshotMatch } from "./resume";
import type { ResumableMatch } from "./save";
import type { Move } from "./types";

function queue(round: number): Move[] {
  return Array.from({ length: 8 }, (_, step) => MOVES[(round * 3 + step * 2) % MOVES.length]);
}

describe("restoreMatch", () => {
  it("rebuilds the exact state a live match had after N rounds", () => {
    const saved: ResumableMatch = {
      mode: "standard",
      seed: 12345,
      rulesVersion: 1,
      playerQueues: [queue(1), queue(2)],
    };
    const restored = restoreMatch(saved);

    expect(restored).not.toBeNull();
    if (!restored) return;

    const live = simulateMatch({ seed: 12345, playerQueues: saved.playerQueues });
    const last = live.rounds[live.rounds.length - 1];

    expect(restored.replay).toEqual(live);
    expect(verifyReplay(restored.replay).ok).toBe(true);
    expect(restored.match.status).toBe("queuing");
    expect(restored.match.currentRound).toBe(3);
    expect(restored.match.playerScore).toBe(
      live.rounds.flatMap((round) => round.steps).reduce((sum, step) => sum + step.playerScoreDelta, 0),
    );
    expect(restored.round.round).toBe(3);
    expect(restored.round.playerQueue).toEqual([]);
    expect(restored.round.player.tile).toEqual(last.steps[last.steps.length - 1].playerTile);
  });

  it("matches a match played straight through, round for round", () => {
    const queues = [queue(1), queue(2), queue(3), queue(4)];
    const full = simulateMatch({ seed: 99, playerQueues: [...queues, queue(5)] });
    const restored = restoreMatch({ mode: "standard", seed: 99, rulesVersion: 1, playerQueues: queues });

    expect(restored?.replay.rounds).toEqual(full.rounds.slice(0, 4));
    expect(restored?.match.currentRound).toBe(5);
  });

  it("keeps a Daily Duel on its starting date and board", () => {
    const daily = createDailyMatch("2026-10-04");
    const restored = restoreMatch({
      mode: "daily",
      seed: daily.seed,
      rulesVersion: daily.rulesVersion,
      dailyDate: "2026-10-04",
      playerQueues: [queue(1)],
    });

    expect(restored?.match.mode).toBe("daily");
    expect(restored?.match.dailyDate).toBe("2026-10-04");
    expect(restored?.match.seed).toBe(daily.seed);
    expect(restored?.replay.dailyDate).toBe("2026-10-04");
  });

  it("refuses saves it cannot reproduce", () => {
    const base: ResumableMatch = { mode: "standard", seed: 5, rulesVersion: 1, playerQueues: [queue(1)] };

    expect(restoreMatch({ ...base, rulesVersion: 2 })).toBeNull();
    expect(restoreMatch({ ...base, playerQueues: [queue(1).slice(1)] })).toBeNull();
    // Five rounds is a finished match, not a resumable one.
    expect(restoreMatch({ ...base, playerQueues: [1, 2, 3, 4, 5].map(queue) })).toBeNull();
    // A daily whose seed is not its date's seed.
    expect(
      restoreMatch({ mode: "daily", seed: 5, rulesVersion: 1, dailyDate: "2026-10-04", playerQueues: [queue(1)] }),
    ).toBeNull();
    expect(
      restoreMatch({ mode: "daily", seed: 5, rulesVersion: 1, dailyDate: "not-a-date", playerQueues: [queue(1)] }),
    ).toBeNull();
  });
});

describe("snapshotMatch", () => {
  const queues = [queue(1), queue(2)];

  function boundary() {
    // Reach a genuine round boundary through the restore path, then run snapshot on it.
    const restored = restoreMatch({ mode: "standard", seed: 31, rulesVersion: 1, playerQueues: queues });
    if (!restored) throw new Error("setup failed");
    return { match: { ...restored.match, currentRound: 2, status: "round-complete" as const }, replay: restored.replay };
  }

  it("saves the committed queues at a round boundary", () => {
    const { match, replay } = boundary();

    expect(snapshotMatch(match, replay)).toEqual({
      mode: "standard",
      seed: 31,
      rulesVersion: 1,
      playerQueues: queues,
    });
  });

  it("never saves while queuing, animating, finished, guided, or out of step with the replay", () => {
    const { match, replay } = boundary();

    expect(snapshotMatch({ ...match, status: "queuing" }, replay)).toBeNull();
    expect(snapshotMatch({ ...match, status: "executing" }, replay)).toBeNull();
    expect(snapshotMatch({ ...match, status: "match-complete" }, replay)).toBeNull();
    expect(snapshotMatch({ ...match, mode: "guided" }, replay)).toBeNull();
    expect(snapshotMatch({ ...match, currentRound: 3 }, replay)).toBeNull();
    expect(snapshotMatch(createInitialMatch("standard"), createReplay(createInitialMatch("standard")))).toBeNull();
  });

  it("includes the daily date for a Daily Duel", () => {
    const daily = createDailyMatch("2026-10-04");
    const restored = restoreMatch({
      mode: "daily",
      seed: daily.seed,
      rulesVersion: 1,
      dailyDate: "2026-10-04",
      playerQueues: [queue(1)],
    });
    if (!restored) throw new Error("setup failed");

    const snapshot = snapshotMatch(
      { ...restored.match, currentRound: 1, status: "round-complete" },
      restored.replay,
    );

    expect(snapshot).toMatchObject({ mode: "daily", dailyDate: "2026-10-04", seed: daily.seed });
  });
});
