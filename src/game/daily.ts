import { createInitialMatch } from "./match-flow";
import { RULES_VERSION } from "./match-rules";
import { deriveSeed } from "./random";
import type { MatchState } from "./types";

/**
 * Daily Duel seed scheme (see docs/DAILY_DUEL.md).
 *
 *   seed = deriveSeed(DAILY_SEED_ROOT, "daily", rulesVersion, "YYYY-MM-DD")
 *
 * The date is the UTC calendar day, so every player on every machine gets the
 * same board and the same rival decisions. The rival is planned only from
 * public state plus a seed derived from this one; it never reads the player's
 * queue. rulesVersion is part of the seed so a rules change starts a fresh
 * board (and a fresh local ranking) instead of mixing results.
 */
export const DAILY_SEED_ROOT = 0x44414c59; // "DALY"

export const DAILY_HISTORY_KEY = "energy-duel.daily.v1";
const HISTORY_SCHEMA_VERSION = 1;
/** Oldest attempts are dropped beyond this, so storage stays small. */
const MAX_STORED_ATTEMPTS = 400;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** UTC calendar day of an instant as YYYY-MM-DD. Never uses the local zone. */
export function utcDateString(instant: Date | number = Date.now()): string {
  return new Date(instant).toISOString().slice(0, 10);
}

