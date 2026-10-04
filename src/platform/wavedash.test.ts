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
