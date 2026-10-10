import { describe, expect, it, vi } from "vitest";

import { createWavedashAdapter, type WavedashSdkLike } from "./wavedash";

function fakeSdk(overrides: Partial<WavedashSdkLike> = {}): WavedashSdkLike & {
  init: ReturnType<typeof vi.fn>;
} {
  return {
    init: vi.fn(() => true),
    getUserId: () => "user-1",
    getUsername: () => "Rory",
    requestStats: async () => true,
    getStat: () => 0,
    setStat: () => true,
    setAchievement: () => true,
    storeStats: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
    getLeaderboard: async () => ({ success: true, data: { id: "board-1" } }),
    uploadLeaderboardScore: async () => ({
      success: true,
      data: { score: 4, globalRank: 2, submittedScore: 4, submittedRank: 2 },
    }),
    writeLocalFile: async () => true,
    readLocalFile: async () => null,
    uploadRemoteFile: async (path: string) => ({ success: true, data: path }),
    downloadRemoteFile: async (path: string) => ({ success: true, data: path }),
    remoteFileExists: async () => ({ success: true, data: true }),
    ...overrides,
  } as WavedashSdkLike & { init: ReturnType<typeof vi.fn> };
}

describe("wavedash adapter", () => {
  it("runs as a guest when the SDK is absent", async () => {
    const adapter = createWavedashAdapter({ loadSdk: async () => null });
    expect(adapter.status).toBe("pending");
    await expect(adapter.initialize()).resolves.toBe("guest");
    expect(adapter.status).toBe("guest");
    expect(adapter.getIdentity()).toEqual({
      signedIn: false,
      userId: null,
      username: null,
    });
  });

  it("initialises the SDK exactly once however often it is called", async () => {
    const sdk = fakeSdk();
    const loadSdk = vi.fn(async () => sdk);
    const adapter = createWavedashAdapter({ loadSdk });
    await Promise.all([adapter.initialize(), adapter.initialize()]);
    await adapter.initialize();
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(loadSdk).toHaveBeenCalledTimes(1);
    expect(adapter.status).toBe("wavedash");
  });

  it("exposes the signed-in identity", async () => {
    const adapter = createWavedashAdapter({ loadSdk: async () => fakeSdk() });
    await adapter.initialize();
    expect(adapter.getIdentity()).toEqual({
      signedIn: true,
      userId: "user-1",
      username: "Rory",
    });
  });

  it("treats an empty user id as a guest inside Wavedash", async () => {
    const adapter = createWavedashAdapter({
      loadSdk: async () => fakeSdk({ getUserId: () => "" }),
    });
    await adapter.initialize();
    expect(adapter.getIdentity().signedIn).toBe(false);
  });

  it("falls back to guest identity if identity lookups throw", async () => {
    const adapter = createWavedashAdapter({
      loadSdk: async () =>
        fakeSdk({
          getUserId: () => {
            throw new Error("nope");
          },
        }),
    });
    await adapter.initialize();
    expect(adapter.status).toBe("wavedash");
    expect(adapter.getIdentity().signedIn).toBe(false);
  });

  it("reports startup errors without throwing and keeps guest play working", async () => {
    const onError = vi.fn();
    const adapter = createWavedashAdapter({
      loadSdk: async () =>
        fakeSdk({
          init: vi.fn(() => {
            throw new Error("boom");
          }),
        }),
      onError,
    });
    await expect(adapter.initialize()).resolves.toBe("error");
    expect(onError).toHaveBeenCalledOnce();
    expect(adapter.getIdentity().signedIn).toBe(false);
  });

  it("reports SDK load failures as errors", async () => {
    const adapter = createWavedashAdapter({
      loadSdk: async () => {
        throw new Error("chunk failed");
      },
      onError: () => {},
    });
    await expect(adapter.initialize()).resolves.toBe("error");
  });
});

