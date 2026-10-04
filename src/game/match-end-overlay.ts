import { deriveRoundStories, pickBestRound } from "./match-story";
import type { ReplayRecord } from "./replay";
import type { MatchState, RobotId } from "./types";

export type FinalResultLabel = "Victory" | "Defeat" | "Draw";
export type ScoreRowTone = RobotId | "neutral";

export interface MatchCompleteScoreRow {
  label: string;
  value: string;
  tone: ScoreRowTone;
}

export type MatchEndActionId =
  | "rematch"
  | "new-board"
  | "standard"
  | "replay"
  | "share";

export interface MatchEndAction {
  id: MatchEndActionId;
  label: string;
}

export interface MatchCompleteOverlayModel {
  resultLabel: FinalResultLabel;
  resultSubtitle: string;
  /** Final result: both scores and the margin between them. */
  scoreRows: MatchCompleteScoreRow[];
  /** Match story: nodes, clashes and best round. */
  storyRows: MatchCompleteScoreRow[];
  nextTarget: string;
  actions: MatchEndAction[];
  /** Text copied by the share action. */
  shareText: string;
  /** Always shown with the share action so it is never read as a verified record. */
  shareDisclaimer: string;
}

export interface MatchCompleteOverlayOptions {
  /** Record of the finished match; enables the best-round line and replay action. */
  replay?: ReplayRecord;
  /** Day shown on the shared result, as YYYY-MM-DD. */
  date?: string;
}

export const SHARE_DISCLAIMER =
  "Client-reported result, not a verified record.";

export function createMatchCompleteOverlayModel(
  match: MatchState,
  options: MatchCompleteOverlayOptions = {},
): MatchCompleteOverlayModel {
  const result = getFinalResultCopy(match.playerScore, match.rivalScore);
  const guided = match.mode === "guided";
  const hasReplay = (options.replay?.rounds.length ?? 0) > 0;
  const swing = match.playerScore - match.rivalScore;
  const best = options.replay
    ? pickBestRound(deriveRoundStories(options.replay))
    : null;
  const { stats } = match;

  const actions: MatchEndAction[] = guided
    ? [{ id: "standard", label: "START STANDARD MATCH" }]
    : [
        { id: "rematch", label: "REMATCH THIS BOARD" },
        { id: "new-board", label: "NEW BOARD" },
      ];

  if (hasReplay) {
    actions.push({ id: "replay", label: "WATCH REPLAY" });
  }

  actions.push({ id: "share", label: "SHARE RESULT" });

  return {
    resultLabel: result.label,
    resultSubtitle: guided
      ? "Guided duel done. Next: Standard Match."
      : result.subtitle,
    scoreRows: [
      { label: "YOUR SCORE", value: String(match.playerScore), tone: "player" },
      { label: "ENEMY SCORE", value: String(match.rivalScore), tone: "rival" },
      {
        label: "SCORE SWING",
        value: formatSigned(swing),
        tone: swing > 0 ? "player" : swing < 0 ? "rival" : "neutral",
      },
    ],
    storyRows: [
      {
        label: "NODES CLAIMED",
        value: `${stats.playerPickupsCollected} - ${stats.rivalPickupsCollected}`,
        tone: "neutral",
      },
      {
        label: "CLASHES WON",
        value: `${stats.playerCollisionsWon} - ${stats.rivalCollisionsWon}`,
        tone: "neutral",
      },
      {
        label: "BEST ROUND",
        value: best
          ? `R${best.round}: +${best.playerPoints} vs +${best.rivalPoints}`
          : "n/a",
        tone: "neutral",
      },
    ],
    nextTarget: describeNextTarget(match),
    actions,
    shareText: formatShareText(match, options.date ?? todayUtc()),
    shareDisclaimer: SHARE_DISCLAIMER,
  };
}

export function formatShareText(match: MatchState, date: string): string {
  const label = getFinalResultCopy(match.playerScore, match.rivalScore).label;
  const swing = match.playerScore - match.rivalScore;

  return [
    `Energy Duel: ${label} ${match.playerScore}-${match.rivalScore} (${formatSigned(swing)})`,
    `Board seed ${match.seed} | ${match.mode} | rules v${match.rulesVersion} | ${date}`,
    SHARE_DISCLAIMER,
  ].join("\n");
}

function describeNextTarget(match: MatchState): string {
  if (match.mode === "guided") {
    return "Next target: win a Standard Match.";
  }

  if (match.rivalScore > match.playerScore) {
    return `Next target: score ${match.rivalScore + 1}+ on this board to beat the enemy's ${match.rivalScore}.`;
  }

  return `Next target: beat your ${match.playerScore} on this board.`;
}

function formatSigned(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
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
