import { describe, expect, it, vi } from "vitest";

import { AUDIO_SETTINGS_STORAGE_KEY, ONBOARDING_STORAGE_KEY } from "./storage-keys";
import { DAILY_HISTORY_KEY } from "./daily";
import { GUIDE_OUTCOME_STORAGE_KEY } from "./onboarding-progress";
import {
  SAVE_CLOUD_PATH,
  SAVE_FORMAT,
  SAVE_STORAGE_KEY,
  SAVE_VERSION,
  createEmptySave,
  parseSave,
  serializeSave,
} from "./save";
import type { ResumableMatch, SaveData } from "./save";
import { SAVE_CLOUD_BACKUP_PATH, SaveManager } from "./save-sync";
import type {
  CloudFileStore,
  CloudReadResult,
  CloudWriteResult,
  SaveChange,
  SaveManagerOptions,
} from "./save-sync";

const QUEUE = ["up", "up", "right", "right", "wait", "down", "left", "wait"] as const;

function match(seed = 7): ResumableMatch {
  return { mode: "standard", seed, rulesVersion: 1, playerQueues: [[...QUEUE]] };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

/** An in-memory stand-in for the player's cloud file with scriptable failures. */
function fakeCloud(initial?: string) {
  const files = new Map<string, string>(initial === undefined ? [] : [[SAVE_CLOUD_PATH, initial]]);
  const cloud = {
    files,
    reads: 0,
    writes: 0,
    readResult: null as CloudReadResult | null,
    writeResult: null as CloudWriteResult | null,
    /** When set, writes wait for this promise: a sync "in flight". */
    gate: null as Promise<void> | null,
    async readFile(path: string): Promise<CloudReadResult> {
      cloud.reads += 1;
      if (cloud.readResult) return cloud.readResult;
      const text = files.get(path);
      return text === undefined ? { status: "missing" } : { status: "found", text };
    },
    async writeFile(path: string, text: string): Promise<CloudWriteResult> {
      cloud.writes += 1;
      await cloud.gate;
      if (cloud.writeResult && path === SAVE_CLOUD_PATH) return cloud.writeResult;
      files.set(path, text);
      return { status: "stored" };
    },
  };
  return cloud satisfies CloudFileStore & Record<string, unknown>;
}

function manualTimers() {
  const pending: Array<{ callback: () => void; ms: number; cancelled: boolean }> = [];
  return {
    pending,
    schedule(callback: () => void, ms: number) {
      const entry = { callback, ms, cancelled: false };
      pending.push(entry);
      return () => void (entry.cancelled = true);
    },
    /** Runs everything currently scheduled, in order. */
    async fire() {
      const due = pending.splice(0).filter((entry) => !entry.cancelled);
      for (const entry of due) entry.callback();
      await settle();
    },
  };
}

async function settle() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

function setup(
  options: {
    storage?: ReturnType<typeof memoryStorage> | undefined;
    cloud?: ReturnType<typeof fakeCloud>;
    now?: () => number;
  } & Partial<SaveManagerOptions> = {},
) {
  const timers = manualTimers();
  const cloud = options.cloud ?? fakeCloud();
  const storage = "storage" in options ? options.storage : memoryStorage();
  const changes: Array<{ save: SaveData; change: SaveChange }> = [];
  const states: string[] = [];
  const warnings: string[] = [];
  const manager = new SaveManager({
    storage,
    cloud,
    schedule: timers.schedule,
    now: options.now ?? (() => 1_000),
    onRemoteChange: (save, change) => changes.push({ save, change }),
    onStateChange: (state) => states.push(state),
    onWarning: (message) => warnings.push(message),
    ...options,
  });
  return { manager, cloud, storage, timers, changes, states, warnings };
}

function withContent(overrides: Partial<SaveData>): SaveData {
  return { ...createEmptySave(), savedAt: 500, ...overrides };
}

describe("local-only play", () => {
  it("persists every change to localStorage immediately, with no cloud at all", () => {
    const storage = memoryStorage();
    const { manager } = setup({ storage });

    manager.load();
    manager.markOnboardingSeen();
    manager.recordTutorial("completed");
    manager.setInProgress(match());

    const stored = parseSave(storage.data.get(SAVE_STORAGE_KEY) ?? "");
    expect(stored.status).toBe("ok");
    if (stored.status !== "ok") return;
    expect(stored.save.progress).toEqual({ onboardingSeen: true, tutorial: "completed" });
    expect(stored.save.inProgress.value).toEqual(match());
  });

  it("survives a reload: a new manager reads back what the old one wrote", () => {
    const storage = memoryStorage();
    const first = setup({ storage }).manager;

    first.load();
    first.setInProgress(match(42));

    const second = setup({ storage }).manager;
    second.load();

    expect(second.current.inProgress.value?.seed).toBe(42);
    expect(second.status).toBe("ok");
  });

  it("goes local-only for a guest and never retries", async () => {
    const cloud = fakeCloud();
    cloud.readResult = { status: "unavailable", reason: "guest" };
    const { manager, timers } = setup({ cloud });

    manager.load();
    manager.start();
    await timers.fire();
    manager.setInProgress(match());

    expect(manager.syncState).toBe("local-only");
    expect(timers.pending.filter((entry) => !entry.cancelled)).toHaveLength(0);
    expect(cloud.reads).toBe(1);
    expect(cloud.writes).toBe(0);
  });

  it("works with no localStorage at all", () => {
    const { manager } = setup({ storage: undefined });

    expect(manager.load()).toEqual(createEmptySave());
    expect(() => manager.setInProgress(match())).not.toThrow();
    expect(manager.status).toBe("unavailable");
    expect(manager.current.inProgress.value).toEqual(match());
  });

  it("keeps the save in memory when localStorage throws on write", () => {
    const storage = memoryStorage();
    storage.setItem = () => {
      throw new Error("quota");
    };
    const { manager } = setup({ storage });

    manager.load();

    expect(() => manager.recordTutorial("skipped")).not.toThrow();
    expect(manager.current.progress.tutorial).toBe("skipped");
  });
});

describe("cloud success", () => {
  it("uploads the first save when the cloud has none, after a debounce, without blocking the change", async () => {
    const { manager, cloud, timers } = setup();

    manager.load();
    manager.setInProgress(match());

    // The change returned already; nothing has touched the cloud yet.
    expect(cloud.writes).toBe(0);
    expect(timers.pending.at(-1)?.ms).toBe(1500);

    await timers.fire();

    const uploaded = parseSave(cloud.files.get(SAVE_CLOUD_PATH) ?? "");
    expect(uploaded.status === "ok" && uploaded.save.inProgress.value).toEqual(match());
    expect(manager.syncState).toBe("synced");
    expect(manager.hasSyncedThisSession).toBe(true);
  });

  it("coalesces a burst of changes into one upload", async () => {
    const { manager, cloud, timers } = setup();

    manager.load();
    for (let i = 0; i < 6; i += 1) {
      manager.setPreferences({ musicVolume: i / 10, sfxVolume: 1, muted: false });
    }
    await timers.fire();

    expect(cloud.writes).toBe(1);
    const uploaded = parseSave(cloud.files.get(SAVE_CLOUD_PATH) ?? "");
    expect(uploaded.status === "ok" && uploaded.save.preferences.value?.musicVolume).toBe(0.5);
  });

  it("does not upload when the cloud already holds the same data", async () => {
    const save = withContent({ progress: { onboardingSeen: true, tutorial: null } });
    const cloud = fakeCloud(serializeSave(save));
    const storage = memoryStorage({ [SAVE_STORAGE_KEY]: serializeSave(save) });
    const { manager, timers } = setup({ cloud, storage });

    manager.load();
    manager.start();
    await timers.fire();

    expect(cloud.writes).toBe(0);
    expect(manager.syncState).toBe("synced");
  });

  it("re-syncs when the save changes while an upload is in flight", async () => {
    const cloud = fakeCloud();
    let release!: () => void;
    cloud.gate = new Promise<void>((resolve) => (release = resolve));
    const { manager, timers } = setup({ cloud });

    manager.load();
    manager.recordTutorial("skipped");
    await timers.fire(); // upload now waiting on the gate
    manager.setInProgress(match()); // a round finishes mid-upload
    cloud.gate = null;
    release();
    await settle();
    await timers.fire();
    await settle();

    const uploaded = parseSave(cloud.files.get(SAVE_CLOUD_PATH) ?? "");
    expect(uploaded.status === "ok" && uploaded.save.inProgress.value).toEqual(match());
    expect(manager.syncState).toBe("synced");
  });
});

describe("cloud failure", () => {
  it("keeps the local save, reports failed, and retries with backoff until it works", async () => {
    const cloud = fakeCloud();
    cloud.writeResult = { status: "failed", message: "network down" };
    const { manager, timers, warnings } = setup({ cloud, retryDelaysMs: [10, 20] });

    manager.load();
    manager.setInProgress(match());
    await timers.fire();

    expect(manager.syncState).toBe("failed");
    expect(warnings[0]).toContain("network down");
    expect(timers.pending.at(-1)?.ms).toBe(10);

    cloud.writeResult = null; // network back
    await timers.fire();

    expect(manager.syncState).toBe("synced");
    expect(cloud.files.has(SAVE_CLOUD_PATH)).toBe(true);
  });

  it("stops retrying after the delays run out, but the next change tries again", async () => {
    const cloud = fakeCloud();
    cloud.readResult = { status: "failed", message: "503" };
    const { manager, timers } = setup({ cloud, retryDelaysMs: [10] });

    manager.load();
    manager.start();
    await timers.fire(); // fails, schedules the one retry
    await timers.fire(); // retry fails, none left

    expect(timers.pending.filter((entry) => !entry.cancelled)).toHaveLength(0);
    expect(manager.syncState).toBe("failed");

    manager.setInProgress(match());
    expect(timers.pending.filter((entry) => !entry.cancelled)).toHaveLength(1);
  });

  it("treats a thrown error like a failure", async () => {
    const cloud = fakeCloud();
    cloud.readFile = async () => {
      throw new Error("boom");
    };
    const { manager, timers } = setup({ cloud });

    manager.load();
    manager.start();
    await timers.fire();

    expect(manager.syncState).toBe("failed");
  });
});

describe("stale saves and conflicts", () => {
  it("a stale device folds in the newer cloud save instead of overwriting it", async () => {
    const stale = withContent({
      preferences: { value: { musicVolume: 0.1, sfxVolume: 1, muted: false }, updatedAt: 100 },
      inProgress: { value: match(1), updatedAt: 100 },
    });
    const fresh = withContent({
      preferences: { value: { musicVolume: 0.8, sfxVolume: 1, muted: false }, updatedAt: 900 },
      inProgress: { value: match(2), updatedAt: 900 },
      progress: { onboardingSeen: true, tutorial: "completed" },
    });
    const cloud = fakeCloud(serializeSave(fresh));
    const storage = memoryStorage({ [SAVE_STORAGE_KEY]: serializeSave(stale) });
    const { manager, timers, changes } = setup({ cloud, storage });

    manager.load();
    manager.start();
    await timers.fire();

    expect(manager.current.inProgress.value?.seed).toBe(2);
    expect(manager.current.preferences.value?.musicVolume).toBe(0.8);
    expect(manager.current.progress.tutorial).toBe("completed");
    expect(changes).toHaveLength(1);
    expect(changes[0].change).toEqual({
      preferences: true,
      progress: true,
      dailyBests: false,
      inProgress: true,
    });
    // The merged result is written locally too, and the cloud (already newest) is untouched.
    expect(parseSave(storage.data.get(SAVE_STORAGE_KEY) ?? "")).toMatchObject({
      status: "ok",
      save: { inProgress: { value: { seed: 2 } } },
    });
    expect(cloud.writes).toBe(0);
  });

  it("a newer local save wins and is pushed to the stale cloud file", async () => {
    const cloudSave = withContent({ inProgress: { value: match(1), updatedAt: 100 } });
    const localSave = withContent({ inProgress: { value: match(2), updatedAt: 900 } });
    const cloud = fakeCloud(serializeSave(cloudSave));
    const storage = memoryStorage({ [SAVE_STORAGE_KEY]: serializeSave(localSave) });
    const { manager, timers, changes } = setup({ cloud, storage });

    manager.load();
    manager.start();
    await timers.fire();

    const uploaded = parseSave(cloud.files.get(SAVE_CLOUD_PATH) ?? "");
    expect(uploaded.status === "ok" && uploaded.save.inProgress.value?.seed).toBe(2);
    expect(changes).toHaveLength(0);
  });

  it("merges divergent earned progress from both sides and writes it to both", async () => {
    const cloudSave = withContent({
      bests: {
        standard: [{ rulesVersion: 1, playerScore: 9, rivalScore: 1, margin: 8 }],
        daily: [],
      },
    });
    const localSave = withContent({
      progress: { onboardingSeen: true, tutorial: "skipped" },
      bests: {
        standard: [{ rulesVersion: 1, playerScore: 4, rivalScore: 3, margin: 1 }],
        daily: [{ date: "2026-10-04", rulesVersion: 1, playerScore: 7, rivalScore: 5, margin: 2 }],
      },
    });
    const cloud = fakeCloud(serializeSave(cloudSave));
    const storage = memoryStorage({ [SAVE_STORAGE_KEY]: serializeSave(localSave) });
    const { manager, timers } = setup({ cloud, storage });

    manager.load();
    manager.start();
    await timers.fire();

    const uploaded = parseSave(cloud.files.get(SAVE_CLOUD_PATH) ?? "");
    expect(uploaded.status).toBe("ok");
    if (uploaded.status !== "ok") return;
    expect(uploaded.save.bests.standard[0].margin).toBe(8);
    expect(uploaded.save.bests.daily).toHaveLength(1);
    expect(uploaded.save.progress.tutorial).toBe("skipped");
    expect(manager.current.bests.standard[0].margin).toBe(8);
  });

  it("a match finished on another device stays finished", async () => {
    const cloudSave = withContent({ inProgress: { value: null, updatedAt: 900 } });
    const localSave = withContent({ inProgress: { value: match(), updatedAt: 100 } });
    const cloud = fakeCloud(serializeSave(cloudSave));
    const storage = memoryStorage({ [SAVE_STORAGE_KEY]: serializeSave(localSave) });
    const { manager, timers } = setup({ cloud, storage });

    manager.load();
    manager.start();
    await timers.fire();

    expect(manager.current.inProgress.value).toBeNull();
  });

  it("re-reads the cloud on every sync, so a change made elsewhere meanwhile is merged, not clobbered", async () => {
    const cloud = fakeCloud();
    const { manager, timers } = setup({ cloud });

    manager.load();
    manager.recordTutorial("skipped");
    await timers.fire();

    // Another device uploads a bigger save.
    cloud.files.set(
      SAVE_CLOUD_PATH,
      serializeSave(withContent({ progress: { onboardingSeen: true, tutorial: "completed" } })),
    );
    manager.setInProgress(match());
    await timers.fire();

    const uploaded = parseSave(cloud.files.get(SAVE_CLOUD_PATH) ?? "");
    expect(uploaded.status).toBe("ok");
    if (uploaded.status !== "ok") return;
    expect(uploaded.save.progress.tutorial).toBe("completed");
    expect(uploaded.save.inProgress.value).toEqual(match());
  });
});

describe("corrupt and unsupported files", () => {
  it("recovers from a corrupt local save: keeps a copy, imports legacy keys, keeps playing", () => {
    const storage = memoryStorage({
      [SAVE_STORAGE_KEY]: "{this is not json",
      [GUIDE_OUTCOME_STORAGE_KEY]: "completed",
    });
    const { manager, warnings } = setup({ storage });

    manager.load();

    expect(manager.status).toBe("corrupt");
    expect(storage.data.get(`${SAVE_STORAGE_KEY}.corrupt`)).toBe("{this is not json");
    expect(manager.current.progress.tutorial).toBe("completed");
    expect(parseSave(storage.data.get(SAVE_STORAGE_KEY) ?? "").status).toBe("ok");
    expect(warnings[0]).toContain("could not be read");
  });

  it("leaves a local save from a newer build untouched and never syncs over it", async () => {
    const newer = JSON.stringify({ format: SAVE_FORMAT, version: SAVE_VERSION + 1, future: true });
    const storage = memoryStorage({ [SAVE_STORAGE_KEY]: newer });
    const { manager, cloud, timers } = setup({ storage });

    manager.load();
    manager.setInProgress(match());
    manager.start();
    await timers.fire();

    expect(manager.status).toBe("unsupported");
    expect(manager.syncState).toBe("blocked");
    expect(storage.data.get(SAVE_STORAGE_KEY)).toBe(newer);
    expect(cloud.writes).toBe(0);
    // Still playable this session.
    expect(manager.current.inProgress.value).toEqual(match());
  });

  it("replaces a corrupt cloud file with the local save after backing the bad bytes up", async () => {
    const cloud = fakeCloud("<<<garbage>>>");
    const { manager, timers, warnings } = setup({ cloud });

    manager.load();
    manager.recordTutorial("completed");
    await timers.fire();

    expect(cloud.files.get(SAVE_CLOUD_BACKUP_PATH)).toBe("<<<garbage>>>");
    const uploaded = parseSave(cloud.files.get(SAVE_CLOUD_PATH) ?? "");
    expect(uploaded.status === "ok" && uploaded.save.progress.tutorial).toBe("completed");
    expect(warnings.some((warning) => warning.includes("Cloud save could not be read"))).toBe(true);
    expect(manager.syncState).toBe("synced");
  });

  it("replaces a corrupt cloud file even when the local save is still empty", async () => {
    const cloud = fakeCloud("not json");
    const { manager, timers } = setup({ cloud });

    manager.load();
    manager.start();
    await timers.fire();

    expect(parseSave(cloud.files.get(SAVE_CLOUD_PATH) ?? "").status).toBe("ok");
  });

  it("never overwrites a cloud save from a newer build", async () => {
    const newer = JSON.stringify({ format: SAVE_FORMAT, version: SAVE_VERSION + 1 });
    const cloud = fakeCloud(newer);
    const { manager, timers } = setup({ cloud });

    manager.load();
    manager.recordTutorial("completed");
    await timers.fire();
    manager.recordTutorial("completed");
    manager.setInProgress(match());
    await timers.fire();

    expect(cloud.files.get(SAVE_CLOUD_PATH)).toBe(newer);
    expect(cloud.writes).toBe(0);
    expect(manager.syncState).toBe("blocked");
    expect(manager.current.progress.tutorial).toBe("completed");
  });
});

describe("first run: importing the pre-save keys (schema v0)", () => {
  it("builds the save from audio, onboarding, tutorial and daily history keys", () => {
    const storage = memoryStorage({
      [AUDIO_SETTINGS_STORAGE_KEY]: JSON.stringify({ musicVolume: 0.3, sfxVolume: 0.6, muted: true }),
      [ONBOARDING_STORAGE_KEY]: "true",
      [GUIDE_OUTCOME_STORAGE_KEY]: "skipped",
      [DAILY_HISTORY_KEY]: JSON.stringify({
        schemaVersion: 1,
        attempts: [
          { date: "2026-10-03", rulesVersion: 1, playerScore: 5, rivalScore: 5 },
          { date: "2026-10-03", rulesVersion: 1, playerScore: 9, rivalScore: 2 },
          { date: "2026-10-04", rulesVersion: 1, playerScore: 1, rivalScore: 8 },
        ],
      }),
    });
    const { manager } = setup({ storage });

    manager.load();

    expect(manager.current.preferences.value).toEqual({ musicVolume: 0.3, sfxVolume: 0.6, muted: true });
    expect(manager.current.preferences.updatedAt).toBe(1);
    expect(manager.current.progress).toEqual({ onboardingSeen: true, tutorial: "skipped" });
    expect(manager.current.bests.daily.map((best) => [best.date, best.margin])).toEqual([
      ["2026-10-04", -7],
      ["2026-10-03", 7],
    ]);
  });

  it("uploads imported legacy progress on the first signed-in session", async () => {
    const storage = memoryStorage({ [ONBOARDING_STORAGE_KEY]: "true" });
    const { manager, cloud, timers } = setup({ storage });

    manager.load();
    manager.start();
    await timers.fire();

    const uploaded = parseSave(cloud.files.get(SAVE_CLOUD_PATH) ?? "");
    expect(uploaded.status === "ok" && uploaded.save.progress.onboardingSeen).toBe(true);
  });

  it("ignores unreadable legacy values without failing", () => {
    const storage = memoryStorage({
      [AUDIO_SETTINGS_STORAGE_KEY]: "{{",
      [DAILY_HISTORY_KEY]: "garbage",
    });
    const { manager } = setup({ storage });

    expect(() => manager.load()).not.toThrow();
    expect(manager.current.preferences.value).toBeNull();
  });

  it("does not upload an empty save for a brand-new player", async () => {
    const { manager, cloud, timers } = setup();

    manager.load();
    manager.start();
    await timers.fire();

    expect(cloud.writes).toBe(0);
    expect(manager.syncState).toBe("synced");
  });
});

describe("change helpers", () => {
  it("does not downgrade a completed tutorial and skips no-op writes", () => {
    const storage = memoryStorage();
    const { manager } = setup({ storage });
    manager.load();

    manager.recordTutorial("completed");
    const writes = vi.spyOn(storage, "setItem");
    manager.recordTutorial("skipped");
    manager.recordTutorial("completed");
    manager.markOnboardingSeen();
    manager.markOnboardingSeen();
    manager.setInProgress(null);

    expect(manager.current.progress.tutorial).toBe("completed");
    expect(writes).toHaveBeenCalledTimes(1); // only the first markOnboardingSeen
  });

  it("clears the in-progress match with a newer stamp so the clear wins a conflict", () => {
    let clock = 100;
    const { manager } = setup({ now: () => clock });
    manager.load();

    manager.setInProgress(match());
    clock = 200;
    manager.setInProgress(null);

    expect(manager.current.inProgress).toEqual({ value: null, updatedAt: 200 });
  });
});
