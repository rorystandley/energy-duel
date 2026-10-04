import type { DailyBoardStatus, DailyRankSummary } from "./daily";
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
  | "daily"
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
  /** Daily Duel only: board date, rules version and local rank. */
  dailyRows: MatchCompleteScoreRow[];
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
  /** Local rank of a finished Daily Duel attempt, once it has been recorded. */
  dailyRank?: DailyRankSummary | null;
  /** Whether the Daily Duel board is still today's. */
  dailyStatus?: DailyBoardStatus | null;
}

export const SHARE_DISCLAIMER =
  "Client-reported result, not a verified record.";

export function createMatchCompleteOverlayModel(
  match: MatchState,
  options: MatchCompleteOverlayOptions = {},
): MatchCompleteOverlayModel {
  const result = getFinalResultCopy(match.playerScore, match.rivalScore);
  const guided = match.mode === "guided";
  const daily = match.mode === "daily";
  const hasReplay = (options.replay?.rounds.length ?? 0) > 0;
  const swing = match.playerScore - match.rivalScore;
  const best = options.replay
    ? pickBestRound(deriveRoundStories(options.replay))
    : null;
  const { stats } = match;

  const dailyIsCurrent = options.dailyStatus?.isToday ?? false;
  const actions: MatchEndAction[] = guided
    ? [{ id: "standard", label: "START STANDARD MATCH" }]
    : [
        {
          id: "rematch",
          label: daily ? "PRACTICE THIS BOARD" : "REMATCH THIS BOARD",
        },
        { id: "new-board", label: "NEW BOARD" },
      ];

  // Offer today's board unless this attempt already is on it (Practice covers that).
  if (!guided && !(daily && dailyIsCurrent)) {
    actions.push({ id: "daily", label: "DAILY DUEL" });
  }

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
    dailyRows: daily ? describeDailyRows(match, options) : [],
    storyRows: [
      ...(daily ? describeDailyRows(match, options) : []),
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
    nextTarget: describeNextTarget(match, options),
    actions,
    shareText: formatShareText(match, options.date ?? todayUtc(), options.dailyRank),
    shareDisclaimer: SHARE_DISCLAIMER,
  };
}

export function formatShareText(
  match: MatchState,
  date: string,
  dailyRank?: DailyRankSummary | null,
): string {
  const label = getFinalResultCopy(match.playerScore, match.rivalScore).label;
  const swing = match.playerScore - match.rivalScore;

  if (match.mode === "daily" && match.dailyDate) {
    return [
      `Energy Duel Daily ${match.dailyDate}: ${match.playerScore}-${match.rivalScore} (${formatSigned(swing)})`,
      `Rules v${match.rulesVersion}${dailyRank ? ` | local rank #${dailyRank.rank} of ${dailyRank.attempts}` : ""}`,
      SHARE_DISCLAIMER,
    ].join("\n");
  }

  return [
    `Energy Duel: ${label} ${match.playerScore}-${match.rivalScore} (${formatSigned(swing)})`,
    `Board seed ${match.seed} | ${match.mode} | rules v${match.rulesVersion} | ${date}`,
    SHARE_DISCLAIMER,
  ].join("\n");
}

function describeDailyRows(
  match: MatchState,
  options: MatchCompleteOverlayOptions,
): MatchCompleteScoreRow[] {
  const rank = options.dailyRank;
  const rows: MatchCompleteScoreRow[] = [
    {
      label: "DAILY BOARD",
      value: `${match.dailyDate ?? "?"}  RULES v${match.rulesVersion}`,
      tone: "neutral",
    },
  ];

  if (rank) {
    rows.push({
      label: "LOCAL RANK",
      value: `#${rank.rank} of ${rank.attempts}${rank.tiedWith > 0 ? " (tied)" : ""}`,
      tone: "neutral",
    });
  }

  return rows;
}

function describeNextTarget(match: MatchState, options: MatchCompleteOverlayOptions): string {
  if (match.mode === "daily") {
    const rank = options.dailyRank;
    const stale =
      options.dailyStatus && !options.dailyStatus.isToday
        ? ` Counted for ${options.dailyStatus.boardDate}, the day you started; today's board is ${options.dailyStatus.today}.`
        : "";
    const swing = match.playerScore - match.rivalScore;
    const target =
      rank && rank.rank === 1
        ? `Best on this device for ${match.dailyDate}. Practice to beat ${formatSigned(swing)}.`
        : `Beat your best ${formatSigned(rank?.bestMargin ?? swing)} on this board.`;

    return `${target}${stale}`;
  }

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