describe("wavedash adapter progress", () => {
  /** A stats SDK whose loading, definitions and store results the test controls. */
  function statsSdk(options: { readyAfterPolls?: number; knownIds?: string[]; storeResult?: "ok" | "fail" | "silent" } = {}) {
    const { readyAfterPolls = 0, knownIds = ["A", "B", "WIN"], storeResult = "ok" } = options;
    const stats = new Map<string, number>([["A", 4]]);
    const achievements = new Set<string>();
    const listeners = new Set<EventListenerOrEventListenerObject>();
    let polls = 0;
    const events: string[] = [];
    const ready = () => polls > readyAfterPolls;
    const sdk = fakeSdk({
      getStat: (id) => (ready() ? (stats.get(id) ?? 0) : 0),
      setStat: (id, value) => {
        const wasReady = ready();
        polls += 1;
        if (!wasReady || !knownIds.includes(id)) return false;
        // Like the real SDK, an unchanged value is accepted but is not a write.
        if ((stats.get(id) ?? 0) !== value) {
          events.push(`set:${id}=${value}`);
          stats.set(id, value);
        }
        return true;
      },
      setAchievement: (id) => {
        if (!ready() || !knownIds.includes(id)) return false;
        events.push(`ach:${id}`);
        achievements.add(id);
        return true;
      },
      storeStats: () => {
        events.push("store");
        if (storeResult !== "silent") {
          queueMicrotask(() =>
            listeners.forEach((listener) =>
              (listener as (event: Event) => void)(
                new CustomEvent("StatsStored", {
                  detail: storeResult === "ok" ? { success: true } : { success: false, message: "denied" },
                }),
              ),
            ),
          );
        }
        return true;
      },
      addEventListener: (_type, listener) => {
        if (listener) listeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        if (listener) listeners.delete(listener);
      },
    });
    return { sdk, events, listeners, stats };
  }

  const request = {
    statIds: ["A", "B"] as [string, ...string[]],
    build: (read: (id: string) => number) => ({
      stats: { A: read("A") + 1, B: 1 },
      achievements: ["WIN"],
    }),
  };
  const fast = { readyPollMs: 1, readyTimeoutMs: 40, storeTimeoutMs: 40 };

  it("reports guest and signed-out as unavailable without touching the SDK", async () => {
    const guest = createWavedashAdapter({ loadSdk: async () => null });
    await expect(guest.commitProgress(request)).resolves.toEqual({ status: "unavailable", reason: "guest" });

    const { sdk, events } = statsSdk();
    const signedOut = createWavedashAdapter({
      loadSdk: async () => ({ ...sdk, getUserId: () => "" }),
      ...fast,
    });
    await expect(signedOut.commitProgress(request)).resolves.toEqual({ status: "unavailable", reason: "signed-out" });
    expect(events).toEqual([]);

    const broken = createWavedashAdapter({ loadSdk: async () => { throw new Error("x"); }, onError: () => {} });
    await expect(broken.commitProgress(request)).resolves.toEqual({ status: "unavailable", reason: "sdk-error" });
  });

  it("waits for stats to load before reading or writing, then confirms the store", async () => {
    const { sdk, events } = statsSdk({ readyAfterPolls: 3 });
    const read = vi.fn(request.build);
    const adapter = createWavedashAdapter({ loadSdk: async () => sdk, ...fast });

    await expect(adapter.commitProgress({ ...request, build: read })).resolves.toEqual({ status: "stored" });
    // Built once, after load: the stat reads 4, not the pre-load default of 0.
    expect(read).toHaveBeenCalledTimes(1);
    expect(events).toContain("set:A=5");
    expect(events.indexOf("store")).toBeGreaterThan(events.indexOf("ach:WIN"));
  });

  it("does not write when stats never load, or an identifier is undefined", async () => {
    const { sdk, events } = statsSdk({ knownIds: [] });
    const adapter = createWavedashAdapter({ loadSdk: async () => sdk, ...fast });
    await expect(adapter.commitProgress(request)).resolves.toEqual({ status: "unavailable", reason: "not-ready" });
    expect(events).toEqual([]);
  });

  it("flags a write the SDK rejects for a missing achievement definition", async () => {
    const { sdk } = statsSdk({ knownIds: ["A", "B"] });
    const adapter = createWavedashAdapter({ loadSdk: async () => sdk, ...fast });
    const result = await adapter.commitProgress({
      ...request,
      build: () => ({ stats: { A: 5 }, achievements: ["UNDEFINED_ONE"] }),
    });
    expect(result).toEqual({ status: "unavailable", reason: "rejected" });
  });

  it("treats a failed or missing StatsStored confirmation as not stored", async () => {
    const failing = statsSdk({ storeResult: "fail" });
    const a = createWavedashAdapter({ loadSdk: async () => failing.sdk, ...fast });
    await expect(a.commitProgress(request)).resolves.toEqual({ status: "failed", message: "denied" });
    expect(failing.listeners.size).toBe(0);

    const silent = statsSdk({ storeResult: "silent" });
    const b = createWavedashAdapter({ loadSdk: async () => silent.sdk, ...fast });
    const result = await b.commitProgress(request);
    expect(result.status).toBe("failed");
    expect(silent.listeners.size).toBe(0);
  });

  it("an identical retry after success is a no-op that still reports stored", async () => {
    const { sdk, events } = statsSdk();
    const adapter = createWavedashAdapter({ loadSdk: async () => sdk, ...fast });
    const stable = { ...request, build: () => ({ stats: { A: 5, B: 1 }, achievements: ["WIN"] }) };

    await adapter.commitProgress(stable);
    const storesBefore = events.filter((e) => e === "store").length;
    await expect(adapter.commitProgress(stable)).resolves.toEqual({ status: "stored" });
    expect(events.filter((e) => e === "store").length).toBe(storesBefore);
  });

  it("re-dirties stats when retrying after a failed store, so the retry is really sent", async () => {
    const { sdk, events } = statsSdk({ storeResult: "fail" });
    const adapter = createWavedashAdapter({ loadSdk: async () => sdk, ...fast });
    const stable = { ...request, build: () => ({ stats: { A: 5, B: 1 }, achievements: [] }) };

    await adapter.commitProgress(stable);
    events.length = 0;
    await adapter.commitProgress(stable);
    expect(events.slice(0, 2)).toEqual(["set:A=6", "set:A=5"]);
    expect(events).toContain("store");
  });

  it("serialises overlapping commits", async () => {
    const { sdk, events } = statsSdk();
    const adapter = createWavedashAdapter({ loadSdk: async () => sdk, ...fast });
    await Promise.all([
      adapter.commitProgress({ ...request, build: () => ({ stats: { A: 5 }, achievements: [] }) }),
      adapter.commitProgress({ ...request, build: () => ({ stats: { A: 6 }, achievements: [] }) }),
    ]);
    expect(events.filter((e) => e === "store")).toHaveLength(2);
    expect(events.indexOf("set:A=6")).toBeGreaterThan(events.indexOf("store"));
  });
});

