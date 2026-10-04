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
}

export interface WavedashAdapter {
  readonly status: PlatformStatus;
  /** Safe to call repeatedly; the SDK is initialised once. Never rejects. */
  initialize(): Promise<PlatformStatus>;
  getIdentity(): PlatformIdentity;
}

export interface WavedashAdapterOptions {
  loadSdk?: () => Promise<WavedashSdkLike | null>;
  onError?: (error: unknown) => void;
}

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

  return {
    get status() {
      return status;
    },
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
}

export const wavedash = createWavedashAdapter();
