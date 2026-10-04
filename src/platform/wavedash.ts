/**
 * Single entry point to the Wavedash platform SDK.
 *
 * `@wvdsh/sdk-js` throws when it is imported and `window.Wavedash` is missing
 * (local dev, itch.io), so the package is only ever loaded dynamically and only
 * when the host has injected the global. Guest play never depends on it.
 */

export type PlatformStatus = "pending" | "wavedash" | "guest" | "error";

export interface PlatformIdentity {
  signedIn: boolean;
  userId: string | null;
  username: string | null;
}

/** The slice of the SDK this adapter uses. */
export interface WavedashSdkLike {
  init(config?: { debug?: boolean }): boolean;
  getUserId(): string;
  getUsername(): string;
  requestStats(): Promise<unknown>;
  getStat(identifier: string): number;
  setStat(identifier: string, value: number, storeNow?: boolean): boolean;
  setAchievement(identifier: string, storeNow?: boolean): boolean;
  storeStats(): boolean;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void;
  /** Resolves an existing board by name; never creates one. */
  getLeaderboard(name: string): Promise<SdkResponse<{ id: string }>>;
  uploadLeaderboardScore(
    leaderboardId: never,
    score: number,
    keepBest: boolean,
    ugcId?: never,
    metadata?: Record<string, string | number | boolean>,
  ): Promise<SdkResponse<SdkUpsertedEntry>>;
  /** Cloud files: a local IndexedDB file is uploaded, or downloaded to one and then read. */
  writeLocalFile(filePath: string, data: Uint8Array): Promise<boolean>;
  readLocalFile(filePath: string): Promise<Uint8Array | null>;
  uploadRemoteFile(filePath: string): Promise<SdkResponse<string>>;
  downloadRemoteFile(filePath: string): Promise<SdkResponse<string>>;
  remoteFileExists(filePath: string): Promise<SdkResponse<boolean>>;
}

type SdkResponse<T> = { success: true; data: T } | { success: false; data: null; message: string };

interface SdkUpsertedEntry {
  /** Saved standing: the better of the old and new score under keepBest. */
  score: number;
  globalRank: number;
  /** This submission, even when keepBest kept an earlier run. */
  submittedScore: number;
  submittedRank: number;
}

/** Why a score could not be sent to Wavedash. */
export type LeaderboardUnavailableReason =
  | "guest"
  | "signed-out"
  | "sdk-error"
  | "board-missing"; // no board with that name exists (not provisioned)

export interface LeaderboardSubmitRequest {
  /** Board name; resolved to an ID before submitting. */
  name: string;
  score: number;
  metadata: Record<string, string | number | boolean>;
}

export type LeaderboardSubmitResult =
  | {
      status: "submitted";
      saved: { score: number; rank: number };
      submitted: { score: number; rank: number };
    }
  | { status: "unavailable"; reason: LeaderboardUnavailableReason }
  | { status: "failed"; message: string };

/** Why a progress write did not reach Wavedash. */
export type ProgressUnavailableReason =
  | "guest" // no Wavedash host: local or itch.io play
  | "signed-out" // hosted, but nobody is signed in
  | "sdk-error" // the SDK failed to load or initialise
  | "not-ready" // stats/achievements never loaded, or an identifier is not defined for this game
  | "rejected"; // the SDK refused a write for a defined identifier

export type ProgressCommitResult =
  | { status: "stored" }
  | { status: "unavailable"; reason: ProgressUnavailableReason }
  | { status: "failed"; message: string };

export interface ProgressWrite {
  stats: Record<string, number>;
  achievements: string[];
}

export interface ProgressRequest {
  /** Every stat identifier the write may touch; the first doubles as the readiness probe. */
  statIds: readonly [string, ...string[]];
  /**
   * Called only once stats and achievements have loaded, so `readStat` never
   * returns the SDK's pre-load default of 0.
   */
  build(readStat: (identifier: string) => number): ProgressWrite;
}

/** Why a cloud file could not be read or written. */
export type CloudFileUnavailableReason = "guest" | "signed-out" | "sdk-error";

