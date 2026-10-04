import { DAILY_HISTORY_KEY, bestDailyAttempt, loadDailyHistory } from "./daily";
import { readGuideOutcome } from "./onboarding-progress";
import {
  SAVE_CLOUD_PATH,
  parsePreferences,
  SAVE_STORAGE_KEY,
  createEmptySave,
  mergeSaves,
  parseSave,
  sameSaveContent,
  serializeSave,
  withDailyBest,
  withStandardBest,
} from "./save";
import type { PreferencesSave, ResumableMatch, SaveData, TutorialOutcome } from "./save";
import { AUDIO_SETTINGS_STORAGE_KEY, ONBOARDING_STORAGE_KEY } from "./storage-keys";
import type { DailyAttempt } from "./daily";

/** Where a corrupt cloud file is copied before the good save replaces it. */
export const SAVE_CLOUD_BACKUP_PATH = "saves/progress.corrupt.json";

export type CloudUnavailableReason = "guest" | "signed-out" | "sdk-error";

export type CloudReadResult =
  | { status: "found"; text: string }
  | { status: "missing" }
  | { status: "unavailable"; reason: CloudUnavailableReason }
  | { status: "failed"; message: string };

export type CloudWriteResult =
  | { status: "stored" }
  | { status: "unavailable"; reason: CloudUnavailableReason }
  | { status: "failed"; message: string };

/** The cloud-file slice of the Wavedash adapter (src/platform/wavedash.ts). */
export interface CloudFileStore {
  readFile(path: string): Promise<CloudReadResult>;
  writeFile(path: string, text: string): Promise<CloudWriteResult>;
}

export type SaveSyncState =
  /** Guest, signed out or no platform: the local save is all there is. */
  | "local-only"
  /** Signed in; nothing has gone to the cloud yet, or changes are waiting. */
  | "pending"
  | "syncing"
  /** The cloud file holds exactly the local save, as of the last attempt. */
  | "synced"
  /** The last attempt failed. The local save is intact; it retries. */
  | "failed"
  /** A file here or in the cloud is from a newer build, so nothing is overwritten. */
  | "blocked";

export type LoadStatus =
  | "empty" // nothing stored yet (legacy settings may still have been imported)
  | "ok"
  | "migrated" // upgraded from an older schema in memory
  | "corrupt" // unreadable; a copy was kept and a fresh save started
  | "unsupported" // from a newer build; left untouched, session runs in memory
  | "unavailable"; // no localStorage

/** Which parts of the save a cloud merge changed locally. */
export interface SaveChange {
  preferences: boolean;
  progress: boolean;
  dailyBests: boolean;
  inProgress: boolean;
}

export interface SaveManagerOptions {
  storage?: Pick<Storage, "getItem" | "setItem">;
  cloud: CloudFileStore;
  /** Resolves when the platform has finished starting (identity known). */
  ready?: () => Promise<unknown>;
  now?: () => number;
  /** Runs `callback` after `ms`; returns a canceller. Injectable for tests. */
  schedule?: (callback: () => void, ms: number) => () => void;
  /** Quiet time before a burst of changes goes to the cloud. */
  debounceMs?: number;
  /** Waits before each retry after a failed sync; no retry once exhausted. */
  retryDelaysMs?: readonly number[];
  /** A cloud merge changed the save; apply it to the live game. */
  onRemoteChange?: (save: SaveData, change: SaveChange) => void;
  onStateChange?: (state: SaveSyncState) => void;
  onWarning?: (message: string) => void;
}

const defaultSchedule = (callback: () => void, ms: number) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};

/**
 * Owns the player's save. The in-memory save is the truth during play; every
 * change is written to localStorage synchronously (so guests and offline play
 * keep it) and then mirrored to the cloud in the background. Nothing in here
 * is awaited by gameplay.
 *
 * Each cloud sync is read, merge, write (see mergeSaves), so a stale device
 * folds in what another device saved instead of overwriting it. Wavedash
 * offers no conditional write, so two devices syncing at the same instant can
 * still race; the loser's change is merged in again at its next sync.
 */
export class SaveManager {
  private save: SaveData = createEmptySave();
  private state: SaveSyncState = "pending";
  private loadStatus: LoadStatus = "empty";
  /** False once the stored local save is from a newer build: never overwrite it. */
  private localWritable = true;
  private cloudEnabled = true;
  private syncing = false;
  private dirty = false;
  private everSynced = false;
  private retryCount = 0;
  private cancelScheduled: (() => void) | null = null;

  constructor(private readonly options: SaveManagerOptions) {}

  get status(): LoadStatus {
    return this.loadStatus;
  }

  get syncState(): SaveSyncState {
    return this.state;
  }

  get current(): SaveData {
    return this.save;
  }

