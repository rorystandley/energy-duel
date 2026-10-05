import { describe, expect, it, vi } from "vitest";

import { createFullscreenController, type FullscreenDocument, type FullscreenHost } from "./fullscreen";
import { createWavedashAdapter, type WavedashSdkLike } from "./wavedash";

function host(overrides: Partial<FullscreenHost> = {}): FullscreenHost {
  let on = false;
  return {
    hostFullscreenAvailable: true,
    isHostFullscreen: () => on,
    requestHostFullscreen: async (enter) => {
      on = enter;
      return { status: "done" };
    },
    onHostFullscreenChanged: () => () => {},
    ...overrides,
  };
}

function fakeDoc(overrides: Partial<FullscreenDocument> = {}) {
  const listeners = new Set<() => void>();
  const requestFullscreen = vi.fn<() => Promise<void>>(async () => {
    doc.fullscreenElement = {} as Element;
  });
  const exitFullscreen = vi.fn<() => Promise<void>>(async () => {
    doc.fullscreenElement = null;
  });
  const doc = {
    fullscreenEnabled: true,
    fullscreenElement: null as Element | null,
    documentElement: { requestFullscreen },
    exitFullscreen,
    addEventListener: (_: "fullscreenchange", l: () => void) => listeners.add(l),
    removeEventListener: (_: "fullscreenchange", l: () => void) => listeners.delete(l),
  };
  return Object.assign(doc, overrides) as typeof doc;
}

