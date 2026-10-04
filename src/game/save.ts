import { MOVES } from "./constants";
import { dailySeed, isValidDailyDate } from "./daily";
import type { DailyAttempt } from "./daily";
import { getModeRules, getMovesForRound } from "./match-rules";
import type { MatchMode, Move } from "./types";

/**
 * The versioned save file (see docs/CLOUD_SAVE.md).
 *
 * One JSON document holds everything that should follow a player: audio
 * preferences, tutorial progress, local bests and an in-progress solo match.
 * It is stored in localStorage first and mirrored to one Wavedash cloud file.
 *
 * `version` is the schema. Add a migration for every bump; a file from a newer
 * schema is "unsupported" and is never overwritten.
 */
export const SAVE_FORMAT = "energy-duel.save";
export const SAVE_VERSION = 1;
export const SAVE_STORAGE_KEY = "energy-duel.save.v1";
/** Path of the cloud file, relative to the player's remote root. */
export const SAVE_CLOUD_PATH = "saves/progress.json";

/** Daily bests older than this many dates are dropped, so the file stays small. */
const MAX_DAILY_BESTS = 90;
const MAX_STANDARD_BESTS = 10;

export type TutorialOutcome = "completed" | "skipped";

export interface PreferencesSave {
  musicVolume: number;
  sfxVolume: number;
  muted: boolean;
}

export interface StandardBest {
  rulesVersion: number;
  playerScore: number;
  rivalScore: number;
  /** playerScore - rivalScore; the value bests are ranked by. */
  margin: number;
}

/**
 * A solo match at a round boundary. Only the player's committed queues are
 * stored: the board, rival and every score are re-derived by replaying them
 * through the same rules code (see resume.ts), so a save cannot hold a
 * state the game could not have reached. Mid-round state is never stored.
 */
export interface ResumableMatch {
  mode: Exclude<MatchMode, "guided">;
  seed: number;
  rulesVersion: number;
  /** Daily Duel only: the UTC start date, fixed for the whole attempt. */
  dailyDate?: string;
  /** One committed queue per completed round, in order. */
  playerQueues: Move[][];
}

/** A value and when it was last changed; the newer side wins a conflict. */
export interface Stamped<T> {
  value: T;
  /** Milliseconds since the epoch. */
  updatedAt: number;
}

export interface SaveData {
  format: typeof SAVE_FORMAT;
  version: number;
  /** Informational: when anything last changed. */
  savedAt: number;
  /** null until the player changes a setting; the game's defaults apply meanwhile. */
  preferences: Stamped<PreferencesSave | null>;
  progress: { onboardingSeen: boolean; tutorial: TutorialOutcome | null };
  bests: { standard: StandardBest[]; daily: DailyAttempt[] };
  inProgress: Stamped<ResumableMatch | null>;
}

export function createEmptySave(): SaveData {
  return {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    savedAt: 0,
    preferences: { value: null, updatedAt: 0 },
    progress: { onboardingSeen: false, tutorial: null },
    bests: { standard: [], daily: [] },
    inProgress: { value: null, updatedAt: 0 },
  };
}

// ---------------------------------------------------------------------------
// Parsing, validation and migration
// ---------------------------------------------------------------------------

export type SaveParseResult =
  | { status: "ok"; save: SaveData; migratedFrom: number | null }
  /** Not JSON, not ours, or structurally broken. Nothing in it is trusted. */
  | { status: "corrupt"; reason: string }
  /** Written by a newer schema than this build understands. */
  | { status: "unsupported"; version: number };

/** Upgrades a raw object from schema N to N + 1. Keyed by N. */
export type SaveMigration = (data: Record<string, unknown>) => Record<string, unknown>;

/** No migrations yet: v1 is the first schema. Every future bump adds one here. */
export const SAVE_MIGRATIONS: Record<number, SaveMigration> = {};

export function parseSave(
  text: string,
  migrations: Record<number, SaveMigration> = SAVE_MIGRATIONS,
  currentVersion: number = SAVE_VERSION,
): SaveParseResult {
  let data: unknown;

  try {
    data = JSON.parse(text);
  } catch {
    return { status: "corrupt", reason: "not valid JSON" };
  }

  if (!isRecord(data) || data.format !== SAVE_FORMAT) {
    return { status: "corrupt", reason: "not an Energy Duel save" };
  }

  const found = data.version;

  if (typeof found !== "number" || !Number.isInteger(found) || found < 1) {
    return { status: "corrupt", reason: "missing schema version" };
  }

  if (found > currentVersion) {
    return { status: "unsupported", version: found };
  }

  let upgraded: Record<string, unknown> = data;

  for (let version = found; version < currentVersion; version += 1) {
    const migrate = migrations[version];

    if (!migrate) {
      return { status: "corrupt", reason: `no migration from schema v${version}` };
    }

    try {
      upgraded = { ...migrate(upgraded), format: SAVE_FORMAT, version: version + 1 };
    } catch {
      return { status: "corrupt", reason: `migration from schema v${version} failed` };
    }
  }

  return {
    status: "ok",
    save: sanitizeSave(upgraded),
    migratedFrom: found < currentVersion ? found : null,
  };
}

