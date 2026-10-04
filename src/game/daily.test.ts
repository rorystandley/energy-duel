import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DAILY_HISTORY_KEY,
  createDailyMatch,
  dailyBoardStatus,
  dailySeed,
  isValidDailyDate,
  loadDailyHistory,
  recordDailyAttempt,
  saveDailyHistory,
  utcDateString,
} from "./daily";
import type { DailyHistory } from "./daily";
import {
  createInitialMatch,
  createNewBoardMatch,
  createRematchMatch,
  createRoundState,
  lockRoundQueues,
} from "./match-flow";
import { simulateMatch } from "./replay";
import type { Move } from "./types";

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

const EMPTY: DailyHistory = { attempts: [] };

function firstBoard(date: string, version?: number) {
  const match = createDailyMatch(date, version);
  const round = createRoundState(1, { mode: match.mode, seed: match.seed });
  return { match, round };
}

function finished(date: string, playerScore: number, rivalScore: number) {
  return {
    ...createDailyMatch(date),
    status: "match-complete" as const,
    playerScore,
    rivalScore,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("daily seed scheme", () => {
  it("gives the same board and rival plan for the same date and version", () => {
    const a = firstBoard("2026-10-04");
    const b = firstBoard("2026-10-04");

    expect(a.match.seed).toBe(b.match.seed);
    expect(a.round.board).toEqual(b.round.board);
    expect(a.round.pickups).toEqual(b.round.pickups);
    expect(lockRoundQueues(a.round).rivalQueue).toEqual(
      lockRoundQueues(b.round).rivalQueue,
    );
  });

  it("gives a different board on the next date", () => {
    const today = firstBoard("2026-10-04");
    const tomorrow = firstBoard("2026-10-05");

    expect(tomorrow.match.seed).not.toBe(today.match.seed);
    expect(JSON.stringify([tomorrow.round.board, tomorrow.round.pickups])).not.toBe(
      JSON.stringify([today.round.board, today.round.pickups]),
    );
  });

  it("starts a separate board for a different rules version", () => {
    expect(dailySeed("2026-10-04", 1)).not.toBe(dailySeed("2026-10-04", 2));
    expect(createDailyMatch("2026-10-04").rulesVersion).toBe(1);
  });

  it("produces a uint32 seed", () => {
    const seed = dailySeed("2026-10-04", 1);

    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThan(2 ** 32);
  });

  it("does not let the player's hidden queue change the rival's plan", () => {
    const { round } = firstBoard("2026-10-04");
    const queues: Move[][] = [
      Array<Move>(8).fill("wait"),
      Array<Move>(8).fill("up"),
      ["right", "down", "left", "up", "right", "down", "left", "up"],
    ];
    const rivalQueues = queues.map(
      (queue) => lockRoundQueues({ ...round, playerQueue: queue }).rivalQueue,
    );

    expect(rivalQueues[1]).toEqual(rivalQueues[0]);
    expect(rivalQueues[2]).toEqual(rivalQueues[0]);
  });

  it("replays identically from the daily seed", () => {
    const queue: Move[] = Array<Move>(8).fill("right");
    const run = () =>
      simulateMatch({
        seed: dailySeed("2026-10-04"),
        mode: "daily",
        playerQueues: [queue, queue, queue, queue, queue],
      });

    expect(run()).toEqual(run());
    expect(run().result).toBeDefined();
  });
});

describe("UTC date", () => {
  it("formats an instant by its UTC date", () => {
    expect(utcDateString(Date.UTC(2026, 9, 4, 23, 59, 59, 999))).toBe("2026-10-04");
    expect(utcDateString(Date.UTC(2026, 9, 5, 0, 0, 0, 0))).toBe("2026-10-05");
    expect(utcDateString(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01");
  });

  it("is independent of the machine's time zone", () => {
    // One instant in three zones: the local calendar day can differ, the UTC
    // day (and so the board) must not.
    const instant = Date.UTC(2026, 9, 4, 23, 30);
    const seeds = new Set<number>();

    for (const zone of ["Pacific/Kiritimati", "UTC", "Pacific/Pago_Pago"]) {
      vi.stubEnv("TZ", zone);
      expect(utcDateString(instant)).toBe("2026-10-04");
      seeds.add(createDailyMatch(utcDateString(instant)).seed);
    }

    expect(seeds.size).toBe(1);
  });

  it("validates real calendar dates only", () => {
    expect(isValidDailyDate("2026-10-04")).toBe(true);
    expect(isValidDailyDate("2028-02-29")).toBe(true);
    expect(isValidDailyDate("2026-02-29")).toBe(false);
    expect(isValidDailyDate("2026-13-01")).toBe(false);
    expect(isValidDailyDate("04/10/2026")).toBe(false);
    expect(() => createDailyMatch("tomorrow")).toThrow();
  });
});

describe("Daily Duel is separate from Standard", () => {
  it("keeps the date on rematch but not on a new board", () => {
    const daily = createDailyMatch("2026-10-04");

    expect(createRematchMatch(daily)).toMatchObject({
      mode: "daily",
      seed: daily.seed,
      dailyDate: "2026-10-04",
    });

    const fresh = createNewBoardMatch(daily);
    expect(fresh.mode).toBe("standard");
    expect(fresh.dailyDate).toBeUndefined();
    expect(createInitialMatch("standard").dailyDate).toBeUndefined();
  });
});

describe("rollover while a match is in progress", () => {
  it("attributes a run started before midnight to its starting date", () => {
    const startedAt = Date.UTC(2026, 9, 4, 23, 59, 50);
    const match = createDailyMatch(utcDateString(startedAt));
    const finishedAt = Date.UTC(2026, 9, 5, 0, 4, 0);

    expect(dailyBoardStatus(match, startedAt)).toEqual({
      boardDate: "2026-10-04",
      today: "2026-10-04",
      isToday: true,
    });
    expect(dailyBoardStatus(match, finishedAt)).toEqual({
      boardDate: "2026-10-04",
      today: "2026-10-05",
      isToday: false,
    });

    const { history, summary } = recordDailyAttempt(EMPTY, {
      ...match,
      status: "match-complete",
      playerScore: 9,
      rivalScore: 4,
    });

    expect(summary?.date).toBe("2026-10-04");
    expect(history.attempts).toEqual([
      expect.objectContaining({ date: "2026-10-04", margin: 5 }),
    ]);
    // The new day's board has no attempts yet.
    expect(recordDailyAttempt(history, finished("2026-10-05", 1, 0)).summary?.attempts).toBe(1);
    // The board itself never moved to the new date.
    expect(match.seed).toBe(dailySeed("2026-10-04"));
  });
});

describe("local ranking", () => {
  it("ranks by player minus rival and shows both scores", () => {
    let history = recordDailyAttempt(EMPTY, finished("2026-10-04", 10, 4)).history; // +6
    history = recordDailyAttempt(history, finished("2026-10-04", 3, 6)).history; // -3

    const result = recordDailyAttempt(history, finished("2026-10-04", 12, 8)); // +4

    expect(result.summary).toMatchObject({
      rank: 2,
      attempts: 3,
      margin: 4,
      playerScore: 12,
      rivalScore: 8,
      bestMargin: 6,
    });
  });

  it("lets a higher margin beat a higher raw score, and allows ties", () => {
    const history = recordDailyAttempt(EMPTY, finished("2026-10-04", 20, 18)).history; // +2
    const better = recordDailyAttempt(history, finished("2026-10-04", 5, 0)); // +5

    expect(better.summary?.rank).toBe(1);

    const tie = recordDailyAttempt(better.history, finished("2026-10-04", 7, 2)); // +5
    expect(tie.summary).toMatchObject({ rank: 1, tiedWith: 1 });
  });

  it("never mixes dates or rules versions", () => {
    let history = recordDailyAttempt(EMPTY, finished("2026-10-03", 50, 0)).history;
    history = recordDailyAttempt(history, {
      ...finished("2026-10-04", 30, 0),
      rulesVersion: 0,
    }).history;

    const result = recordDailyAttempt(history, finished("2026-10-04", 1, 0));

    expect(result.summary).toMatchObject({ rank: 1, attempts: 1, bestMargin: 1 });
  });

  it("ignores matches that are not finished daily attempts", () => {
    expect(recordDailyAttempt(EMPTY, createDailyMatch("2026-10-04"))).toEqual({
      history: EMPTY,
      summary: null,
    });
    expect(
      recordDailyAttempt(EMPTY, {
        ...createInitialMatch("standard"),
        status: "match-complete",
      }).summary,
    ).toBeNull();
  });
});

describe("saved history", () => {
  it("survives a reload", () => {
    const storage = new MemoryStorage();
    const { history } = recordDailyAttempt(EMPTY, finished("2026-10-04", 8, 3));

    saveDailyHistory(storage, history);

    expect(loadDailyHistory(storage)).toMatchObject({
      status: "ok",
      history: { attempts: [expect.objectContaining({ date: "2026-10-04", margin: 5 })] },
    });
  });

  it("starts empty with no storage or no saved data", () => {
    expect(loadDailyHistory(undefined)).toMatchObject({ status: "empty", writable: false });
    expect(loadDailyHistory(new MemoryStorage())).toMatchObject({
      status: "empty",
      writable: true,
      history: { attempts: [] },
    });
  });

  it("recovers from corrupt data and keeps a copy", () => {
    const storage = new MemoryStorage();
    storage.setItem(DAILY_HISTORY_KEY, "{not json");

    const loaded = loadDailyHistory(storage);

    expect(loaded).toMatchObject({ status: "corrupt", writable: true });
    expect(loaded.history.attempts).toEqual([]);
    expect(storage.getItem(`${DAILY_HISTORY_KEY}.corrupt`)).toBe("{not json");
  });

  it("drops invalid entries but keeps valid ones", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      DAILY_HISTORY_KEY,
      JSON.stringify({
        schemaVersion: 1,
        attempts: [
          { date: "2026-10-04", rulesVersion: 1, playerScore: 5, rivalScore: 1 },
          { date: "nope", rulesVersion: 1, playerScore: 5, rivalScore: 1 },
          { date: "2026-10-04", rulesVersion: 1, playerScore: "x", rivalScore: 1 },
        ],
      }),
    );

    const loaded = loadDailyHistory(storage);

    expect(loaded.history.attempts).toEqual([
      { date: "2026-10-04", rulesVersion: 1, playerScore: 5, rivalScore: 1, margin: 4 },
    ]);
  });

  it("does not overwrite data from a newer schema", () => {
    const storage = new MemoryStorage();
    const raw = JSON.stringify({ schemaVersion: 99, attempts: [], extra: true });
    storage.setItem(DAILY_HISTORY_KEY, raw);

    const loaded = loadDailyHistory(storage);

    expect(loaded).toMatchObject({ status: "unsupported", writable: false });
    saveDailyHistory(storage, loaded.history, loaded.writable);
    expect(storage.getItem(DAILY_HISTORY_KEY)).toBe(raw);
  });

  it("keeps results from older rules versions without ranking them", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      DAILY_HISTORY_KEY,
      JSON.stringify({
        schemaVersion: 1,
        attempts: [
          { date: "2026-10-04", rulesVersion: 0, playerScore: 99, rivalScore: 0 },
        ],
      }),
    );

    const loaded = loadDailyHistory(storage);
    const result = recordDailyAttempt(loaded.history, finished("2026-10-04", 2, 1));

    expect(loaded.history.attempts).toHaveLength(1);
    expect(result.summary).toMatchObject({ rank: 1, attempts: 1 });
    expect(result.history.attempts).toHaveLength(2);
  });

  it("tolerates storage that throws", () => {
    const broken = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
    } as unknown as Storage;

    expect(loadDailyHistory(broken).history.attempts).toEqual([]);
    expect(() => saveDailyHistory(broken, EMPTY)).not.toThrow();
  });
});
