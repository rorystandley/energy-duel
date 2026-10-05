/**
 * One fullscreen control for the whole game.
 *
 * Hosted on Wavedash the request goes through the host API (the iframe cannot
 * fullscreen itself and the host owns the target). Elsewhere it falls back to
 * the browser's own Fullscreen API. Wavedash's page control is left alone; both
 * report through the same change events, so the label never drifts.
 */
import type { HostFullscreenResult } from "./wavedash";

export type FullscreenResult =
  | { status: "changed"; fullscreen: boolean }
  | { status: "unsupported" }
  | { status: "rejected"; message?: string };

/** The slice of the Wavedash adapter this controller uses. */
export interface FullscreenHost {
  readonly hostFullscreenAvailable: boolean;
  isHostFullscreen(): boolean;
  requestHostFullscreen(enter: boolean): Promise<HostFullscreenResult>;
  onHostFullscreenChanged(listener: (isFullscreen: boolean) => void): () => void;
}

/** The slice of `document` used by the local-browser fallback. */
export interface FullscreenDocument {
  readonly fullscreenEnabled: boolean;
  readonly fullscreenElement: Element | null;
  readonly documentElement: { requestFullscreen(): Promise<void> };
  exitFullscreen(): Promise<void>;
  addEventListener(type: "fullscreenchange", listener: () => void): void;
  removeEventListener(type: "fullscreenchange", listener: () => void): void;
}

export interface FullscreenController {
  /** False when neither the host nor the browser can fullscreen (hide the control). */
  isSupported(): boolean;
  isFullscreen(): boolean;
  /** Call synchronously from a click/tap handler. Never rejects; always settles. */
  toggle(): Promise<FullscreenResult>;
  /** Fires after any fullscreen flip, however it was triggered. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export function createFullscreenController(
  host: FullscreenHost,
  doc: FullscreenDocument | null = typeof document === "undefined"
    ? null
    : (document as unknown as FullscreenDocument),
): FullscreenController {
  const localSupported = () => Boolean(doc?.fullscreenEnabled);
  const useHost = () => host.hostFullscreenAvailable;
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

  /** Entered from a rejected or lost request: the next press must still be able to try again. */
  let pending = false;

  const controller: FullscreenController = {
    isSupported: () => useHost() || localSupported(),
    isFullscreen: () =>
      useHost() ? host.isHostFullscreen() : Boolean(doc?.fullscreenElement),
    toggle() {
      if (pending) return Promise.resolve({ status: "rejected" });
      const enter = !controller.isFullscreen();
      let request: Promise<FullscreenResult>;

      if (useHost()) {
        // Issued before any await so the gesture's activation reaches the host.
        request = host.requestHostFullscreen(enter).then((result): FullscreenResult => {
          switch (result.status) {
            case "done":
              return { status: "changed", fullscreen: enter };
            case "unavailable":
              return { status: "unsupported" };
            case "rejected":
              return { status: "rejected" };
            case "failed":
              return { status: "rejected", message: result.message };
          }
        });
      } else if (doc && localSupported()) {
        try {
          const call = enter ? doc.documentElement.requestFullscreen() : doc.exitFullscreen();
          request = call.then(
            (): FullscreenResult => ({ status: "changed", fullscreen: enter }),
            (error): FullscreenResult => ({ status: "rejected", message: message(error) }),
          );
        } catch (error) {
          request = Promise.resolve({ status: "rejected", message: message(error) });
        }
      } else {
        return Promise.resolve({ status: "unsupported" });
      }

      pending = true;
      return request.finally(() => {
        pending = false;
      });
    },
    subscribe(listener) {
      const offHost = host.onHostFullscreenChanged(listener);
      doc?.addEventListener("fullscreenchange", listener);
      return () => {
        offHost();
        doc?.removeEventListener("fullscreenchange", listener);
      };
    },
  };
  return controller;
}