export function serializeSave(save: SaveData): string {
  return JSON.stringify(save);
}

/**
 * Builds a clean SaveData from untrusted fields. Each section is checked on its
 * own: a bad section falls back to its default instead of discarding the file,
 * so one corrupt field cannot cost a player their other progress.
 */
function sanitizeSave(data: Record<string, unknown>): SaveData {
  const progress = isRecord(data.progress) ? data.progress : {};
  const bests = isRecord(data.bests) ? data.bests : {};

  return normalizeSave({
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    savedAt: timestamp(data.savedAt),
    preferences: stamped(data.preferences, parsePreferences),
    progress: {
      onboardingSeen: progress.onboardingSeen === true,
      tutorial:
        progress.tutorial === "completed" || progress.tutorial === "skipped"
          ? progress.tutorial
          : null,
    },
    bests: {
      standard: asArray(bests.standard).flatMap(parseStandardBest),
      daily: asArray(bests.daily).flatMap(parseDailyBest),
    },
    inProgress: stamped(data.inProgress, parseResumable),
  });
}

export function parsePreferences(value: unknown): PreferencesSave | null {
  if (!isRecord(value)) return null;
  const { musicVolume, sfxVolume, muted } = value;

  if (!isUnit(musicVolume) || !isUnit(sfxVolume) || typeof muted !== "boolean") return null;

  return { musicVolume, sfxVolume, muted };
}

function parseStandardBest(value: unknown): StandardBest[] {
  if (!isRecord(value)) return [];
  const { rulesVersion, playerScore, rivalScore } = value;

  if (!isCount(rulesVersion) || !isCount(playerScore) || !isCount(rivalScore)) return [];

  return [{ rulesVersion, playerScore, rivalScore, margin: playerScore - rivalScore }];
}

function parseDailyBest(value: unknown): DailyAttempt[] {
  if (!isRecord(value)) return [];
  const { date, rulesVersion, playerScore, rivalScore } = value;

  if (
    typeof date !== "string" ||
    !isValidDailyDate(date) ||
    !isCount(rulesVersion) ||
    !isCount(playerScore) ||
    !isCount(rivalScore)
  ) {
    return [];
  }

  return [{ date, rulesVersion, playerScore, rivalScore, margin: playerScore - rivalScore }];
}

/**
 * Structural check only. Whether the queues really replay to a reachable state
 * is decided by restoreMatch, which drops a save that does not.
 */
function parseResumable(value: unknown): ResumableMatch | null {
  if (!isRecord(value)) return null;
  const { mode, seed, rulesVersion, dailyDate, playerQueues } = value;

  if (
    (mode !== "standard" && mode !== "daily") ||
    typeof seed !== "number" ||
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > 0xffffffff ||
    !isCount(rulesVersion) ||
    !Array.isArray(playerQueues)
  ) {
    return null;
  }

  const rules = getModeRules(mode);

  // A resumable match has finished at least one round and not the last.
  if (playerQueues.length < 1 || playerQueues.length >= rules.totalRounds) return null;

  const queuesValid = playerQueues.every(
    (queue, index) =>
      Array.isArray(queue) &&
      queue.length === getMovesForRound(mode, index + 1) &&
      queue.every((move) => MOVES.includes(move as Move)),
  );

  if (!queuesValid) return null;

  if (mode === "daily") {
    // The date and rules version name the board; the seed must be theirs.
    if (
      typeof dailyDate !== "string" ||
      !isValidDailyDate(dailyDate) ||
      seed !== dailySeed(dailyDate, rulesVersion)
    ) {
      return null;
    }

    return { mode, seed, rulesVersion, dailyDate, playerQueues: playerQueues as Move[][] };
  }

  return { mode, seed, rulesVersion, playerQueues: playerQueues as Move[][] };
}

