import type { Pickup, RobotId, StepResult } from "./types";

export type SummaryTone = RobotId | "neutral";

export interface RoundSummaryMoment {
  text: string;
  tone: SummaryTone;
}

export interface RoundSummary {
  title: string;
  playerPoints: number;
  rivalPoints: number;
  moment: RoundSummaryMoment;
  stunNote: string | null;
  continueLabel: string;
}

export interface RoundSummaryInput {
  round: number;
  totalRounds: number;
  /** Resolved steps for the round, in order. */
  steps: StepResult[];
  /** Pickups on the board before the round's first step (used for node values). */
  startPickups: Pickup[];
}

interface Claim {
  step: number;
  robot: RobotId;
  value: number;
  viaClash: boolean;
}

export function deriveRoundSummary(input: RoundSummaryInput): RoundSummary {
  const { round, totalRounds, steps } = input;
  const claims = collectClaims(steps, input.startPickups);

  return {
    title: `ROUND ${round} COMPLETE`,
    playerPoints: sum(steps.map((step) => step.playerScoreDelta)),
    rivalPoints: sum(steps.map((step) => step.rivalScoreDelta)),
    moment: describeKeyMoment(steps, claims),
    stunNote: describeStuns(steps),
    continueLabel:
      round >= totalRounds ? "SEE RESULT" : `CONTINUE TO ROUND ${round + 1}`,
  };
}

function collectClaims(steps: StepResult[], startPickups: Pickup[]): Claim[] {
  const claims: Claim[] = [];

  for (const step of steps) {
    for (const id of step.collectedPickupIds) {
      const pickup = startPickups.find((candidate) => candidate.id === id);

      if (!pickup) {
        continue;
      }

      const robot = getCollector(step, pickup);

      if (robot) {
        claims.push({
          step: step.step,
          robot,
          value: pickup.value,
          viaClash: step.collision,
        });
      }
    }
  }

  return claims;
}

function getCollector(step: StepResult, pickup: Pickup): RobotId | null {
  if (step.collision) {
    return step.collisionWinner;
  }

  if (
    step.playerScoreDelta > 0 &&
    step.playerTile.row === pickup.tile.row &&
    step.playerTile.col === pickup.tile.col
  ) {
    return "player";
  }

  if (step.rivalScoreDelta > 0) {
    return "rival";
  }

  return null;
}

function describeKeyMoment(
  steps: StepResult[],
  claims: Claim[],
): RoundSummaryMoment {
  const clashes = steps.filter((step) => step.collision && step.collisionWinner);

  if (clashes.length > 0) {
    // Prefer the clash that decided a node; otherwise the first clash.
    const decisive =
      clashes.find((step) => claims.some((claim) => claim.step === step.step)) ??
      clashes[0];
    const winner = decisive.collisionWinner as RobotId;
    const claim = claims.find((candidate) => candidate.step === decisive.step);
    const who = winner === "player" ? "You" : "Enemy";
    const prize = claim
      ? ` and took the ${claim.value}-point node`
      : "";

    return {
      text: `${who} won the clash at step ${decisive.step}${prize}.`,
      tone: winner,
    };
  }

  if (claims.length > 0) {
    const best = claims.reduce((top, claim) =>
      claim.value > top.value ? claim : top,
    );
    const who = best.robot === "player" ? "You" : "Enemy";

    return {
      text: `${who} claimed a ${best.value}-point node at step ${best.step}.`,
      tone: best.robot,
    };
  }

  return { text: "No nodes claimed and no clashes.", tone: "neutral" };
}

function describeStuns(steps: StepResult[]): string | null {
  const notes: string[] = [];

  for (const step of steps) {
    if (step.playerWasStunned) {
      notes.push(`You lost step ${step.step} (stunned)`);
    }

    if (step.rivalWasStunned) {
      notes.push(`Enemy lost step ${step.step} (stunned)`);
    }
  }

  return notes.length > 0 ? `${notes.join("; ")}.` : null;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