describe("wavedash leaderboard submission", () => {
  const request = {
    name: "daily-duel",
    score: 4,
    metadata: { date: "2026-10-04", rulesVersion: 1, playerScore: 12, rivalScore: 8 },
  };

  it("resolves the board name to an id, then submits with keepBest and metadata", async () => {
    const getLeaderboard = vi.fn(async () => ({ success: true as const, data: { id: "board-9" } }));
    const upload = vi.fn(async () => ({
      success: true as const,
      data: { score: 6, globalRank: 3, submittedScore: 4, submittedRank: 9 },
    }));
    const adapter = createWavedashAdapter({
      loadSdk: async () => fakeSdk({ getLeaderboard, uploadLeaderboardScore: upload }),
    });

    const result = await adapter.submitLeaderboardScore(request);

    expect(getLeaderboard).toHaveBeenCalledWith("daily-duel");
    expect(upload).toHaveBeenCalledWith("board-9", 4, true, undefined, request.metadata);
    expect(getLeaderboard.mock.invocationCallOrder[0]).toBeLessThan(upload.mock.invocationCallOrder[0]);
    expect(result).toEqual({
      status: "submitted",
      saved: { score: 6, rank: 3 },
      submitted: { score: 4, rank: 9 },
    });
  });

  it("never creates a board: the adapter has no create path", async () => {
    const sdk = { ...fakeSdk(), getOrCreateLeaderboard: vi.fn() };
    const adapter = createWavedashAdapter({ loadSdk: async () => sdk });
    await adapter.submitLeaderboardScore(request);
    expect(sdk.getOrCreateLeaderboard).not.toHaveBeenCalled();
  });

  it("reports guests and signed-out players as unavailable without touching the SDK", async () => {
    const guest = createWavedashAdapter({ loadSdk: async () => null });
    await expect(guest.submitLeaderboardScore(request)).resolves.toEqual({
      status: "unavailable",
      reason: "guest",
    });

    const getLeaderboard = vi.fn();
    const signedOut = createWavedashAdapter({
      loadSdk: async () => fakeSdk({ getUserId: () => "", getLeaderboard }),
    });
    await expect(signedOut.submitLeaderboardScore(request)).resolves.toEqual({
      status: "unavailable",
      reason: "signed-out",
    });
    expect(getLeaderboard).not.toHaveBeenCalled();
  });

  it("reports a missing board, and finds it later once it exists", async () => {
    const getLeaderboard = vi
      .fn()
      .mockResolvedValueOnce({ success: false, data: null, message: "Leaderboard not found" })
      .mockResolvedValue({ success: true, data: { id: "board-1" } });
    const adapter = createWavedashAdapter({ loadSdk: async () => fakeSdk({ getLeaderboard }) });

    await expect(adapter.submitLeaderboardScore(request)).resolves.toEqual({
      status: "unavailable",
      reason: "board-missing",
    });
    await expect(adapter.submitLeaderboardScore(request)).resolves.toMatchObject({ status: "submitted" });
  });

  it("treats lookup, upload and thrown errors as failed, never submitted", async () => {
    const lookup = createWavedashAdapter({
      loadSdk: async () =>
        fakeSdk({ getLeaderboard: async () => ({ success: false, data: null, message: "network down" }) }),
    });
    await expect(lookup.submitLeaderboardScore(request)).resolves.toEqual({
      status: "failed",
      message: "network down",
    });

    const upload = createWavedashAdapter({
      loadSdk: async () =>
        fakeSdk({ uploadLeaderboardScore: async () => ({ success: false, data: null, message: "too big" }) }),
    });
    await expect(upload.submitLeaderboardScore(request)).resolves.toEqual({ status: "failed", message: "too big" });

    const thrown = createWavedashAdapter({
      loadSdk: async () =>
        fakeSdk({
          getLeaderboard: async () => {
            throw new Error("boom");
          },
        }),
    });
    await expect(thrown.submitLeaderboardScore(request)).resolves.toEqual({ status: "failed", message: "boom" });
  });

  it("caches a resolved board id for later submissions", async () => {
    const getLeaderboard = vi.fn(async () => ({ success: true as const, data: { id: "board-1" } }));
    const adapter = createWavedashAdapter({ loadSdk: async () => fakeSdk({ getLeaderboard }) });
    await adapter.submitLeaderboardScore(request);
    await adapter.submitLeaderboardScore(request);
    expect(getLeaderboard).toHaveBeenCalledTimes(1);
  });
});