export type CloudFileReadResult =
  | { status: "found"; text: string }
  | { status: "missing" }
  | { status: "unavailable"; reason: CloudFileUnavailableReason }
  | { status: "failed"; message: string };

export type CloudFileWriteResult =
  | { status: "stored" }
  | { status: "unavailable"; reason: CloudFileUnavailableReason }
  | { status: "failed"; message: string };

export interface WavedashAdapter {
  readonly status: PlatformStatus;
  /** Safe to call repeatedly; the SDK is initialised once. Never rejects. */
  initialize(): Promise<PlatformStatus>;
  getIdentity(): PlatformIdentity;
  /**
   * Waits for stats and achievements to load, writes, and resolves only once the
   * SDK reports the write stored. Never rejects. Safe to call again after any
   * non-"stored" result; an identical write that is already stored is a no-op.
   */
  commitProgress(request: ProgressRequest): Promise<ProgressCommitResult>;
  /**
   * Resolves the named board (never creating it), then submits with keepBest.
   * Resolves `submitted` only when Wavedash returned the entry. Never rejects.
   */
  submitLeaderboardScore(request: LeaderboardSubmitRequest): Promise<LeaderboardSubmitResult>;
  /**
   * Reads a text file from the signed-in player's cloud storage. `missing` means
   * the platform confirmed there is no such file. Never rejects.
   */
  readCloudFile(path: string): Promise<CloudFileReadResult>;
  /** Writes a text file and resolves `stored` only once the upload succeeded. Never rejects. */
  writeCloudFile(path: string, text: string): Promise<CloudFileWriteResult>;
}

export interface WavedashAdapterOptions {
  loadSdk?: () => Promise<WavedashSdkLike | null>;
  onError?: (error: unknown) => void;
  /** How long to wait for stats/achievements to load. */
  readyTimeoutMs?: number;
  readyPollMs?: number;
  /** How long to wait for the StatsStored confirmation. */
  storeTimeoutMs?: number;
}

const STATS_STORED_EVENT = "StatsStored";

const GUEST_IDENTITY: PlatformIdentity = {
  signedIn: false,
  userId: null,
  username: null,
};

async function loadInjectedSdk(): Promise<WavedashSdkLike | null> {
  if (typeof window === "undefined" || !(window as { Wavedash?: unknown }).Wavedash) {
    return null;
  }
  const module = await import("@wvdsh/sdk-js");
  return module.default;
}

