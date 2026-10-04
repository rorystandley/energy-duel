import { describe, expect, it, vi } from "vitest";

import { createWavedashAdapter, type WavedashSdkLike } from "./wavedash";

function fakeSdk(overrides: Partial<WavedashSdkLike> = {}): WavedashSdkLike & {
  init: ReturnType<typeof vi.fn>;
} {
  return {
    init: vi.fn(() => true),
    getUserId: () => "user-1",
    getUsername: () => "Rory",
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