describe("wavedash cloud files", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it("reads a file: checks it exists, downloads it, then reads the local copy", async () => {
    const calls: string[] = [];
    const adapter = createWavedashAdapter({
      loadSdk: async () =>
        fakeSdk({
          remoteFileExists: async (path) => (calls.push(`exists ${path}`), { success: true, data: true }),
          downloadRemoteFile: async (path) => (calls.push(`download ${path}`), { success: true, data: path }),
          readLocalFile: async (path) => (calls.push(`read ${path}`), bytes('{"ok":1}')),
        }),
    });

    await expect(adapter.readCloudFile("saves/progress.json")).resolves.toEqual({
      status: "found",
      text: '{"ok":1}',
    });
    expect(calls).toEqual([
      "exists saves/progress.json",
      "download saves/progress.json",
      "read saves/progress.json",
    ]);
  });

  it("reports a file the platform says does not exist as missing, without downloading", async () => {
    const download = vi.fn(async (path: string) => ({ success: true as const, data: path }));
    const adapter = createWavedashAdapter({
      loadSdk: async () =>
        fakeSdk({
          remoteFileExists: async () => ({ success: true, data: false }),
          downloadRemoteFile: download,
        }),
    });

    await expect(adapter.readCloudFile("saves/progress.json")).resolves.toEqual({ status: "missing" });
    expect(download).not.toHaveBeenCalled();
  });

  it("reports failures distinctly from a missing file", async () => {
    const failures: Array<Partial<WavedashSdkLike>> = [
      { remoteFileExists: async () => ({ success: false, data: null, message: "401" }) },
      { downloadRemoteFile: async () => ({ success: false, data: null, message: "500 (Server Error)" }) },
      { readLocalFile: async () => null },
      {
        remoteFileExists: async () => {
          throw new Error("offline");
        },
      },
    ];

    for (const failure of failures) {
      const adapter = createWavedashAdapter({ loadSdk: async () => fakeSdk(failure) });
      expect((await adapter.readCloudFile("saves/progress.json")).status).toBe("failed");
    }
  });

  it("writes a file by saving it locally, then uploading it", async () => {
    const written: Array<[string, string]> = [];
    const upload = vi.fn(async (path: string) => ({ success: true as const, data: path }));
    const adapter = createWavedashAdapter({
      loadSdk: async () =>
        fakeSdk({
          writeLocalFile: async (path, data) => {
            written.push([path, new TextDecoder().decode(data)]);
            return true;
          },
          uploadRemoteFile: upload,
        }),
    });

    await expect(adapter.writeCloudFile("saves/progress.json", "hello")).resolves.toEqual({
      status: "stored",
    });
    expect(written).toEqual([["saves/progress.json", "hello"]]);
    expect(upload).toHaveBeenCalledWith("saves/progress.json");
  });

  it("does not report stored when the local write or the upload fails", async () => {
    const localFail = createWavedashAdapter({
      loadSdk: async () => fakeSdk({ writeLocalFile: async () => false }),
    });
    const uploadFail = createWavedashAdapter({
      loadSdk: async () =>
        fakeSdk({ uploadRemoteFile: async () => ({ success: false, data: null, message: "413" }) }),
    });

    expect((await localFail.writeCloudFile("a", "b")).status).toBe("failed");
    expect(await uploadFail.writeCloudFile("a", "b")).toEqual({ status: "failed", message: "413" });
  });

  it("is unavailable for guests and signed-out players without touching the SDK", async () => {
    const exists = vi.fn(async () => ({ success: true as const, data: true }));
    const guest = createWavedashAdapter({ loadSdk: async () => null });
    const signedOut = createWavedashAdapter({
      loadSdk: async () => fakeSdk({ getUserId: () => "", remoteFileExists: exists }),
    });

    expect(await guest.readCloudFile("a")).toEqual({ status: "unavailable", reason: "guest" });
    expect(await guest.writeCloudFile("a", "b")).toEqual({ status: "unavailable", reason: "guest" });
    expect(await signedOut.readCloudFile("a")).toEqual({ status: "unavailable", reason: "signed-out" });
    expect(exists).not.toHaveBeenCalled();
  });

  it("runs cloud file operations one at a time", async () => {
    let active = 0;
    let peak = 0;
    const adapter = createWavedashAdapter({
      loadSdk: async () =>
        fakeSdk({
          writeLocalFile: async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active -= 1;
            return true;
          },
        }),
    });

    await Promise.all([
      adapter.writeCloudFile("a", "1"),
      adapter.writeCloudFile("a", "2"),
      adapter.writeCloudFile("a", "3"),
    ]);

    expect(peak).toBe(1);
  });
});