  /** Reads the local save (or imports the pre-save settings). Call once, synchronously, at startup. */
  load(): SaveData {
    const storage = this.options.storage;

    if (!storage) {
      this.loadStatus = "unavailable";
      this.localWritable = false;
      return this.save;
    }

    let raw: string | null = null;

    try {
      raw = storage.getItem(SAVE_STORAGE_KEY);
    } catch {
      this.loadStatus = "unavailable";
      this.localWritable = false;
      return this.save;
    }

    if (raw === null) {
      this.save = readLegacySave(storage as Storage, this.now());
      this.loadStatus = "empty";
      return this.save;
    }

    const parsed = parseSave(raw);

    if (parsed.status === "ok") {
      this.save = parsed.save;
      this.loadStatus = parsed.migratedFrom === null ? "ok" : "migrated";

      if (parsed.migratedFrom !== null) this.writeLocal();
    } else if (parsed.status === "unsupported") {
      this.loadStatus = "unsupported";
      this.localWritable = false;
      this.cloudEnabled = false;
      this.setState("blocked");
      this.warn(`Saved progress is from a newer version (schema v${parsed.version}); leaving it untouched.`);
    } else {
      // Keep the bytes for support or manual recovery, then start from what the old keys hold.
      this.stash(`${SAVE_STORAGE_KEY}.corrupt`, raw);
      this.save = readLegacySave(storage as Storage, this.now());
      this.loadStatus = "corrupt";
      this.writeLocal();
      this.warn(`Saved progress could not be read (${parsed.reason}); a copy was kept.`);
    }

    return this.save;
  }

  /** Begins cloud sync once the platform is ready. Never throws and never blocks play. */
  start(): void {
    this.requestSync(0);
  }

  /** Cloud sync right now (e.g. when the tab is hidden); resolves when this attempt ends. */
  async flush(): Promise<void> {
    this.cancelScheduled?.();
    this.cancelScheduled = null;
    await this.runSync();
  }

  // -- Local changes: each updates memory, writes local storage now, schedules the cloud ---

  setPreferences(preferences: PreferencesSave): void {
    this.update((save) => ({
      ...save,
      preferences: { value: preferences, updatedAt: this.now() },
    }));
  }

  markOnboardingSeen(): void {
    if (this.save.progress.onboardingSeen) return;
    this.update((save) => ({ ...save, progress: { ...save.progress, onboardingSeen: true } }));
  }

  recordTutorial(outcome: TutorialOutcome): void {
    // A completed tutorial is never downgraded to skipped.
    if (this.save.progress.tutorial === "completed" || this.save.progress.tutorial === outcome) {
      return;
    }
    this.update((save) => ({ ...save, progress: { ...save.progress, tutorial: outcome } }));
  }

  recordStandardBest(result: { rulesVersion: number; playerScore: number; rivalScore: number }): void {
    this.update((save) => withStandardBest(save, result));
  }

  recordDailyBest(attempt: DailyAttempt): void {
    this.update((save) => withDailyBest(save, attempt));
  }

  /** Saves the match at a round boundary, or clears it with null. A no-op when nothing changes. */
  setInProgress(match: ResumableMatch | null): void {
    if (match === null && this.save.inProgress.value === null) return;
    this.update((save) => ({ ...save, inProgress: { value: match, updatedAt: this.now() } }));
  }

  private update(change: (save: SaveData) => SaveData): void {
    const next = change(this.save);

    if (next === this.save) return;

    this.save = { ...next, savedAt: this.now() };
    this.writeLocal();

    if (this.cloudEnabled) {
      this.dirty = true;
      this.setStateIfIdle("pending");
      this.requestSync(this.options.debounceMs ?? 1500);
    }
  }

  // -- Cloud sync -----------------------------------------------------------------------

  private requestSync(delayMs: number): void {
    if (!this.cloudEnabled) return;

    this.cancelScheduled?.();
    this.cancelScheduled = (this.options.schedule ?? defaultSchedule)(() => {
      this.cancelScheduled = null;
      void this.runSync();
    }, delayMs);
  }

  private async runSync(): Promise<void> {
    if (this.syncing || !this.cloudEnabled) {
      // A change made mid-sync is picked up by the loop below.
      this.dirty = this.dirty || this.syncing;
      return;
    }

    this.syncing = true;

    try {
      await this.options.ready?.();

      do {
        this.dirty = false;
        if (!(await this.syncOnce())) break;
      } while (this.dirty);
    } catch (error) {
      this.failed(error instanceof Error ? error.message : String(error));
    } finally {
      this.syncing = false;
    }
  }