export function isValidDailyDate(date: string): boolean {
  const parts = DATE_PATTERN.exec(date);

  if (!parts) {
    return false;
  }

  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const parsed = new Date(Date.UTC(year, month - 1, day));

  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

export function dailySeed(date: string, rulesVersion: number = RULES_VERSION): number {
  return deriveSeed(DAILY_SEED_ROOT, "daily", rulesVersion, date);
}

/**
 * A new attempt on the board for `date`. The date is stamped on the match and
 * never recomputed, so a run that outlives midnight stays on its start date.
 */
export function createDailyMatch(
  date: string,
  rulesVersion: number = RULES_VERSION,
): MatchState {
  if (!isValidDailyDate(date)) {
    throw new Error(`Invalid Daily Duel date: ${date}`);
  }

  return {
    ...createInitialMatch("daily", { seed: dailySeed(date, rulesVersion), dailyDate: date }),
    rulesVersion,
  };
}

export interface DailyBoardStatus {
  /** The date this attempt's board belongs to. */
  boardDate: string;
  /** The current UTC date. */
  today: string;
  /** False once the attempt has outlived its day. */
  isToday: boolean;
}

export function dailyBoardStatus(
  match: MatchState,
  now: Date | number = Date.now(),
): DailyBoardStatus | null {
  if (match.mode !== "daily" || !match.dailyDate) {
    return null;
  }

  const today = utcDateString(now);

  return { boardDate: match.dailyDate, today, isToday: match.dailyDate === today };
}

export interface DailyAttempt {
  date: string;
  rulesVersion: number;
  playerScore: number;
  rivalScore: number;
  /** Ranking value: playerScore - rivalScore. */
  margin: number;
}

export interface DailyHistory {
  attempts: DailyAttempt[];
}

export interface DailyRankSummary extends DailyAttempt {
  /** 1 is best; tied attempts share a rank. */
  rank: number;
  /** Local attempts on this date and rules version, including this one. */
  attempts: number;
  /** Other attempts with exactly this margin. */
  tiedWith: number;
  bestMargin: number;
}

/**
 * Adds a finished Daily Duel to the history and ranks it against earlier
 * attempts on the same date and rules version. Anything else is ignored.
 */
export function recordDailyAttempt(
  history: DailyHistory,
  match: MatchState,
): { history: DailyHistory; summary: DailyRankSummary | null } {
  if (
    match.mode !== "daily" ||
    !match.dailyDate ||
    match.status !== "match-complete"
  ) {
    return { history, summary: null };
  }

  const attempt: DailyAttempt = {
    date: match.dailyDate,
    rulesVersion: match.rulesVersion,
    playerScore: match.playerScore,
    rivalScore: match.rivalScore,
    margin: match.playerScore - match.rivalScore,
  };
  const attempts = [...history.attempts, attempt].slice(-MAX_STORED_ATTEMPTS);

  return { history: { attempts }, summary: summarizeAttempt(attempts, attempt) };
}

/** Adds `attempt` only if it beats the best local result for its board (used when a synced save brings one in). */
export function withBetterDailyAttempt(history: DailyHistory, attempt: DailyAttempt): DailyHistory {
  const best = bestDailyAttempt(history, attempt.date, attempt.rulesVersion);

  if (best && best.margin >= attempt.margin) {
    return history;
  }

  return { attempts: [...history.attempts, attempt].slice(-MAX_STORED_ATTEMPTS) };
}

/** Best local result for a board, or null before any attempt. */
export function bestDailyAttempt(
  history: DailyHistory,
  date: string,
  rulesVersion: number = RULES_VERSION,
): DailyAttempt | null {
  return sameBoard(history.attempts, date, rulesVersion).reduce<DailyAttempt | null>(
    (best, attempt) => (!best || attempt.margin > best.margin ? attempt : best),
    null,
  );
}

function sameBoard(
  attempts: DailyAttempt[],
  date: string,
  rulesVersion: number,
): DailyAttempt[] {
  return attempts.filter(
    (entry) => entry.date === date && entry.rulesVersion === rulesVersion,
  );
}

function summarizeAttempt(
  attempts: DailyAttempt[],
  attempt: DailyAttempt,
): DailyRankSummary {
  const board = sameBoard(attempts, attempt.date, attempt.rulesVersion);

  return {
    ...attempt,
    rank: 1 + board.filter((entry) => entry.margin > attempt.margin).length,
    attempts: board.length,
    tiedWith: board.filter((entry) => entry.margin === attempt.margin).length - 1,
    bestMargin: Math.max(...board.map((entry) => entry.margin)),
  };
}

export type DailyHistoryStatus = "empty" | "ok" | "corrupt" | "unsupported";

export interface LoadedDailyHistory {
  history: DailyHistory;
  status: DailyHistoryStatus;
  /** False when saving could destroy data this build cannot read. */
  writable: boolean;
}

/**
 * Reads saved attempts. Corrupt data is copied to `<key>.corrupt` and replaced
 * by an empty history; data from a newer schema is left untouched (this
 * session just keeps results in memory); individual bad entries are dropped.
 */
export function loadDailyHistory(storage: Storage | undefined): LoadedDailyHistory {
  const empty: DailyHistory = { attempts: [] };

  if (!storage) {
    return { history: empty, status: "empty", writable: false };
  }

  let raw: string | null;

  try {
    raw = storage.getItem(DAILY_HISTORY_KEY);
  } catch {
    return { history: empty, status: "empty", writable: false };
  }

  if (raw === null) {
    return { history: empty, status: "empty", writable: true };
  }

  let data: unknown;

  try {
    data = JSON.parse(raw);
  } catch {
    return recoverCorrupt(storage, raw);
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return recoverCorrupt(storage, raw);
  }

  const { schemaVersion, attempts } = data as {
    schemaVersion?: unknown;
    attempts?: unknown;
  };

  if (typeof schemaVersion === "number" && schemaVersion > HISTORY_SCHEMA_VERSION) {
    return { history: empty, status: "unsupported", writable: false };
  }

  if (schemaVersion !== HISTORY_SCHEMA_VERSION || !Array.isArray(attempts)) {
    return recoverCorrupt(storage, raw);
  }

  return {
    history: { attempts: attempts.flatMap(parseAttempt) },
    status: "ok",
    writable: true,
  };
}

export function saveDailyHistory(
  storage: Storage | undefined,
  history: DailyHistory,
  writable = true,
): void {
  if (!storage || !writable) {
    return;
  }

  try {
    storage.setItem(
      DAILY_HISTORY_KEY,
      JSON.stringify({ schemaVersion: HISTORY_SCHEMA_VERSION, attempts: history.attempts }),
    );
  } catch {
    // Storage can be full or blocked; the result still shows for this session.
  }
}

function recoverCorrupt(storage: Storage, raw: string): LoadedDailyHistory {
  try {
    storage.setItem(`${DAILY_HISTORY_KEY}.corrupt`, raw);
  } catch {
    // Keeping a copy is best effort.
  }

  return { history: { attempts: [] }, status: "corrupt", writable: true };
}

function parseAttempt(value: unknown): DailyAttempt[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }

  const entry = value as Record<string, unknown>;
  const { date, rulesVersion, playerScore, rivalScore } = entry;

  if (
    typeof date !== "string" ||
    !isValidDailyDate(date) ||
    !Number.isInteger(rulesVersion) ||
    !Number.isInteger(playerScore) ||
    !Number.isInteger(rivalScore)
  ) {
    return [];
  }

  return [
    {
      date,
      rulesVersion: rulesVersion as number,
      playerScore: playerScore as number,
      rivalScore: rivalScore as number,
      margin: (playerScore as number) - (rivalScore as number),
    },
  ];
}
