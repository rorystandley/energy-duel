export type GuideOutcome = "completed" | "skipped";

export interface ProgressStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const GUIDE_OUTCOME_STORAGE_KEY = "energy-duel:guided-intro";

// Local-only on purpose: guests must be able to play with no platform services.
export function readGuideOutcome(
  storage: ProgressStorage | undefined,
): GuideOutcome | null {
  try {
    const value = storage?.getItem(GUIDE_OUTCOME_STORAGE_KEY);
    return value === "completed" || value === "skipped" ? value : null;
  } catch {
    return null;
  }
}

export function recordGuideOutcome(
  storage: ProgressStorage | undefined,
  outcome: GuideOutcome,
): void {
  if (outcome === "skipped" && readGuideOutcome(storage) === "completed") {
    return;
  }

  try {
    storage?.setItem(GUIDE_OUTCOME_STORAGE_KEY, outcome);
  } catch {
    // Storage can be unavailable; the guide still works without a record.
  }
}
