import type {
  ProgressCommitResult,
  ProgressRequest,
  ProgressUnavailableReason,
} from "../platform/wavedash";
import type { MatchState } from "./types";

/**
 * Light mastery goals. Identifiers are the contract with the Wavedash portal;
 * `docs/WAVEDASH_ACHIEVEMENTS.md` and `wavedash/achievements.json` must match.
 */
export const ACHIEVEMENT_IDS = {
  finishMatch: "FINISH_MATCH",
  winMatch: "WIN_MATCH",
  claimThreeHighValueNodes: "CLAIM_THREE_HIGH_VALUE_NODES",
  winClashOnEnemyPriority: "WIN_CLASH_ON_ENEMY_PRIORITY",
  completeDailyDuel: "COMPLETE_DAILY_DUEL",
} as const;

export type AchievementId = (typeof ACHIEVEMENT_IDS)[keyof typeof ACHIEVEMENT_IDS];

export const STAT_IDS = {
  matchesCompleted: "MATCHES_COMPLETED",
  matchesWon: "MATCHES_WON",
  dailyDuelsCompleted: "DAILY_DUELS_COMPLETED",
} as const;

export type StatId = (typeof STAT_IDS)[keyof typeof STAT_IDS];

export const ACHIEVEMENT_TITLES: Record<AchievementId, string> = {
  FINISH_MATCH: "First Duel",
  WIN_MATCH: "Higher Score",
  CLAIM_THREE_HIGH_VALUE_NODES: "Triple Surge",
  WIN_CLASH_ON_ENEMY_PRIORITY: "Against the Odds",
  COMPLETE_DAILY_DUEL: "Daily Duelist",
};

const ALL_STAT_IDS = Object.values(STAT_IDS) as [StatId, ...StatId[]];

/** High-value nodes are the three-point pickups. */
export const HIGH_VALUE_NODES_REQUIRED = 3;

export type StatTotals = Record<StatId, number>;

export interface MatchMastery {
  achievements: AchievementId[];
  /** Added to the lifetime stats by this match. */
  statIncrements: StatTotals;
}

/**
 * What a finished match earns. Only completed Standard and Daily matches count:
 * the guided intro is a scripted tutorial, and an unfinished match earns nothing.
 */