export function createWavedashAdapter(
  options: WavedashAdapterOptions = {},
): WavedashAdapter {
  const loadSdk = options.loadSdk ?? loadInjectedSdk;
  const onError = options.onError ?? ((error) => console.warn("Wavedash unavailable", error));

  let status: PlatformStatus = "pending";
  let sdk: WavedashSdkLike | null = null;
  let starting: Promise<PlatformStatus> | null = null;
  const readyTimeoutMs = options.readyTimeoutMs ?? 10_000;
  const readyPollMs = options.readyPollMs ?? 250;
  const storeTimeoutMs = options.storeTimeoutMs ?? 8_000;

  let statsRequested: Promise<unknown> | null = null;
  let committing: Promise<unknown> = Promise.resolve();
  /** What Wavedash has confirmed stored in this session. */
  const confirmedStats = new Map<string, number>();
  const confirmedAchievements = new Set<string>();
  /** A failed store leaves SDK stats clean but unsaved, so stats are re-dirtied on the next try. */
  let lastStoreFailed = false;

  async function waitUntilReady(sdk: WavedashSdkLike, probe: string): Promise<boolean> {
    // Writing a stat its current value changes nothing, and is refused until
    // both stats and achievements have loaded and the identifier is defined.
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      if (sdk.setStat(probe, sdk.getStat(probe))) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, readyPollMs));
    }
  }

  function waitForStored(sdk: WavedashSdkLike): {
    stored: Promise<ProgressCommitResult>;
    dispose(): void;
  } {
    let listener: EventListenerOrEventListenerObject | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const dispose = () => {
      if (listener) sdk.removeEventListener(STATS_STORED_EVENT, listener);
      listener = null;
      clearTimeout(timer);
    };
    const stored = new Promise<ProgressCommitResult>((resolve) => {
      listener = (event) => {
        const detail = (event as CustomEvent<{ success?: boolean; message?: string }>).detail;
        dispose();
        resolve(
          detail?.success
            ? { status: "stored" }
            : { status: "failed", message: detail?.message ?? "Wavedash could not store progress" },
        );
      };
      sdk.addEventListener(STATS_STORED_EVENT, listener);
      timer = setTimeout(() => {
        dispose();
        resolve({ status: "failed", message: "Timed out waiting for Wavedash to store progress" });
      }, storeTimeoutMs);
    });
    return { stored, dispose };
  }

  async function commit(request: ProgressRequest): Promise<ProgressCommitResult> {
    const platformStatus = await adapter.initialize();
    if (platformStatus === "guest") return { status: "unavailable", reason: "guest" };
    if (platformStatus !== "wavedash" || !sdk) return { status: "unavailable", reason: "sdk-error" };
    if (!adapter.getIdentity().signedIn) return { status: "unavailable", reason: "signed-out" };

    try {
      statsRequested ??= sdk.requestStats().catch((error) => {
        statsRequested = null;
        throw error;
      });
      await statsRequested;

      if (!(await waitUntilReady(sdk, request.statIds[0]))) {
        return { status: "unavailable", reason: "not-ready" };
      }

      const write = request.build((identifier) => sdk!.getStat(identifier));
      const alreadyStored =
        !lastStoreFailed &&
        Object.entries(write.stats).every(([id, value]) => confirmedStats.get(id) === value) &&
        write.achievements.every((id) => confirmedAchievements.has(id));
      if (alreadyStored) return { status: "stored" };

      const awaiting = waitForStored(sdk);
      try {
        for (const [identifier, value] of Object.entries(write.stats)) {
          if (lastStoreFailed) sdk.setStat(identifier, value + 1);
          if (!sdk.setStat(identifier, value)) {
            awaiting.dispose();
            return { status: "unavailable", reason: "rejected" };
          }
        }
        for (const identifier of write.achievements) {
          if (!sdk.setAchievement(identifier)) {
            awaiting.dispose();
            return { status: "unavailable", reason: "rejected" };
          }
        }
        if (!sdk.storeStats()) {
          awaiting.dispose();
          return { status: "unavailable", reason: "not-ready" };
        }
      } catch (error) {
        awaiting.dispose();
        throw error;
      }

      const result = await awaiting.stored;
      lastStoreFailed = result.status !== "stored";
      if (result.status === "stored") {
        for (const [id, value] of Object.entries(write.stats)) confirmedStats.set(id, value);
        for (const id of write.achievements) confirmedAchievements.add(id);
      }
      return result;
    } catch (error) {
      lastStoreFailed = true;
      return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Board IDs resolved this session; failures are never cached, so a board opened later is found. */
  const boardIds = new Map<string, string>();

  async function submit(request: LeaderboardSubmitRequest): Promise<LeaderboardSubmitResult> {
    const platformStatus = await adapter.initialize();
    if (platformStatus === "guest") return { status: "unavailable", reason: "guest" };
    if (platformStatus !== "wavedash" || !sdk) return { status: "unavailable", reason: "sdk-error" };
    if (!adapter.getIdentity().signedIn) return { status: "unavailable", reason: "signed-out" };

    try {
      let boardId = boardIds.get(request.name);
      if (!boardId) {
        const board = await sdk.getLeaderboard(request.name);
        if (!board.success) {
          return /not.?found|does not exist|no leaderboard/i.test(board.message)
            ? { status: "unavailable", reason: "board-missing" }
            : { status: "failed", message: board.message };
        }
        boardId = board.data.id;
        boardIds.set(request.name, boardId);
      }

      const entry = await sdk.uploadLeaderboardScore(
        boardId as never,
        request.score,
        true,
        undefined,
        request.metadata,
      );
      if (!entry.success) return { status: "failed", message: entry.message };

      const { score, globalRank, submittedScore, submittedRank } = entry.data;
      return {
        status: "submitted",
        saved: { score, rank: globalRank },
        submitted: { score: submittedScore, rank: submittedRank },
      };
    } catch (error) {
      return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** One cloud-file operation at a time: they share the SDK's local copy of each file. */
  let cloudFiles: Promise<unknown> = Promise.resolve();

  function queueCloudFile<T>(operation: () => Promise<T>): Promise<T> {
    const result = cloudFiles.then(operation);
    cloudFiles = result.catch(() => undefined);
    return result;
  }

  async function cloudAvailability(): Promise<
    { ok: true; sdk: WavedashSdkLike } | { ok: false; reason: CloudFileUnavailableReason }
  > {
    const platformStatus = await adapter.initialize();
    if (platformStatus === "guest") return { ok: false, reason: "guest" };
    if (platformStatus !== "wavedash" || !sdk) return { ok: false, reason: "sdk-error" };
    if (!adapter.getIdentity().signedIn) return { ok: false, reason: "signed-out" };
    return { ok: true, sdk };
  }

  const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

  function readCloudFile(path: string): Promise<CloudFileReadResult> {
    return queueCloudFile(async () => {
      const available = await cloudAvailability();
      if (!available.ok) return { status: "unavailable", reason: available.reason };

      try {
        // The HEAD check is how "no file yet" is told apart from a failed download.
        const exists = await available.sdk.remoteFileExists(path);
        if (!exists.success) return { status: "failed", message: exists.message };
        if (!exists.data) return { status: "missing" };

        const downloaded = await available.sdk.downloadRemoteFile(path);
        if (!downloaded.success) return { status: "failed", message: downloaded.message };

        const bytes = await available.sdk.readLocalFile(downloaded.data || path);
        if (!bytes) return { status: "failed", message: "Downloaded cloud file could not be read" };

        return { status: "found", text: new TextDecoder().decode(bytes) };
      } catch (error) {
        return { status: "failed", message: errorMessage(error) };
      }
    });
  }

  function writeCloudFile(path: string, text: string): Promise<CloudFileWriteResult> {
    return queueCloudFile(async () => {
      const available = await cloudAvailability();
      if (!available.ok) return { status: "unavailable", reason: available.reason };

      try {
        if (!(await available.sdk.writeLocalFile(path, new TextEncoder().encode(text)))) {
          return { status: "failed", message: "Could not write the local copy of the cloud file" };
        }

        const uploaded = await available.sdk.uploadRemoteFile(path);
        return uploaded.success
          ? { status: "stored" }
          : { status: "failed", message: uploaded.message };
      } catch (error) {
        return { status: "failed", message: errorMessage(error) };
      }
    });
  }

  async function start(): Promise<PlatformStatus> {
    try {
      const loaded = await loadSdk();
      if (!loaded) {
        status = "guest";
        return status;
      }
      loaded.init();
      sdk = loaded;
      status = "wavedash";
    } catch (error) {
      sdk = null;
      status = "error";
      onError(error);
    }
    return status;
  }

  const adapter: WavedashAdapter = {
    get status() {
      return status;
    },
    commitProgress(request) {
      // One write at a time: the SDK keeps a single in-flight store.
      const result = committing.then(() => commit(request));
      committing = result.catch(() => undefined);
      return result;
    },
    submitLeaderboardScore: submit,
    readCloudFile,
    writeCloudFile,
    initialize() {
      starting ??= start();
      return starting;
    },
    getIdentity() {
      if (!sdk) return GUEST_IDENTITY;
      try {
        const userId = sdk.getUserId();
        if (!userId) return GUEST_IDENTITY;
        return { signedIn: true, userId, username: sdk.getUsername() || null };
      } catch {
        return GUEST_IDENTITY;
      }
    },
  };
  return adapter;
}

export const wavedash = createWavedashAdapter();
