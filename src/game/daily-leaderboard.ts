import type {
  LeaderboardSubmitRequest,
  LeaderboardSubmitResult,
  LeaderboardUnavailableReason,
} from "../platform/wavedash";
import { isValidDailyDate } from "./daily";
import type { MatchState } from "./types";

/**
 * Daily Duel online ranking (docs/DAILY_LEADERBOARD.md).
 *
 * One Wavedash board per UTC date and rules version, named
 * `daily-v<rulesVersion>-<YYYY-MM-DD>`: descending score, score = player minus
 * rival, keepBest. Rankings are client-reported and therefore casual, not
 * cheat-resistant.
 *
 * The client only ever *resolves* a board by name. It never creates one: boards
 * created by ordinary players default to Hidden, so a client-created daily board
 * would silently have no public leaderboard. Boards are provisioned by the
 * operator (scripts/provision-daily-leaderboards.mjs).
 */

export const DAILY_LEADERBOARD_PREFIX = "daily";

export function dailyLeaderboardName(date: string, rulesVersion: number): string {
  if (!isValidDailyDate(date) || !Number.isInteger(rulesVersion) || rulesVersion < 1) {
    throw new Error(`Invalid Daily Duel board: ${date} v${rulesVersion}`);
  }

  return `${DAILY_LEADERBOARD_PREFIX}-v${rulesVersion}-${date}`;
}

/** The leaderboard score: player minus rival, so higher is better and ties are equal scores. */
export function dailyLeaderboardScore(playerScore: number, rivalScore: number): number {
  return playerScore - rivalScore;
}

/** Four small primitive values; well inside Wavedash's 16 keys / 2048 bytes limit. */
export interface DailyLeaderboardMetadata {
  date: string;
  rulesVersion: number;
  playerScore: number;
  rivalScore: number;
}

/** What a finished Daily Duel submits, or null for anything that must not be ranked. */
export function createDailySubmission(match: MatchState): LeaderboardSubmitRequest | null {
  if (match.mode !== "daily" || !match.dailyDate || match.status !== "match-complete") {
    return null;
  }

  const metadata: DailyLeaderboardMetadata = {
    date: match.dailyDate,
    rulesVersion: match.rulesVersion,
    playerScore: match.playerScore,
    rivalScore: match.rivalScore,
  };

  return {
    name: dailyLeaderboardName(match.dailyDate, match.rulesVersion),
    score: dailyLeaderboardScore(match.playerScore, match.rivalScore),
    metadata: { ...metadata },
  };
}

// ---------------------------------------------------------------------------
// Submitter
// ---------------------------------------------------------------------------

export interface RankedScore {
  score: number;
  rank: number;
}

/**
 * `local`: guest or signed out, nothing sent. `board-missing`: Wavedash has no
 * board with this name (not provisioned yet). `failed`: network or SDK error
 * after retries. Only `submitted` means Wavedash returned a rank.
 */
export type DailySubmissionState =
  | "pending"
  | "submitted"
  | "local"
  | "board-missing"
  | "failed";

export interface DailySubmission {
  state: DailySubmissionState;
  boardName: string;
  /** This attempt's own score and the rank it would hold. Present once submitted. */
  attempt?: RankedScore;
  /** The player's saved best on the board; differs from `attempt` when keepBest kept an earlier run. */
  best?: RankedScore;
}

export interface DailyLeaderboardSink {
  submitLeaderboardScore(request: LeaderboardSubmitRequest): Promise<LeaderboardSubmitResult>;
}

export interface DailyLeaderboardSubmitterOptions {
  sink: DailyLeaderboardSink;
  /** Delays between automatic retries of a transient failure. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  onChange?: (attemptId: number | string, submission: DailySubmission) => void;
}

const LOCAL_REASONS: ReadonlySet<LeaderboardUnavailableReason> = new Set([
  "guest",
  "signed-out",
  "sdk-error",
]);

export class DailyLeaderboardSubmitter {
  private readonly submissions = new Map<number | string, DailySubmission>();

  constructor(private readonly options: DailyLeaderboardSubmitterOptions) {}

  get(attemptId: number | string): DailySubmission | null {
    return this.submissions.get(attemptId) ?? null;
  }

  /**
   * Submits a finished Daily Duel once per `attemptId`. Calling again for the
   * same attempt, in any state, sends nothing: reopening the end screen or a
   * replay can never post a second entry. Never rejects.
   */
  submit(attemptId: number | string, match: MatchState): Promise<DailySubmission | null> {
    const request = createDailySubmission(match);

    if (!request) {
      return Promise.resolve(null);
    }

    const existing = this.submissions.get(attemptId);

    if (existing) {
      return Promise.resolve(existing);
    }

    this.set(attemptId, { state: "pending", boardName: request.name });
    return this.run(attemptId, request);
  }

  private async run(
    attemptId: number | string,
    request: LeaderboardSubmitRequest,
  ): Promise<DailySubmission> {
    const delays = this.options.retryDelaysMs ?? [2_000, 8_000];
    const sleep = this.options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

    for (let attempt = 0; ; attempt += 1) {
      const result = await this.send(request);

      if (result.status === "submitted") {
        return this.set(attemptId, {
          state: "submitted",
          boardName: request.name,
          attempt: result.submitted,
          best: result.saved,
        });
      }

      if (result.status === "unavailable") {
        return this.set(attemptId, {
          state: LOCAL_REASONS.has(result.reason) ? "local" : "board-missing",
          boardName: request.name,
        });
      }

      if (attempt >= delays.length) {
        return this.set(attemptId, { state: "failed", boardName: request.name });
      }

      await sleep(delays[attempt]);
    }
  }

  private async send(request: LeaderboardSubmitRequest): Promise<LeaderboardSubmitResult> {
    try {
      return await this.options.sink.submitLeaderboardScore(request);
    } catch (error) {
      return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  }

  private set(attemptId: number | string, submission: DailySubmission): DailySubmission {
    this.submissions.set(attemptId, submission);
    this.options.onChange?.(attemptId, submission);
    return submission;
  }
}
