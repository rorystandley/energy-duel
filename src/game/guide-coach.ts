import type { MatchMode, MatchStatus, RobotId } from "./types";

export type GuideCoachTopic =
  | "values"
  | "preview"
  | "ready"
  | "priority"
  | "clash";

export interface GuideCoach {
  topic: GuideCoachTopic;
  title: string;
  text: string;
}

export interface GuideCoachInput {
  mode: MatchMode;
  round: number;
  status: MatchStatus;
  queueLength: number;
  maxSteps: number;
  priorityOwner: RobotId;
  lastCollisionWinner: RobotId | null;
  /** Touch layouts use shorter copy that names on-screen buttons instead of keys. */
  touch?: boolean;
}

// Each lesson appears at the moment it matters, never as an up-front wall of text.
export function getGuideCoach(input: GuideCoachInput): GuideCoach | null {
  if (input.mode !== "guided") {
    return null;
  }

  if (input.status === "executing") {
    if (!input.lastCollisionWinner) {
      return null;
    }

    const winner = input.lastCollisionWinner === "player" ? "You" : "The enemy";
    const loser = input.lastCollisionWinner === "player" ? "the enemy is" : "you are";

    if (input.touch) {
      return {
        topic: "clash",
        title: "CLASH",
        text: `${winner} had priority and took the tile; ${loser} stunned next step.`,
      };
    }

    return {
      topic: "clash",
      title: "CLASH",
      text: `${winner} had priority and took the tile; ${loser} stunned for the next step.`,
    };
  }

  if (input.status !== "queuing") {
    return null;
  }

  if (input.queueLength >= input.maxSteps) {
    if (input.touch) {
      return {
        topic: "ready",
        title: "READY",
        text: "Queue full. Tap EXECUTE to reveal both plans.",
      };
    }

    return {
      topic: "ready",
      title: "READY",
      text: "Queue locked in. Press Enter or EXECUTE to reveal both plans.",
    };
  }

  if (input.round >= 2 && input.queueLength === 0) {
    const owner = input.priorityOwner === "player" ? "You win" : "The enemy wins";

    if (input.touch) {
      return {
        topic: "priority",
        title: "COLLISION PRIORITY",
        text: `${owner} clashes this round: priority takes the tile, the other is stunned.`,
      };
    }

    return {
      topic: "priority",
      title: "COLLISION PRIORITY",
      text: `${owner} clashes this round. Same tile or crossing paths: priority takes the tile, the other is stunned.`,
    };
  }

  if (input.queueLength === 0) {
    if (input.touch) {
      return {
        topic: "values",
        title: "NODE VALUES",
        text: `Small nodes = 1, large = 3. Queue ${input.maxSteps} moves toward them.`,
      };
    }

    return {
      topic: "values",
      title: "NODE VALUES",
      text: `Small nodes are worth 1, large nodes 3. Queue ${input.maxSteps} moves toward them.`,
    };
  }

  if (input.touch) {
    return {
      topic: "preview",
      title: "PATH PREVIEW",
      text: "Glowing line = your path; numbers are steps. UNDO removes one.",
    };
  }

  return {
    topic: "preview",
    title: "PATH PREVIEW",
    text: "The glowing line is your queued path; numbers are steps. Backspace undoes.",
  };
}