describe("fullscreen controller with the Wavedash host", () => {
  it("asks the host to enter, then exit, and does not touch the document", async () => {
    const h = host();
    const request = vi.spyOn(h, "requestHostFullscreen");
    const doc = fakeDoc();
    const c = createFullscreenController(h, doc);

    expect(c.isSupported()).toBe(true);
    await expect(c.toggle()).resolves.toEqual({ status: "changed", fullscreen: true });
    expect(c.isFullscreen()).toBe(true);
    await expect(c.toggle()).resolves.toEqual({ status: "changed", fullscreen: false });
    expect(request.mock.calls).toEqual([[true], [false]]);
    expect(doc.documentElement.requestFullscreen).not.toHaveBeenCalled();
  });

  it("calls the host synchronously so the click gesture is still live", () => {
    const h = host();
    const request = vi.spyOn(h, "requestHostFullscreen");
    createFullscreenController(h, fakeDoc()).toggle();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("reports a rejected host request and can be retried", async () => {
    let attempts = 0;
    const h = host({
      requestHostFullscreen: async () =>
        ++attempts === 1 ? { status: "rejected" } : { status: "done" },
    });
    const c = createFullscreenController(h, fakeDoc());
    await expect(c.toggle()).resolves.toEqual({ status: "rejected" });
    await expect(c.toggle()).resolves.toEqual({ status: "changed", fullscreen: true });
  });

  it("settles when the host request fails outright", async () => {
    const h = host({ requestHostFullscreen: async () => ({ status: "failed", message: "boom" }) });
    const c = createFullscreenController(h, fakeDoc());
    await expect(c.toggle()).resolves.toEqual({ status: "rejected", message: "boom" });
    await expect(c.toggle()).resolves.toMatchObject({ status: "rejected" });
  });

  it("ignores a second press while a request is in flight", async () => {
    let finish!: () => void;
    const h = host({
      requestHostFullscreen: () => new Promise((r) => (finish = () => r({ status: "done" }))),
    });
    const c = createFullscreenController(h, fakeDoc());
    const first = c.toggle();
    await expect(c.toggle()).resolves.toEqual({ status: "rejected" });
    finish();
    await expect(first).resolves.toMatchObject({ status: "changed" });
  });
});

describe("fullscreen controller without a host", () => {
  const absent = () => host({ hostFullscreenAvailable: false });

  it("falls back to the browser Fullscreen API", async () => {
    const doc = fakeDoc();
    const c = createFullscreenController(absent(), doc);
    await expect(c.toggle()).resolves.toEqual({ status: "changed", fullscreen: true });
    expect(c.isFullscreen()).toBe(true);
    await expect(c.toggle()).resolves.toEqual({ status: "changed", fullscreen: false });
    expect(doc.exitFullscreen).toHaveBeenCalled();
  });

  it("is unsupported when the browser cannot fullscreen", async () => {
    const c = createFullscreenController(absent(), fakeDoc({ fullscreenEnabled: false }));
    expect(c.isSupported()).toBe(false);
    await expect(c.toggle()).resolves.toEqual({ status: "unsupported" });
  });

  it("is unsupported with no document at all", () => {
    expect(createFullscreenController(absent(), null).isSupported()).toBe(false);
  });

  it("recovers from a rejected browser request, async or sync", async () => {
    const doc = fakeDoc();
    doc.documentElement.requestFullscreen.mockRejectedValueOnce(new Error("denied"));
    const c = createFullscreenController(absent(), doc);
    await expect(c.toggle()).resolves.toEqual({ status: "rejected", message: "denied" });
    doc.documentElement.requestFullscreen.mockImplementationOnce(() => {
      throw new Error("sync");
    });
    await expect(c.toggle()).resolves.toEqual({ status: "rejected", message: "sync" });
    await expect(c.toggle()).resolves.toMatchObject({ status: "changed" });
  });

  it("notifies on fullscreenchange and unsubscribes", () => {
    const doc = fakeDoc();
    const add = vi.spyOn(doc, "addEventListener");
    const remove = vi.spyOn(doc, "removeEventListener");
    const listener = vi.fn();
    const off = createFullscreenController(absent(), doc).subscribe(listener);
    expect(add).toHaveBeenCalledWith("fullscreenchange", listener);
    off();
    expect(remove).toHaveBeenCalledWith("fullscreenchange", listener);
  });
});

describe("wavedash adapter fullscreen", () => {
  function sdkWith(requestFullscreen: WavedashSdkLike["requestFullscreen"]) {
    const listeners = new Map<string, EventListener>();
    const sdk = {
      init: () => true,
      isFullscreen: () => false,
      requestFullscreen: vi.fn(requestFullscreen),
      addEventListener: (t: string, l: EventListener) => listeners.set(t, l),
      removeEventListener: (t: string) => listeners.delete(t),
    } as unknown as WavedashSdkLike;
    return { sdk, listeners };
  }

  it("is unavailable as a guest", async () => {
    const adapter = createWavedashAdapter({ loadSdk: async () => null });
    expect(adapter.hostFullscreenAvailable).toBe(false);
    await adapter.initialize();
    expect(adapter.hostFullscreenAvailable).toBe(false);
    await expect(adapter.requestHostFullscreen(true)).resolves.toEqual({ status: "unavailable" });
    expect(adapter.isHostFullscreen()).toBe(false);
  });

  it("forwards to the SDK and maps its answers", async () => {
    const { sdk } = sdkWith(async () => true);
    const adapter = createWavedashAdapter({ loadSdk: async () => sdk });
    await adapter.initialize();
    expect(adapter.hostFullscreenAvailable).toBe(true);
    await expect(adapter.requestHostFullscreen(true)).resolves.toEqual({ status: "done" });
    expect(sdk.requestFullscreen).toHaveBeenCalledWith(true);
  });

  it("maps a false answer to rejected and an error to failed", async () => {
    const no = sdkWith(async () => false);
    const a = createWavedashAdapter({ loadSdk: async () => no.sdk });
    await a.initialize();
    await expect(a.requestHostFullscreen(true)).resolves.toEqual({ status: "rejected" });

    const bad = sdkWith(async () => {
      throw new Error("denied");
    });
    const b = createWavedashAdapter({ loadSdk: async () => bad.sdk });
    await b.initialize();
    await expect(b.requestHostFullscreen(true)).resolves.toEqual({ status: "failed", message: "denied" });

    const sync = sdkWith(() => {
      throw new Error("sync");
    });
    const c = createWavedashAdapter({ loadSdk: async () => sync.sdk });
    await c.initialize();
    await expect(c.requestHostFullscreen(true)).resolves.toEqual({ status: "failed", message: "sync" });
  });

  it("relays FullscreenChanged events", async () => {
    const { sdk, listeners } = sdkWith(async () => true);
    const adapter = createWavedashAdapter({ loadSdk: async () => sdk });
    await adapter.initialize();
    const seen: boolean[] = [];
    const off = adapter.onHostFullscreenChanged((v) => seen.push(v));
    listeners.get("FullscreenChanged")!(new CustomEvent("FullscreenChanged", { detail: { isFullscreen: true } }));
    off();
    expect(seen).toEqual([true]);
    expect(listeners.has("FullscreenChanged")).toBe(false);
  });
});