export function evaluateMatchMastery(match: MatchState): MatchMastery | null {
  if (match.status !== "match-complete" || match.mode === "guided") {
    return null;
  }

  const won = match.winner === "player";
  const achievements: AchievementId[] = [ACHIEVEMENT_IDS.finishMatch];

  if (won) {
    achievements.push(ACHIEVEMENT_IDS.winMatch);
  }

  if (match.stats.playerThreePointPickupsCollected >= HIGH_VALUE_NODES_REQUIRED) {
    achievements.push(ACHIEVEMENT_IDS.claimThreeHighValueNodes);
  }

  if (match.stats.playerClashesWonOnRivalPriority >= 1) {
    achievements.push(ACHIEVEMENT_IDS.winClashOnEnemyPriority);
  }

  if (match.mode === "daily") {
    achievements.push(ACHIEVEMENT_IDS.completeDailyDuel);
  }

  return {
    achievements,
    statIncrements: {
      MATCHES_COMPLETED: 1,
      MATCHES_WON: won ? 1 : 0,
      DAILY_DUELS_COMPLETED: match.mode === "daily" ? 1 : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Local record of unlocks (what guests see, and what is re-sent to Wavedash)
// ---------------------------------------------------------------------------

export const MASTERY_STORAGE_KEY = "energy-duel.mastery.v1";

const KNOWN_ACHIEVEMENTS = new Set<string>(Object.values(ACHIEVEMENT_IDS));

export function loadUnlockedAchievements(storage: Storage | undefined): Set<AchievementId> {
  try {
    const parsed = JSON.parse(storage?.getItem(MASTERY_STORAGE_KEY) ?? "null");
    if (parsed?.schemaVersion === 1 && Array.isArray(parsed.unlocked)) {
      return new Set(
        parsed.unlocked.filter((id: unknown): id is AchievementId =>
          typeof id === "string" && KNOWN_ACHIEVEMENTS.has(id),
        ),
      );
    }
  } catch {
    // Unavailable storage or corrupt JSON: start empty, play on.
  }
  return new Set();
}

function saveUnlockedAchievements(storage: Storage | undefined, unlocked: Set<AchievementId>): void {
  try {
    storage?.setItem(
      MASTERY_STORAGE_KEY,
      JSON.stringify({ schemaVersion: 1, unlocked: [...unlocked].sort() }),
    );
  } catch {
    // Unlocks still show this session.
  }
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

/** `local`: guest or nothing to send. `saved`: Wavedash confirmed the write. */
export type MasterySyncState = "local" | "pending" | "saved" | "failed";

export interface MasteryProgressSink {
  commitProgress(request: ProgressRequest): Promise<ProgressCommitResult>;
}

export interface MasteryFeedback {
  /** Unlocked on this device for the first time by this match. */
  unlocked: AchievementId[];
  /** True when this match had already been recorded; nothing changed. */
  duplicate: boolean;
}

export interface MasteryTrackerOptions {
  sink: MasteryProgressSink;
  storage?: Storage;
  /** Delays between automatic retries of a failed write. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  onSyncState?: (state: MasterySyncState) => void;
}

const NEVER_RETRIED: ReadonlySet<ProgressUnavailableReason> = new Set([
  "guest",
  "signed-out",
  "sdk-error",
]);

export class MasteryTracker {
  private readonly unlocked: Set<AchievementId>;
  private readonly recorded = new Set<number | string>();
  private readonly increments: StatTotals = zeroTotals();
  /** Lifetime totals read once, before this session's first write. */
  private baseline: StatTotals | null = null;
  private running: Promise<void> | null = null;
  /** Bumped by each recorded match; a run repeats until it has sent the latest. */
  private version = 0;
  private state: MasterySyncState = "local";

  constructor(private readonly options: MasteryTrackerOptions) {
    this.unlocked = loadUnlockedAchievements(options.storage);
  }

  get syncState(): MasterySyncState {
    return this.state;
  }

  isUnlocked(id: AchievementId): boolean {
    return this.unlocked.has(id);
  }

  /** Counts a finished match once per `matchId`; repeat calls report `duplicate`. */
  recordMatch(matchId: number | string, match: MatchState): MasteryFeedback {
    const mastery = evaluateMatchMastery(match);

    if (!mastery || this.recorded.has(matchId)) {
      return { unlocked: [], duplicate: mastery !== null };
    }

    this.recorded.add(matchId);
    this.version += 1;
    for (const id of ALL_STAT_IDS) {
      this.increments[id] += mastery.statIncrements[id];
    }

    const unlocked = mastery.achievements.filter((id) => !this.unlocked.has(id));
    for (const id of unlocked) {
      this.unlocked.add(id);
    }
    if (unlocked.length > 0) {
      saveUnlockedAchievements(this.options.storage, this.unlocked);
    }

    void this.sync();
    return { unlocked, duplicate: false };
  }

  /**
   * Sends everything to Wavedash, retrying transient failures. Overlapping calls
   * share one run, which repeats only if more was recorded meanwhile. Stats are
   * written as baseline + this session's total, so a retry never double-counts.
   */
  sync(): Promise<void> {
    if (this.running) {
      return this.running;
    }

    this.running = (async () => {
      let sent: number;
      do {
        sent = this.version;
        await this.syncWithRetries();
      } while (sent !== this.version);
    })().finally(() => {
      this.running = null;
    });

    return this.running;
  }

  private async syncWithRetries(): Promise<void> {
    const delays = this.options.retryDelaysMs ?? [2_000, 8_000];
    const sleep = this.options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

    this.setState("pending");

    for (let attempt = 0; ; attempt += 1) {
      const result = await this.options.sink.commitProgress(this.buildRequest());

      if (result.status === "stored") {
        this.setState("saved");
        return;
      }

      const permanent =
        result.status === "unavailable" && NEVER_RETRIED.has(result.reason);
      if (permanent) {
        this.setState("local");
        return;
      }

      if (attempt >= delays.length) {
        this.setState("failed");
        return;
      }

      await sleep(delays[attempt]);
    }
  }

  private buildRequest(): ProgressRequest {
    return {
      statIds: ALL_STAT_IDS,
      build: (readStat) => {
        this.baseline ??= {
          MATCHES_COMPLETED: readStat(STAT_IDS.matchesCompleted),
          MATCHES_WON: readStat(STAT_IDS.matchesWon),
          DAILY_DUELS_COMPLETED: readStat(STAT_IDS.dailyDuelsCompleted),
        };
        const baseline = this.baseline;
        return {
          stats: Object.fromEntries(
            ALL_STAT_IDS.map((id) => [id, baseline[id] + this.increments[id]]),
          ),
          achievements: [...this.unlocked],
        };
      },
    };
  }

  private setState(state: MasterySyncState): void {
    if (this.state !== state) {
      this.state = state;
      this.options.onSyncState?.(state);
    }
  }
}

function zeroTotals(): StatTotals {
  return { MATCHES_COMPLETED: 0, MATCHES_WON: 0, DAILY_DUELS_COMPLETED: 0 };
}