function stamped<T>(
  value: unknown,
  parse: (inner: unknown) => T | null,
): Stamped<T | null> {
  if (!isRecord(value)) return { value: null, updatedAt: 0 };

  return { value: parse(value.value), updatedAt: timestamp(value.updatedAt) };
}

// ---------------------------------------------------------------------------
// Conflict policy
// ---------------------------------------------------------------------------

/**
 * THE conflict policy. Used whenever local and cloud saves differ, in either
 * direction, and the result is written to both. It is deterministic and never
 * discards progress a player has earned:
 *
 *  - Earned progress only grows: onboardingSeen is OR-ed, a completed tutorial
 *    beats a skipped one, and each best keeps the better result.
 *  - Choices follow the newest change: preferences and the in-progress match
 *    are each taken whole from whichever side changed them most recently.
 *    Clearing the match (finishing or abandoning it) is a change, so a stale
 *    copy on another device cannot bring a finished match back.
 *  - A tie in time goes to `local`, the side that is running now.
 */
export function mergeSaves(local: SaveData, cloud: SaveData): SaveData {
  return normalizeSave({
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    savedAt: Math.max(local.savedAt, cloud.savedAt),
    preferences: newer(local.preferences, cloud.preferences),
    progress: {
      onboardingSeen: local.progress.onboardingSeen || cloud.progress.onboardingSeen,
      tutorial: mergeTutorial(local.progress.tutorial, cloud.progress.tutorial),
    },
    bests: {
      standard: bestBy(
        [...local.bests.standard, ...cloud.bests.standard],
        (best) => String(best.rulesVersion),
        (a, b) => a.margin > b.margin || (a.margin === b.margin && a.playerScore > b.playerScore),
      ),
      daily: bestBy(
        [...local.bests.daily, ...cloud.bests.daily],
        (best) => `${best.date}#${best.rulesVersion}`,
        (a, b) => a.margin > b.margin || (a.margin === b.margin && a.playerScore > b.playerScore),
      ),
    },
    inProgress: newer(local.inProgress, cloud.inProgress),
  });
}

function newer<T>(local: Stamped<T>, cloud: Stamped<T>): Stamped<T> {
  return cloud.updatedAt > local.updatedAt ? cloud : local;
}

function mergeTutorial(
  a: TutorialOutcome | null,
  b: TutorialOutcome | null,
): TutorialOutcome | null {
  return a === "completed" || b === "completed" ? "completed" : (a ?? b);
}

function bestBy<T>(items: T[], key: (item: T) => string, better: (a: T, b: T) => boolean): T[] {
  const best = new Map<string, T>();

  for (const item of items) {
    const current = best.get(key(item));

    if (!current || better(item, current)) best.set(key(item), item);
  }

  return [...best.values()];
}

/** Canonical ordering and size caps, so equal content always serializes equally. */
function normalizeSave(save: SaveData): SaveData {
  return {
    ...save,
    bests: {
      standard: [...save.bests.standard]
        .sort((a, b) => b.rulesVersion - a.rulesVersion)
        .slice(0, MAX_STANDARD_BESTS),
      daily: [...save.bests.daily]
        .sort((a, b) => (a.date === b.date ? b.rulesVersion - a.rulesVersion : b.date < a.date ? -1 : 1))
        .slice(0, MAX_DAILY_BESTS),
    },
  };
}

/** True when two saves hold the same data, ignoring the informational `savedAt`. */
export function sameSaveContent(a: SaveData, b: SaveData): boolean {
  return (
    JSON.stringify({ ...normalizeSave(a), savedAt: 0 }) ===
    JSON.stringify({ ...normalizeSave(b), savedAt: 0 })
  );
}

// ---------------------------------------------------------------------------
// Local edits
// ---------------------------------------------------------------------------

/** Adds a finished Standard match to the bests; returns the save unchanged if it is not a new best. */
export function withStandardBest(save: SaveData, best: Omit<StandardBest, "margin">): SaveData {
  const entry: StandardBest = { ...best, margin: best.playerScore - best.rivalScore };
  const merged = mergeSaves(save, {
    ...createEmptySave(),
    bests: { standard: [entry], daily: [] },
  });

  return sameSaveContent(merged, save) ? save : merged;
}

export function withDailyBest(save: SaveData, attempt: DailyAttempt): SaveData {
  const merged = mergeSaves(save, {
    ...createEmptySave(),
    bests: { standard: [], daily: [attempt] },
  });

  return sameSaveContent(merged, save) ? save : merged;
}

// ---------------------------------------------------------------------------
// Small validators
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 1_000_000;
}

function timestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}