  /** One read, merge, write. False stops the loop (disabled, failed or blocked). */
  private async syncOnce(): Promise<boolean> {
    this.setState("syncing");
    const read = await this.options.cloud.readFile(SAVE_CLOUD_PATH);

    if (read.status === "unavailable") {
      return this.disableCloud();
    }

    if (read.status === "failed") {
      return this.failed(read.message);
    }

    let cloudSave: SaveData | null = null;
    let replaceUnreadable = false;

    if (read.status === "found") {
      const parsed = parseSave(read.text);

      if (parsed.status === "unsupported") {
        this.cloudEnabled = false;
        this.setState("blocked");
        this.warn(`Cloud save is from a newer version (schema v${parsed.version}); not overwriting it.`);
        return false;
      }

      if (parsed.status === "corrupt") {
        // Keep the unreadable file, then replace it with the local save below.
        replaceUnreadable = true;
        await this.options.cloud.writeFile(SAVE_CLOUD_BACKUP_PATH, read.text);
        this.warn(`Cloud save could not be read (${parsed.reason}); replacing it with the local save.`);
      } else {
        cloudSave = parsed.save;
      }
    }

    const before = this.save;
    const merged = cloudSave ? mergeSaves(before, cloudSave) : before;

    if (cloudSave && !sameSaveContent(merged, before)) {
      this.save = { ...merged };
      this.writeLocal();
      this.options.onRemoteChange?.(this.save, diffSaves(before, this.save));
    }

    // Skip the upload when the cloud already holds this, or there is nothing worth keeping.
    const cloudCurrent = cloudSave
      ? sameSaveContent(this.save, cloudSave)
      : !replaceUnreadable && sameSaveContent(this.save, createEmptySave());

    if (cloudCurrent) {
      this.synced();
      return true;
    }

    const written = await this.options.cloud.writeFile(SAVE_CLOUD_PATH, serializeSave(this.save));

    if (written.status === "unavailable") return this.disableCloud();
    if (written.status === "failed") return this.failed(written.message);

    this.synced();
    return true;
  }

  private synced(): void {
    this.everSynced = true;
    this.retryCount = 0;
    this.setState(this.dirty ? "pending" : "synced");
  }

  private failed(message: string): false {
    this.setState("failed");
    this.warn(`Cloud save sync failed: ${message}`);

    const delay = (this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS)[this.retryCount];

    if (delay !== undefined) {
      this.retryCount += 1;
      this.requestSync(delay);
    }

    return false;
  }

  private disableCloud(): false {
    this.cloudEnabled = false;
    this.setState("local-only");
    return false;
  }

  // -- Local storage -------------------------------------------------------------------

  private writeLocal(): void {
    if (!this.localWritable) return;

    try {
      this.options.storage?.setItem(SAVE_STORAGE_KEY, serializeSave(this.save));
    } catch {
      // Storage can be full or blocked; the save still lives in memory and the cloud.
    }
  }

  private stash(key: string, value: string): void {
    try {
      this.options.storage?.setItem(key, value);
    } catch {
      // Keeping a copy is best effort.
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private setState(state: SaveSyncState): void {
    if (state === this.state) return;
    this.state = state;
    this.options.onStateChange?.(state);
  }

  /** A pending change should not mask "syncing" or "blocked". */
  private setStateIfIdle(state: SaveSyncState): void {
    if (this.state === "syncing" || this.state === "blocked" || this.state === "local-only") return;
    this.setState(state);
  }

  private warn(message: string): void {
    (this.options.onWarning ?? ((text) => console.warn(`[Energy Duel] ${text}`)))(message);
  }

  /** Whether any cloud sync has completed this session; the UI says "synced" only after one. */
  get hasSyncedThisSession(): boolean {
    return this.everSynced;
  }
}

const DEFAULT_RETRY_DELAYS_MS = [5_000, 30_000, 120_000];

function diffSaves(before: SaveData, after: SaveData): SaveChange {
  const differs = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);

  return {
    preferences: differs(before.preferences, after.preferences),
    progress: differs(before.progress, after.progress),
    dailyBests: differs(before.bests.daily, after.bests.daily),
    inProgress: differs(before.inProgress, after.inProgress),
  };
}

/**
 * Schema v0: no save file yet, only the separate keys earlier builds wrote.
 * Imported once so existing players keep their settings, tutorial progress and
 * daily results when the save is first created. Imported settings are stamped 1,
 * so they beat "never set" in the cloud but lose to any real change.
 */
export function readLegacySave(storage: Storage, now: number): SaveData {
  const save = createEmptySave();

  try {
    const audio = parsePreferences(JSON.parse(storage.getItem(AUDIO_SETTINGS_STORAGE_KEY) ?? "null"));

    if (audio) save.preferences = { value: audio, updatedAt: 1 };
  } catch {
    // Unreadable legacy settings are simply not imported.
  }

  const guide = readGuideOutcome(storage);

  try {
    save.progress = {
      onboardingSeen: storage.getItem(ONBOARDING_STORAGE_KEY) === "true" || guide !== null,
      tutorial: guide,
    };
  } catch {
    // Same: start with defaults.
  }

  let result = save;

  try {
    // Reads the daily history without touching a corrupt copy's recovery copy twice.
    if (storage.getItem(DAILY_HISTORY_KEY) !== null) {
      const { history } = loadDailyHistory(storage);
      const seen = new Set<string>();

      for (const attempt of history.attempts) {
        const key = `${attempt.date}#${attempt.rulesVersion}`;

        if (seen.has(key)) continue;
        seen.add(key);

        const best = bestDailyAttempt(history, attempt.date, attempt.rulesVersion);

        if (best) result = withDailyBest(result, best);
      }
    }
  } catch {
    // Leave bests empty rather than block startup.
  }

  return result.savedAt === 0 && sameSaveContent(result, createEmptySave())
    ? result
    : { ...result, savedAt: now };
}
