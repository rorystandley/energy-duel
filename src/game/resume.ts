import { createDailyMatch } from "./daily";
import {
  applyStepScore,
  createInitialMatch,
  createNextRoundState,
  createRoundState,
  finishRound,
  lockRoundQueues,
  startNextRound,
} from "./match-flow";
import { deriveMatchStats } from "./match-story";
import { RULES_VERSION } from "./match-rules";
import { createReplay, recordReplayRound } from "./replay";
import type { ReplayRecord } from "./replay";
import { resolveRound } from "./round-resolution";
import type { ResumableMatch } from "./save";
import type { MatchState, RoundState } from "./types";

/**
 * What a match looks like at the start of the round after the last saved one,
 * ready to hand to the scene.
 */
export interface RestoredMatch {
  match: MatchState;
  round: RoundState;
  replay: ReplayRecord;
}

/**
 * The saveable form of a match, or null when it is not at a safe boundary.
 * Safe means a Standard or Daily match whose round has fully resolved and was
 * recorded: never while queuing a round, never while a round is animating,
 * never once the match is over.
 */
export function snapshotMatch(match: MatchState, replay: ReplayRecord): ResumableMatch | null {
  if (
    (match.mode !== "standard" && match.mode !== "daily") ||
    match.status !== "round-complete" ||
    replay.rounds.length !== match.currentRound ||
    replay.result
  ) {
    return null;
  }

  const playerQueues = replay.rounds.map((round) => [...round.playerQueue]);

  if (match.mode === "daily") {
    if (!match.dailyDate) return null;

    return {
      mode: "daily",
      seed: match.seed,
      rulesVersion: match.rulesVersion,
      dailyDate: match.dailyDate,
      playerQueues,
    };
  }

  return { mode: "standard", seed: match.seed, rulesVersion: match.rulesVersion, playerQueues };
}

/**
 * Rebuilds the match by replaying the saved queues through the live rules, the
 * same path the game and replay verification use, so board, rival choices,
 * scores and stats cannot drift from what was played. Returns null when the
 * save cannot be reproduced under this build (changed rules, a match that is
 * already over, or queues the rules reject), and the caller discards it.
 */
export function restoreMatch(saved: ResumableMatch): RestoredMatch | null {
  if (saved.rulesVersion !== RULES_VERSION) return null;

  let match: MatchState;

  try {
    match =
      saved.mode === "daily"
        ? createDailyMatch(saved.dailyDate ?? "", saved.rulesVersion)
        : createInitialMatch("standard", { seed: saved.seed });
  } catch {
    return null;
  }

  if (match.seed !== saved.seed) return null;

  let replay = createReplay(match);
  let round = createRoundState(1, { mode: match.mode, seed: match.seed });

  for (const queue of saved.playerQueues) {
    if (queue.length !== round.maxSteps) return null;

    const locked = lockRoundQueues({ ...round, playerQueue: queue.slice() });
    const resolution = resolveRound(locked);

    match = applyStepScore(match, resolution.playerScoreDelta, resolution.rivalScoreDelta);
    replay = recordReplayRound(replay, locked, resolution.steps);
    match = finishRound(match);

    // A finished match has nothing left to resume.
    if (match.status === "match-complete") return null;

    match = startNextRound(match);
    round = createNextRoundState(match, resolution.finalRound);
  }

  return { match: { ...match, stats: deriveMatchStats(replay) }, round, replay };
}
