import type { MatchState, RobotId } from "./types";

export type FinalResultLabel = "Victory" | "Defeat" | "Draw";
export type ScoreRowTone = RobotId | "neutral";

export interface MatchCompleteScoreRow {
  label: string;
  value: string;
  tone: ScoreRowTone;
}

export interface MatchCompleteOverlayModel {
  resultLabel: FinalResultLabel;
  resultSubtitle: string;
  scoreRows: MatchCompleteScoreRow[];
  statLines: string[];
}

export function createMatchCompleteOverlayModel(
  match: MatchState,
): MatchCompleteOverlayModel {
  const result = getFinalResultCopy(match.playerScore, match.rivalScore);

  return {
    resultLabel: result.label,
    resultSubtitle: result.subtitle,
    scoreRows: [
      {
        label: "YOUR SCORE",
        value: String(match.playerScore),
        tone: "player",
      },
      {
        label: "ENEMY SCORE",
        value: String(match.rivalScore),
        tone: "rival",
      },
      {
        label: "ROUND REACHED",
        value: `${match.currentRound} / ${match.totalRounds}`,
        tone: "neutral",
      },
    ],
    statLines: [],
  };
}

function getFinalResultCopy(
  playerScore: number,
  rivalScore: number,
): {
  label: FinalResultLabel;
  subtitle: string;
} {
  if (playerScore > rivalScore) {
    return {
      label: "Victory",
      subtitle: "You claimed the high score",
    };
  }

  if (rivalScore > playerScore) {
    return {
      label: "Defeat",
      subtitle: "Enemy claimed the high score",
    };
  }

  return {
    label: "Draw",
    subtitle: "Scores locked at parity",
  };
}
