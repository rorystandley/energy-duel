import { MOVES_PER_ROUND, TOTAL_ROUNDS } from "./constants";
import type { MatchMode } from "./types";

/**
 * Version of the deterministic rules (board generation, pickup placement,
 * rival planning, step resolution). Bump it whenever any of those change the
 * outcome for a given seed and queues, and add the old number to
 * SUPPORTED_RULES_VERSIONS only if the old behaviour is still reproducible.
 */
export const RULES_VERSION = 1;

export const SUPPORTED_RULES_VERSIONS: readonly number[] = [1];

interface ModeRules {
  totalRounds: number;
  movesForRound: (round: number) => number;
}

// Standard keeps the original five rounds of eight steps. The guided intro is a
// short on-ramp: a four-step round, then one full-length round.
const MODE_RULES: Record<MatchMode, ModeRules> = {
  standard: {
    totalRounds: TOTAL_ROUNDS,
    movesForRound: () => MOVES_PER_ROUND,
  },
  // Daily Duel plays the Standard length; only the seed source differs.
  daily: {
    totalRounds: TOTAL_ROUNDS,
    movesForRound: () => MOVES_PER_ROUND,
  },
  guided: {
    totalRounds: 2,
    movesForRound: (round) => (round <= 1 ? 4 : MOVES_PER_ROUND),
  },
};

export function getModeRules(mode: MatchMode): ModeRules {
  return MODE_RULES[mode];
}

export function getMovesForRound(mode: MatchMode, round: number): number {
  return MODE_RULES[mode].movesForRound(round);
}
