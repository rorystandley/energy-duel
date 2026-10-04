import * as Phaser from "phaser";

import {
  BOARD_ORIGIN,
  BOARD_SIZE,
  CELL_SIZE,
  GAME_HEIGHT,
  GAME_TITLE,
  GAME_WIDTH,
} from "./game/constants";
import { getTileCenter as getTileCenterAt, sameTile } from "./game/board";
import {
  applyStepScore,
  clearPlayerQueue,
  createInitialMatch,
  createNextRoundState,
  createRestartMatch,
  createRoundState,
  finishRound,
  isPlayerQueueReady,
  lockRoundQueues,
  queuePlayerMove,
  removeLastPlayerMove,
  skipGuidedIntro,
  startNextRound,
} from "./game/match-flow";
import { createMatchCompleteOverlayModel } from "./game/match-end-overlay";
import { deriveRoundSummary } from "./game/round-summary";
import type { RoundSummary } from "./game/round-summary";
import { getGuideCoach } from "./game/guide-coach";
import { computeLayout, isCompact } from "./game/layout";
import type { CompactLayout, GameLayout, Rect } from "./game/layout";
import { recordGuideOutcome } from "./game/onboarding-progress";
import { createMovePreview } from "./game/preview";
import {
  createReplay,
  finalizeReplay,
  recordReplayRound,
  type ReplayRecord,
} from "./game/replay";
import { resolveNextStep } from "./game/round-resolution";
import { AudioManager } from "./game/audio-manager";
import { getPickupStyle, TRON_THEME } from "./game/tron-theme";
import type { FinalResultLabel, ScoreRowTone } from "./game/match-end-overlay";
import type {
  MovePreview,
  PreviewPickupClaim,
} from "./game/preview";
import type {
  MatchMode,
  MatchState,
  MatchStats,
  Move,
  Pickup,
  RivalMood,
  RobotId,
  RoundState,
  StepResult,
  TilePosition,
} from "./game/types";

const EXECUTION_MOVE_TWEEN_MS = 130;
const EXECUTION_FEEDBACK_HOLD_MS = 140;
const MOVEMENT_TRAIL_FADE_MS = 160;
const MOVEMENT_TRAIL_GLOW_WIDTH = Math.max(12, Math.round(CELL_SIZE * 0.24));
const MOVEMENT_TRAIL_CORE_WIDTH = Math.max(4, Math.round(CELL_SIZE * 0.08));
const COLLISION_FLASH_MS = 100;
const COLLISION_BUMP_MS = 110;
const COLLISION_BUMP_SCALE = 1.1;
const COLLISION_SHAKE_MS = 90;
const COLLISION_SHAKE_INTENSITY = 0.0014;
const PREVIEW_COLLISION_COLOR = 0xff4fd8;
const BOARD_PIXEL_SIZE = BOARD_SIZE * CELL_SIZE;
const SIDE_PANEL_GAP = 28;
const SIDE_PANEL_WIDTH = 176;
const LEFT_PANEL_X = BOARD_ORIGIN.x - SIDE_PANEL_GAP - SIDE_PANEL_WIDTH;
const RIGHT_PANEL_X = BOARD_ORIGIN.x + BOARD_PIXEL_SIZE + SIDE_PANEL_GAP;
const PREVIEW_LINE_WIDTH = Math.max(4, Math.round(CELL_SIZE * 0.08));
const QUEUE_ROW_GAP = 22;
const ZERO_ORIGIN = { x: 0, y: 0 } as const;
const MIN_BOARD_TEXT_PX = 11;
const ONBOARDING_STORAGE_KEY = "energy-duel:onboarding-seen";
const ONBOARDING_FADE_MS = 280;
const SHOW_RIVAL_MOOD_DEBUG =
  import.meta.env.VITE_DEBUG_RIVAL_MOOD === "true";
const ENABLE_MATCH_END_DEBUG =
  import.meta.env.DEV || import.meta.env.VITE_DEBUG_MATCH_END === "true";

interface ExecutionStepVisual {
  step?: StepResult;
  playerStart: TilePosition;
  rivalStart: TilePosition;
  playerEnd: TilePosition;
  rivalEnd: TilePosition;
  previousStun: Record<RobotId, number>;
  collectedPickups: Pickup[];
}

type VolumeSliderKind = "music" | "sfx";
type RulesOverlayMode = "welcome" | "rules";

interface ActiveVolumeSlider {
  kind: VolumeSliderKind;
  x: number;
  width: number;
}

interface DebugMatchEndPreset {
  playerScore: number;
  rivalScore: number;
  stats: MatchStats;
}

interface RobotMachineProfile {
  finReach: number;
  frontReach: number;
  frontShoulder: number;
  innerScale: number;
  hostile: boolean;
}

const ROBOT_CHASSIS_DARK = 0x010713;
const ROBOT_PANEL_DARK = 0x020a12;

const DEBUG_MATCH_END_PRESETS: DebugMatchEndPreset[] = [
  {
    playerScore: 14,
    rivalScore: 9,
    stats: {
      playerPickupsCollected: 8,
      rivalPickupsCollected: 5,
      playerThreePointPickupsCollected: 4,
      rivalThreePointPickupsCollected: 2,
      playerCollisionsWon: 3,
      rivalCollisionsWon: 1,
    },
  },
  {
    playerScore: 7,
    rivalScore: 13,
    stats: {
      playerPickupsCollected: 5,
      rivalPickupsCollected: 8,
      playerThreePointPickupsCollected: 1,
      rivalThreePointPickupsCollected: 4,
      playerCollisionsWon: 1,
      rivalCollisionsWon: 3,
    },
  },
  {
    playerScore: 11,
    rivalScore: 11,
    stats: {
      playerPickupsCollected: 7,
      rivalPickupsCollected: 7,
      playerThreePointPickupsCollected: 3,
      rivalThreePointPickupsCollected: 3,
      playerCollisionsWon: 2,
      rivalCollisionsWon: 2,
    },
  },
];

export class GameScene extends Phaser.Scene {
  private match!: MatchState;
  private round!: RoundState;
  private renderObjects: Phaser.GameObjects.GameObject[] = [];
  private executionTimer?: Phaser.Time.TimerEvent;
  private activeStepVisual?: ExecutionStepVisual;
  private robotContainers: Partial<Record<RobotId, Phaser.GameObjects.Container>> = {};
  private readonly audio = new AudioManager();
  private activeVolumeSlider?: ActiveVolumeSlider;
  private debugMatchEndPresetIndex = 0;
  private rulesOverlayMode: RulesOverlayMode | null = null;
  private inputRegistered = false;
  private sceneStartedAt = 0;
  private firstRevealLogged = false;
  private lastCollisionWinner: RobotId | null = null;
  private layout: GameLayout = computeLayout(GAME_WIDTH, GAME_HEIGHT);
  private boardLayer?: Phaser.GameObjects.Container;
  private activeLayer?: Phaser.GameObjects.Container;
  private compactPanel: "audio" | null = null;
  private rulesPage = 0;
  private lastLayoutKey = "";
  private roundSteps: StepResult[] = [];
  private roundStartPickups: Pickup[] = [];
  private roundSummary: RoundSummary | null = null;
  /** Versioned record of the current match; a replay UI will read this later. */
  private replay!: ReplayRecord;
  private lockedRound?: RoundState;
  private backdrop?: Phaser.GameObjects.Graphics;

  constructor() {
    super("GameScene");
  }

  create(): void {
    this.sceneStartedAt = performance.now();
    this.match = createInitialMatch();
    this.round = createRoundState(this.match.currentRound, {
      seed: this.match.seed,
    });
    this.replay = createReplay(this.match);
    this.rulesOverlayMode = this.hasSeenOnboarding() ? null : "welcome";

    this.refreshLayout();
    if (this.rulesOverlayVisible) {
      this.registerOnboardingInput();
    } else {
      this.registerInput();
    }
    this.registerAudioStartInput();
    this.registerAudioSettingsInput();
    this.scale.on("resize", this.handleResize, this);
    this.events.once("shutdown", () => {
      this.scale.off("resize", this.handleResize, this);
      this.audio.destroy();
    });
    this.render();
  }

  private get compact(): CompactLayout | null {
    return isCompact(this.layout) ? this.layout : null;
  }

  private refreshLayout(): void {
    const { width, height } = this.scale;
    this.layout = computeLayout(width, height, {
      guided: this.match.mode === "guided",
    });

    const camera = this.cameras.main;
    camera.setZoom(this.layout.zoom);
    camera.centerOn(
      this.compact ? width / 2 : GAME_WIDTH / 2,
      this.compact ? height / 2 : GAME_HEIGHT / 2,
    );
    this.drawBackdrop();
  }

  private handleResize(): void {
    if (this.match.status === "executing") {
      // Layout is re-read on the next step render; keep the current step intact.
      return;
    }

    this.render();
  }

  private tileCenter(tile: TilePosition): { x: number; y: number } {
    return getTileCenterAt(tile, ZERO_ORIGIN);
  }

  /** Board-layer font size: keeps tiny board labels readable once the board is scaled down. */
  private boardFontPx(px: number): number {
    const compact = this.compact;

    if (!compact) {
      return px;
    }

    return Math.max(px, Math.ceil(MIN_BOARD_TEXT_PX / compact.board.scale));
  }

  private registerInput(): void {
    if (this.inputRegistered) {
      return;
    }

    this.inputRegistered = true;
    const keyboard = this.input.keyboard;

    if (!keyboard) {
      return;
    }

    const moveBindings: Array<[string, Move]> = [
      ["keydown-UP", "up"],
      ["keydown-W", "up"],
      ["keydown-DOWN", "down"],
      ["keydown-S", "down"],
      ["keydown-LEFT", "left"],
      ["keydown-A", "left"],
      ["keydown-RIGHT", "right"],
      ["keydown-D", "right"],
      ["keydown-SPACE", "wait"],
    ];

    for (const [eventName, move] of moveBindings) {
      keyboard.on(eventName, () => {
        if (move === "wait" && this.match.status === "round-complete") {
          this.continueFromSummary();
          return;
        }

        this.addMove(move);
      });
    }

    keyboard.on("keydown-BACKSPACE", () => this.undoMove());
    keyboard.on("keydown-DELETE", () => this.clearQueue());
    keyboard.on("keydown-C", () => this.clearQueue());
    keyboard.on("keydown-ENTER", () => {
      this.continueFromSummary();
      this.startExecution();
    });
    keyboard.on("keydown-R", () => this.replayMatch());
    keyboard.on("keydown-N", () => this.replayMatch());
    keyboard.on("keydown-K", () => this.skipToStandardMatch());
    keyboard.on("keydown-H", () => this.toggleRulesOverlay());
    keyboard.on("keydown-ESC", () => {
      this.closeCompactPanel();
      this.hideRulesOverlay();
    });

    if (ENABLE_MATCH_END_DEBUG) {
      keyboard.on("keydown-M", () => this.debugJumpToMatchComplete());
      console.debug(
        "[Energy Duel] debug match-end shortcut enabled: press M to cycle final results.",
      );
    }
  }

  private registerAudioStartInput(): void {
    const startMusic = () => this.audio.startMusic();

    this.input.on("pointerdown", startMusic);
    this.input.keyboard?.on("keydown", startMusic);

    // Phaser's event system loses the user-gesture context inside iframes,
    // blocking HTMLAudioElement.play(). Native DOM listeners preserve it.
    const unlockMusic = () => {
      this.audio.startMusic();
      document.removeEventListener("pointerdown", unlockMusic);
      document.removeEventListener("keydown", unlockMusic);
    };
    document.addEventListener("pointerdown", unlockMusic);
    document.addEventListener("keydown", unlockMusic);
  }

  private registerAudioSettingsInput(): void {
    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      this.updateActiveVolumeSlider(pointer);
    });
    this.input.on("pointerup", () => {
      this.stopVolumeSliderDrag();
    });
  }

  private registerOnboardingInput(): void {
    const keyboard = this.input.keyboard;

    keyboard?.once("keydown", () => this.hideRulesOverlay());
  }

  private get rulesOverlayVisible(): boolean {
    return this.rulesOverlayMode !== null;
  }

  private showRulesOverlay(mode: RulesOverlayMode): void {
    if (mode === "rules" && this.match.status === "executing") {
      return;
    }

    this.stopVolumeSliderDrag();
    this.compactPanel = null;
    this.rulesPage = 0;
    this.rulesOverlayMode = mode;
    this.renderIfNotExecuting();
  }

  private hideRulesOverlay(): void {
    if (!this.rulesOverlayVisible) {
      return;
    }

    if (this.rulesOverlayMode === "welcome") {
      this.beginFromWelcome("guided");
      return;
    }

    this.stopVolumeSliderDrag();
    this.rulesOverlayMode = null;
    this.renderIfNotExecuting();
  }

  private beginFromWelcome(mode: MatchMode): void {
    this.stopVolumeSliderDrag();
    this.rulesOverlayMode = null;
    this.rememberOnboardingSeen();
    this.registerInput();

    if (mode === "standard") {
      recordGuideOutcome(this.safeStorage(), "skipped");
    }

    this.startMatch(mode);
  }

  private startMatch(mode: MatchMode): void {
    this.stopExecutionEffects();
    this.roundSummary = null;
    this.match = createInitialMatch(mode);
    this.round = createRoundState(this.match.currentRound, {
      mode,
      seed: this.match.seed,
    });
    this.replay = createReplay(this.match);
    this.lastCollisionWinner = null;
    this.render();
  }

  private skipToStandardMatch(): void {
    if (
      this.rulesOverlayVisible ||
      this.match.mode !== "guided" ||
      this.match.status === "executing"
    ) {
      return;
    }

    recordGuideOutcome(this.safeStorage(), "skipped");
    this.stopExecutionEffects();
    this.match = skipGuidedIntro(this.match);
    this.round = createRoundState(this.match.currentRound, {
      mode: this.match.mode,
      seed: this.match.seed,
    });
    this.replay = createReplay(this.match);
    this.lastCollisionWinner = null;
    this.render();
  }

  private safeStorage(): Storage | undefined {
    try {
      return window.localStorage;
    } catch {
      return undefined;
    }
  }

  private toggleRulesOverlay(): void {
    if (this.rulesOverlayVisible) {
      this.hideRulesOverlay();
      return;
    }

    this.showRulesOverlay("rules");
  }

  private hasSeenOnboarding(): boolean {
    try {
      return window.localStorage.getItem(ONBOARDING_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  }

  private rememberOnboardingSeen(): void {
    try {
      window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "true");
    } catch {
      // Storage can be unavailable in private contexts; the overlay still works.
    }
  }

  private addMove(move: Move): void {
    if (this.rulesOverlayVisible || this.match.status !== "queuing") {
      return;
    }

    const previousQueueLength = this.round.playerQueue.length;
    this.round = queuePlayerMove(this.round, move);

    if (this.round.playerQueue.length > previousQueueLength) {
      this.audio.playQueue();
    }

    this.render();
  }

  private undoMove(): void {
    if (this.rulesOverlayVisible || this.match.status !== "queuing") {
      return;
    }

    this.round = removeLastPlayerMove(this.round);
    this.render();
  }

  private clearQueue(): void {
    if (this.rulesOverlayVisible || this.match.status !== "queuing") {
      return;
    }

    this.round = clearPlayerQueue(this.round);
    this.render();
  }

  private startExecution(): void {
    if (
      this.rulesOverlayVisible ||
      this.match.status !== "queuing" ||
      !isPlayerQueueReady(this.round)
    ) {
      return;
    }

    this.round = lockRoundQueues(this.round);
    this.lockedRound = this.round;
    this.roundSteps = [];
    this.roundStartPickups = this.round.pickups.map((pickup) => ({
      ...pickup,
      tile: { ...pickup.tile },
    }));
    this.roundSummary = null;
    this.lastCollisionWinner = null;
    this.logFirstReveal();
    this.match = {
      ...this.match,
      status: "executing",
    };
    this.activeStepVisual = undefined;
    this.audio.setRoundMusicActive(true);
    this.audio.startMusic();

    this.executionTimer?.remove(false);
    this.executionTimer = undefined;
    this.executeNextStep();
  }

  private logFirstReveal(): void {
    if (this.firstRevealLogged) {
      return;
    }

    this.firstRevealLogged = true;
    const seconds = (performance.now() - this.sceneStartedAt) / 1000;
    console.info(`[Energy Duel] first reveal ${seconds.toFixed(1)}s after load`);
  }

  private replayMatch(): void {
    if (this.rulesOverlayVisible || this.match.status !== "match-complete") {
      return;
    }

    this.restartMatch();
  }

  private debugJumpToMatchComplete(): void {
    if (this.rulesOverlayVisible) {
      return;
    }

    const preset =
      DEBUG_MATCH_END_PRESETS[
        this.debugMatchEndPresetIndex % DEBUG_MATCH_END_PRESETS.length
      ];
    const finalRound = this.match.totalRounds;
    const playerQueue = Array<Move>(this.round.maxSteps).fill("wait");
    const rivalQueue = Array<Move>(this.round.maxSteps).fill("wait");

    this.debugMatchEndPresetIndex += 1;
    this.roundSummary = null;
    this.stopExecutionEffects();
    this.round = {
      ...this.createDebugFinalRoundState(finalRound),
      playerQueue,
      rivalQueue,
      currentExecutionStep: this.round.maxSteps,
    };
    this.match = finishRound({
      ...createInitialMatch(this.match.mode),
      currentRound: finalRound,
      playerScore: preset.playerScore,
      rivalScore: preset.rivalScore,
      stats: { ...preset.stats },
    });
    this.render();
  }

  private executeNextStep(): void {
    if (this.match.status !== "executing") {
      return;
    }

    if (this.round.currentExecutionStep >= this.round.maxSteps) {
      this.completeRound();
      return;
    }

    const stepVisual = this.createExecutionStepVisual();
    const resolution = resolveNextStep(this.round);

    stepVisual.step = resolution.step;
    stepVisual.playerEnd = { ...resolution.step.playerTile };
    stepVisual.rivalEnd = { ...resolution.step.rivalTile };
    const collectedPickups = stepVisual.collectedPickups.filter((pickup) =>
      resolution.step.collectedPickupIds.includes(pickup.id),
    );
    stepVisual.collectedPickups = collectedPickups;

    this.round = resolution.round;
    this.roundSteps.push(resolution.step);
    this.match = applyStepScore(
      this.match,
      resolution.step.playerScoreDelta,
      resolution.step.rivalScoreDelta,
    );
    this.match = this.applyStepStats(
      this.match,
      resolution.step,
      collectedPickups,
    );
    this.activeStepVisual = stepVisual;
    this.lastCollisionWinner = resolution.step.collision
      ? resolution.step.collisionWinner
      : this.lastCollisionWinner;
    this.logStepResult(resolution.step);
    this.render();
    this.playStepAnimation(stepVisual);
  }

  private completeRound(): void {
    this.executionTimer?.remove(false);
    this.executionTimer = undefined;
    this.activeStepVisual = undefined;
    this.audio.setRoundMusicActive(false);
    this.match = finishRound(this.match);

    if (this.lockedRound) {
      this.replay = recordReplayRound(
        this.replay,
        this.lockedRound,
        this.roundSteps,
      );
      this.lockedRound = undefined;
    }

    if (this.match.status === "match-complete") {
      this.replay = finalizeReplay(this.replay, this.match);
    }

    if (this.match.status === "match-complete" && this.match.mode === "guided") {
      recordGuideOutcome(this.safeStorage(), "completed");
    }

    if (this.match.status === "round-complete") {
      this.roundSummary = deriveRoundSummary({
        round: this.match.currentRound,
        totalRounds: this.match.totalRounds,
        steps: this.roundSteps,
        startPickups: this.roundStartPickups,
      });
    }

    this.render();
  }

  private continueFromSummary(): void {
    if (this.rulesOverlayVisible || this.match.status !== "round-complete") {
      return;
    }

    this.beginNextRound();
  }

  private logStepResult(step: StepResult): void {
    const stunConsumedBy: RobotId[] = [];

    if (step.playerWasStunned) {
      stunConsumedBy.push("player");
    }

    if (step.rivalWasStunned) {
      stunConsumedBy.push("rival");
    }

    console.debug("[Energy Duel] resolved step", {
      round: this.match.currentRound,
      step: step.step,
      playerQueuedMove: step.playerQueuedMove,
      rivalQueuedMove: step.rivalQueuedMove,
      playerMove: step.playerMove,
      rivalMove: step.rivalMove,
      playerWasStunned: step.playerWasStunned,
      rivalWasStunned: step.rivalWasStunned,
      playerTile: step.playerTile,
      rivalTile: step.rivalTile,
      collision: step.collision,
      collisionWinner: step.collisionWinner,
      collisionLoser: step.collisionLoser,
      stunAppliedTo: step.collisionLoser,
      stunConsumedBy,
      collectedPickupIds: step.collectedPickupIds,
      playerScoreDelta: step.playerScoreDelta,
      rivalScoreDelta: step.rivalScoreDelta,
      stun: step.stun,
      playerScore: this.match.playerScore,
      rivalScore: this.match.rivalScore,
    });
  }

  private createExecutionStepVisual(): ExecutionStepVisual {
    return {
      playerStart: { ...this.round.player.tile },
      rivalStart: { ...this.round.rival.tile },
      playerEnd: { ...this.round.player.tile },
      rivalEnd: { ...this.round.rival.tile },
      previousStun: { ...this.round.stun },
      collectedPickups: this.round.pickups.map((pickup) => ({
        ...pickup,
        tile: { ...pickup.tile },
      })),
    };
  }

  private applyStepStats(
    match: MatchState,
    step: StepResult,
    collectedPickups: Pickup[],
  ): MatchState {
    const stats = { ...match.stats };

    if (step.collisionWinner === "player") {
      stats.playerCollisionsWon += 1;
    } else if (step.collisionWinner === "rival") {
      stats.rivalCollisionsWon += 1;
    }

    for (const pickup of collectedPickups) {
      const collector = this.getPickupCollector(step, pickup);

      if (collector) {
        this.addPickupStat(stats, collector, pickup);
      }
    }

    return {
      ...match,
      stats,
    };
  }

  private getPickupCollector(step: StepResult, pickup: Pickup): RobotId | null {
    if (step.collision && step.collisionWinner) {
      return step.collisionWinner;
    }

    if (step.playerScoreDelta > 0 && sameTile(step.playerTile, pickup.tile)) {
      return "player";
    }

    if (step.rivalScoreDelta > 0 && sameTile(step.rivalTile, pickup.tile)) {
      return "rival";
    }

    return null;
  }

  private addPickupStat(
    stats: MatchStats,
    collector: RobotId,
    pickup: Pickup,
  ): void {
    if (collector === "player") {
      stats.playerPickupsCollected += 1;

      if (pickup.value === 3) {
        stats.playerThreePointPickupsCollected += 1;
      }

      return;
    }

    stats.rivalPickupsCollected += 1;

    if (pickup.value === 3) {
      stats.rivalThreePointPickupsCollected += 1;
    }
  }

  private playStepAnimation(visual: ExecutionStepVisual): void {
    const playerContainer = this.robotContainers.player;
    const rivalContainer = this.robotContainers.rival;

    if (!playerContainer || !rivalContainer) {
      this.finishStepVisual();
      return;
    }

    const playerEnd = this.tileCenter(visual.playerEnd);
    const rivalEnd = this.tileCenter(visual.rivalEnd);

    this.showMovementTrails(visual);
    this.playMovementAudio(visual);

    this.tweens.add({
      targets: playerContainer,
      x: playerEnd.x,
      y: playerEnd.y,
      duration: EXECUTION_MOVE_TWEEN_MS,
      ease: "Cubic.easeOut",
    });
    this.tweens.add({
      targets: rivalContainer,
      x: rivalEnd.x,
      y: rivalEnd.y,
      duration: EXECUTION_MOVE_TWEEN_MS,
      ease: "Cubic.easeOut",
    });

    this.scheduleExecutionCallback(() => {
      this.playStepFeedback(visual);
      this.scheduleExecutionCallback(
        () => this.finishStepVisual(),
        EXECUTION_FEEDBACK_HOLD_MS,
      );
    }, EXECUTION_MOVE_TWEEN_MS);
  }

  private playMovementAudio(visual: ExecutionStepVisual): void {
    const playerMoved = !sameTile(visual.playerStart, visual.playerEnd);
    const rivalMoved = !sameTile(visual.rivalStart, visual.rivalEnd);

    if (playerMoved || rivalMoved) {
      this.audio.playMove();
    }
  }

  private showMovementTrails(visual: ExecutionStepVisual): void {
    this.showMovementTrail("player", visual.playerStart, visual.playerEnd);
    this.showMovementTrail("rival", visual.rivalStart, visual.rivalEnd);
  }

  private showMovementTrail(
    robot: RobotId,
    fromTile: TilePosition,
    toTile: TilePosition,
  ): void {
    if (sameTile(fromTile, toTile)) {
      return;
    }

    const from = this.tileCenter(fromTile);
    const to = this.tileCenter(toTile);
    const g = this.trackBoard(this.add.graphics());
    const glowColor =
      robot === "player" ? TRON_THEME.player : TRON_THEME.rivalAccent;
    const coreColor =
      robot === "player" ? TRON_THEME.playerAccent : TRON_THEME.rival;

    g.setDepth(2.7);
    g.setBlendMode(Phaser.BlendModes.ADD);
    g.lineStyle(MOVEMENT_TRAIL_GLOW_WIDTH, glowColor, 0.16);
    g.lineBetween(from.x, from.y, to.x, to.y);
    g.lineStyle(
      Math.max(MOVEMENT_TRAIL_CORE_WIDTH + 3, 7),
      glowColor,
      robot === "player" ? 0.22 : 0.2,
    );
    g.lineBetween(from.x, from.y, to.x, to.y);
    g.lineStyle(MOVEMENT_TRAIL_CORE_WIDTH, coreColor, 0.72);
    g.lineBetween(from.x, from.y, to.x, to.y);
    g.fillStyle(glowColor, 0.11);
    g.fillCircle(from.x, from.y, MOVEMENT_TRAIL_GLOW_WIDTH * 0.42);
    g.fillCircle(to.x, to.y, MOVEMENT_TRAIL_GLOW_WIDTH * 0.42);
    g.fillStyle(coreColor, 0.38);
    g.fillCircle(to.x, to.y, MOVEMENT_TRAIL_CORE_WIDTH * 0.75);

    this.tweens.add({
      targets: g,
      alpha: 0,
      duration: MOVEMENT_TRAIL_FADE_MS,
      delay: 20,
      ease: "Cubic.easeOut",
    });
  }

  private playStepFeedback(visual: ExecutionStepVisual): void {
    const step = visual.step;

    if (!step) {
      return;
    }

    this.playStepAudio(step, visual.collectedPickups);

    for (const pickup of visual.collectedPickups) {
      this.showPickupCollectionFlash(pickup);
    }

    if (step.playerScoreDelta > 0) {
      this.showScorePop("player", step.playerScoreDelta, visual.playerEnd);
    }

    if (step.rivalScoreDelta > 0) {
      this.showScorePop("rival", step.rivalScoreDelta, visual.rivalEnd);
    }

    if (step.collision && step.collisionWinner && step.collisionLoser) {
      this.showCollisionImpact(step.collisionWinner, step.collisionLoser);
    }
  }

  private playStepAudio(step: StepResult, collectedPickups: Pickup[]): void {
    if (step.collision) {
      this.audio.playCollision();
    }

    this.playPickupAudio(collectedPickups);
  }

  private playPickupAudio(collectedPickups: Pickup[]): void {
    if (collectedPickups.some((pickup) => pickup.value === 3)) {
      this.audio.playPickupBig();
      return;
    }

    if (collectedPickups.length > 0) {
      this.audio.playPickupSmall();
    }
  }

  private finishStepVisual(): void {
    if (this.match.status !== "executing") {
      return;
    }

    this.activeStepVisual = undefined;

    if (this.round.currentExecutionStep >= this.round.maxSteps) {
      this.completeRound();
      return;
    }

    this.executeNextStep();
  }

  private scheduleExecutionCallback(callback: () => void, delay: number): void {
    this.executionTimer?.remove(false);
    this.executionTimer = this.time.delayedCall(delay, () => {
      this.executionTimer = undefined;
      callback();
    });
  }

  private beginNextRound(): void {
    if (this.match.status !== "round-complete") {
      return;
    }

    this.roundSummary = null;
    this.match = startNextRound(this.match);
    this.round = createNextRoundState(this.match, this.round);
    this.activeStepVisual = undefined;
    this.render();
  }

  private restartMatch(): void {
    this.stopExecutionEffects();
    this.roundSummary = null;
    this.match = createRestartMatch(this.match);
    this.round = createRoundState(this.match.currentRound, {
      mode: this.match.mode,
      seed: this.match.seed,
    });
    this.replay = createReplay(this.match);
    this.lastCollisionWinner = null;
    this.render();
  }

  private stopExecutionEffects(): void {
    this.executionTimer?.remove(false);
    this.executionTimer = undefined;
    this.activeStepVisual = undefined;
    this.audio.setRoundMusicActive(false);
    this.tweens.killAll();
  }

  private createDebugFinalRoundState(finalRound: number): RoundState {
    const mode = this.match.mode;
    let debugRound = createRoundState(1, { mode, seed: this.match.seed });

    for (let roundNumber = 2; roundNumber <= finalRound; roundNumber += 1) {
      debugRound = createRoundState(roundNumber, {
        mode,
        seed: this.match.seed,
        previousBoard: debugRound.board,
        previousPickups: debugRound.pickups,
        robotTiles: {
          player: debugRound.player.tile,
          rival: debugRound.rival.tile,
        },
      });
    }

    return debugRound;
  }

  private render(): void {
    this.syncLayout();
    this.clearRenderObjects();
    const preview =
      this.match.status === "queuing" ? createMovePreview(this.round) : undefined;

    this.beginBoardLayer();
    this.drawBoard();
    this.drawPreviewPaths(preview);
    this.drawPickups();
    this.drawPreviewPickupClaims(preview);
    this.drawRobots();
    this.activeLayer = undefined;
    this.drawExecutionStepBadge();
    this.drawHud();

    if (this.rulesOverlayVisible) {
      this.drawRulesOverlay();
    }
  }

  private syncLayout(): void {
    const key = `${this.scale.width}x${this.scale.height}:${this.match.mode}`;

    if (key === this.lastLayoutKey) {
      return;
    }

    this.lastLayoutKey = key;
    this.refreshLayout();
  }

  /** Everything on the board is drawn at 64px-cell design size inside one scalable layer. */
  private beginBoardLayer(): void {
    const compact = this.compact;
    const origin = compact ? compact.board : BOARD_ORIGIN;
    const layer = this.track(this.add.container(origin.x, origin.y));

    layer.setScale(compact ? compact.board.scale : 1);
    layer.setDepth(0);
    this.boardLayer = layer;
    this.activeLayer = layer;
  }

  private clearRenderObjects(): void {
    for (const object of this.renderObjects) {
      this.tweens.killTweensOf(object);
      object.destroy();
    }

    this.renderObjects = [];
  }

  private track<T extends Phaser.GameObjects.GameObject>(object: T): T {
    this.renderObjects.push(object);
    this.activeLayer?.add(object);
    return object;
  }

  private trackBoard<T extends Phaser.GameObjects.GameObject>(object: T): T {
    this.renderObjects.push(object);
    this.boardLayer?.add(object);
    return object;
  }

  private drawBackdrop(): void {
    this.cameras.main.setBackgroundColor(TRON_THEME.backgroundCss);
    this.backdrop?.destroy();

    const zoom = this.layout.zoom;
    const worldW = this.layout.width / zoom;
    const worldH = this.layout.height / zoom;
    const centerX = this.compact ? this.layout.width / 2 : GAME_WIDTH / 2;
    const centerY = this.compact ? this.layout.height / 2 : GAME_HEIGHT / 2;
    const left = Math.floor((centerX - worldW / 2) / 96) * 96;
    const top = Math.floor((centerY - worldH / 2) / 96) * 96;
    const right = centerX + worldW / 2;
    const bottom = centerY + worldH / 2;
    const g = this.add.graphics();

    this.backdrop = g;
    g.setDepth(-10);
    g.fillStyle(TRON_THEME.background, 1);
    g.fillRect(left, top, right - left, bottom - top);
    g.setBlendMode(Phaser.BlendModes.ADD);

    for (let x = left; x <= right; x += 48) {
      g.lineStyle(1, TRON_THEME.backdropLine, x % 96 === 0 ? 0.1 : 0.05);
      g.lineBetween(x, top, x, bottom);
    }

    for (let y = top; y <= bottom; y += 48) {
      g.lineStyle(1, TRON_THEME.backdropLine, y % 96 === 0 ? 0.11 : 0.06);
      g.lineBetween(left, y, right, y);
    }

    g.lineStyle(1, TRON_THEME.rivalAccent, 0.04);

    const span = bottom - top;

    for (let x = left - span; x < right + span; x += 96) {
      g.lineBetween(x, bottom, x + span, top);
    }
  }

  private drawBoard(): void {
    const g = this.track(this.add.graphics());

    g.setDepth(0);
    g.setBlendMode(Phaser.BlendModes.ADD);
    g.lineStyle(14, TRON_THEME.boardGlow, 0.05);
    g.strokeRect(
      0 - 18,
      0 - 18,
      BOARD_PIXEL_SIZE + 36,
      BOARD_PIXEL_SIZE + 36,
    );
    g.lineStyle(8, TRON_THEME.boardGlow, 0.1);
    g.strokeRect(
      0 - 10,
      0 - 10,
      BOARD_PIXEL_SIZE + 20,
      BOARD_PIXEL_SIZE + 20,
    );
    g.lineStyle(3, TRON_THEME.boardGlow, 0.52);
    g.strokeRect(
      0 - 4,
      0 - 4,
      BOARD_PIXEL_SIZE + 8,
      BOARD_PIXEL_SIZE + 8,
    );

    g.setBlendMode(Phaser.BlendModes.NORMAL);
    g.fillStyle(TRON_THEME.boardFill, 0.94);
    g.fillRect(0, 0, BOARD_PIXEL_SIZE, BOARD_PIXEL_SIZE);

    for (let index = 0; index <= BOARD_SIZE; index += 1) {
      const offset = index * CELL_SIZE;
      const isEdge = index === 0 || index === BOARD_SIZE;

      g.lineStyle(isEdge ? 9 : 5, TRON_THEME.grid, isEdge ? 0.18 : 0.1);
      g.lineBetween(
        0 + offset,
        0,
        0 + offset,
        0 + BOARD_PIXEL_SIZE,
      );
      g.lineBetween(
        0,
        0 + offset,
        0 + BOARD_PIXEL_SIZE,
        0 + offset,
      );

      g.lineStyle(isEdge ? 3 : 1, TRON_THEME.grid, isEdge ? 0.95 : 0.74);
      g.lineBetween(
        0 + offset,
        0,
        0 + offset,
        0 + BOARD_PIXEL_SIZE,
      );
      g.lineBetween(
        0,
        0 + offset,
        0 + BOARD_PIXEL_SIZE,
        0 + offset,
      );
    }

    this.drawBoardCornerBrackets(g);

    for (const blocker of this.round.board.blockers) {
      this.drawBlocker(blocker);
    }
  }

  private drawBoardCornerBrackets(g: Phaser.GameObjects.Graphics): void {
    const x = 0 - 11;
    const y = 0 - 11;
    const size = BOARD_PIXEL_SIZE + 22;
    const bracket = 34;

    g.lineStyle(3, TRON_THEME.rivalAccent, 0.5);
    g.lineBetween(x, y, x + bracket, y);
    g.lineBetween(x, y, x, y + bracket);
    g.lineBetween(x + size, y, x + size - bracket, y);
    g.lineBetween(x + size, y, x + size, y + bracket);
    g.lineBetween(x, y + size, x + bracket, y + size);
    g.lineBetween(x, y + size, x, y + size - bracket);
    g.lineBetween(x + size, y + size, x + size - bracket, y + size);
    g.lineBetween(x + size, y + size, x + size, y + size - bracket);
  }

  private drawBlocker(tile: TilePosition): void {
    const center = this.tileCenter(tile);
    const size = CELL_SIZE - 14;
    const g = this.track(this.add.graphics());
    const x = center.x - size / 2;
    const y = center.y - size / 2;

    g.setDepth(0.8);
    g.fillStyle(TRON_THEME.blockerFill, 0.98);
    g.fillRoundedRect(x, y, size, size, 5);
    g.lineStyle(8, TRON_THEME.blockerEdge, 0.1);
    g.strokeRoundedRect(x - 2, y - 2, size + 4, size + 4, 7);
    g.lineStyle(2, TRON_THEME.blockerEdge, 0.86);
    g.strokeRoundedRect(x, y, size, size, 5);
    g.lineStyle(1, TRON_THEME.blockerAccent, 0.62);
    g.strokeRoundedRect(x + 7, y + 7, size - 14, size - 14, 3);
    g.lineStyle(1, TRON_THEME.gridDim, 0.72);
    g.lineBetween(x + 10, y + 16, x + size - 10, y + 16);
    g.lineBetween(x + 10, y + size - 16, x + size - 10, y + size - 16);
    g.lineStyle(2, TRON_THEME.blockerAccent, 0.36);
    g.lineBetween(x + 11, y + size - 11, x + size - 11, y + 11);

    g.setAlpha(0.86 + Math.random() * 0.1);
    this.tweens.add({
      targets: g,
      alpha: 0.66,
      duration: 360 + Phaser.Math.Between(0, 260),
      yoyo: true,
      repeat: -1,
      delay: Phaser.Math.Between(0, 320),
      ease: "Sine.easeInOut",
    });
  }

  private drawPickups(): void {
    for (const pickup of this.round.pickups) {
      const center = this.tileCenter(pickup.tile);
      const style = getPickupStyle(pickup.value);
      const halo = this.add.graphics();
      const body = this.add.graphics();
      const isHighValue = pickup.value === 3;

      halo.setBlendMode(Phaser.BlendModes.ADD);
      halo.fillStyle(style.ring, isHighValue ? 0.18 : 0.1);
      halo.fillCircle(0, 0, isHighValue ? 28 : 20);
      halo.lineStyle(isHighValue ? 7 : 5, style.ring, isHighValue ? 0.16 : 0.1);
      halo.strokeCircle(0, 0, isHighValue ? 24 : 16);

      body.lineStyle(isHighValue ? 4 : 2, style.ring, 0.95);
      body.strokeCircle(0, 0, isHighValue ? 18 : 11);
      body.lineStyle(1, style.core, 0.7);
      body.strokeCircle(0, 0, isHighValue ? 9 : 6);
      body.fillStyle(style.core, isHighValue ? 0.96 : 0.92);
      body.fillCircle(0, 0, isHighValue ? 7 : 4);

      const label = this.applyTextGlow(
        this.add
          .text(0, isHighValue ? 27 : 22, String(pickup.value), {
            color: style.text,
            fontFamily: TRON_THEME.fontFamily,
            fontSize: `${this.boardFontPx(isHighValue ? 15 : 12)}px`,
            fontStyle: "800",
          })
          .setOrigin(0.5),
        style.text,
        isHighValue ? 12 : 8,
      );

      const container = this.track(
        this.add.container(center.x, center.y, [halo, body, label]),
      );
      container.setDepth(1.3);

      this.tweens.add({
        targets: container,
        alpha: isHighValue ? 0.76 : 0.84,
        scale: isHighValue ? 1.14 : 1.08,
        duration: isHighValue ? 680 : 1050,
        yoyo: true,
        repeat: -1,
        delay: Phaser.Math.Between(0, 240),
        ease: "Sine.easeInOut",
      });
    }
  }

  private drawPreviewPaths(preview: MovePreview | undefined): void {
    if (!preview) {
      return;
    }

    this.drawPreviewPath(preview.playerPath, preview.committedSteps);
  }

  private drawPreviewPath(
    path: TilePosition[],
    committedSteps: number,
  ): void {
    if (path.length < 2) {
      return;
    }

    const g = this.track(this.add.graphics());
    const color = this.robotThemeColor("player");
    const lineWidth = PREVIEW_LINE_WIDTH;

    g.setDepth(1);

    for (let step = 1; step < path.length; step += 1) {
      const from = this.previewPoint(path[step - 1]);
      const to = this.previewPoint(path[step]);
      const alpha = this.previewStepAlpha(step, committedSteps);

      g.lineStyle(lineWidth + 7, color, alpha * 0.22);
      g.lineBetween(from.x, from.y, to.x, to.y);
      g.lineStyle(lineWidth, color, alpha);
      g.lineBetween(from.x, from.y, to.x, to.y);
    }

    for (let step = 1; step < path.length; step += 1) {
      const point = this.previewPoint(path[step]);
      const alpha = this.previewStepAlpha(step, committedSteps);
      const radius = Math.round(this.boardFontPx(10) * 0.7);

      g.fillStyle(color, alpha * 0.15);
      g.fillCircle(point.x, point.y, radius + 7);
      g.fillStyle(TRON_THEME.boardFill, 0.88);
      g.fillCircle(point.x, point.y, radius);
      g.lineStyle(5, color, alpha * 0.24);
      g.strokeCircle(point.x, point.y, radius + 4);
      g.lineStyle(3, color, alpha);
      g.strokeCircle(point.x, point.y, radius);
      this.drawPreviewStepNumber(point, step, alpha);
    }
  }

  private drawPreviewPickupClaims(preview: MovePreview | undefined): void {
    if (!preview) {
      return;
    }

    for (const claim of preview.pickupClaims) {
      this.drawPreviewPickupClaim(claim);
    }
  }

  private drawPreviewPickupClaim(claim: PreviewPickupClaim): void {
    const center = this.tileCenter(claim.pickup.tile);
    const color = this.robotThemeColor("player");
    const alpha = 0.82;
    const radius = claim.pickup.value === 3 ? 27 : 24;
    const g = this.track(this.add.graphics());
    const factor = this.boardFontPx(10) / 10;
    const badgeX = center.x - 22;
    const badgeY = center.y - 22;

    g.setDepth(2);
    g.lineStyle(4, color, alpha);
    g.strokeCircle(center.x, center.y, radius);
    g.fillStyle(color, 0.92);
    g.fillCircle(badgeX, badgeY, 9 * factor);

    const label = this.track(
      this.add
        .text(badgeX, badgeY, "Y", {
          color: "#061018",
          fontFamily: TRON_THEME.fontFamily,
          fontSize: `${10 * factor}px`,
          fontStyle: "900",
        })
        .setOrigin(0.5),
    );
    label.setDepth(2.1);
  }

  private drawRobots(): void {
    const playerTile = this.activeStepVisual?.playerStart ?? this.round.player.tile;
    const rivalTile = this.activeStepVisual?.rivalStart ?? this.round.rival.tile;
    const playerStunned = this.activeStepVisual
      ? this.activeStepVisual.previousStun.player > 0
      : this.round.stun.player > 0;
    const rivalStunned = this.activeStepVisual
      ? this.activeStepVisual.previousStun.rival > 0
      : this.round.stun.rival > 0;

    this.robotContainers = {};
    this.robotContainers.player = this.drawRobot(
      playerTile,
      "player",
      playerStunned,
    );
    this.robotContainers.rival = this.drawRobot(
      rivalTile,
      "rival",
      rivalStunned,
    );
  }

  private drawRobot(
    tile: TilePosition,
    robot: RobotId,
    stunned: boolean,
  ): Phaser.GameObjects.Container {
    const center = this.tileCenter(tile);
    const primary = this.robotThemeColor(robot);
    const accent = this.robotAccentColor(robot);
    const facing = this.robotFacing(robot);
    const profile = this.robotMachineProfile(robot);
    const leftFin = this.robotSideFinPoints("left", profile);
    const rightFin = this.robotSideFinPoints("right", profile);
    const innerPanel = this.robotInnerPanelPoints(profile.innerScale);
    const glow = this.add.graphics();
    const body = this.add.graphics();
    const visual = this.add.container(0, 0, [glow, body]);
    const badge = this.createRobotOwnerBadge(robot, tile);

    glow.setBlendMode(Phaser.BlendModes.ADD);
    glow.fillStyle(primary, stunned ? 0.04 : 0.065);
    glow.fillPoints(this.robotHullPoints(1.1), true);
    glow.lineStyle(
      5,
      stunned ? TRON_THEME.rivalAccent : primary,
      stunned ? 0.16 : 0.1,
    );
    glow.strokePoints(this.robotHullPoints(1.07), true, true);
    glow.lineStyle(2, accent, robot === "rival" ? 0.12 : 0.075);
    glow.strokePoints(this.robotHullPoints(1.16), true, true);

    body.fillStyle(TRON_THEME.robotShell, stunned ? 0.78 : 0.96);
    body.fillPoints(leftFin, true);
    body.fillPoints(rightFin, true);
    body.lineStyle(3, ROBOT_CHASSIS_DARK, stunned ? 0.72 : 0.92);
    body.strokePoints(leftFin, true, true);
    body.strokePoints(rightFin, true, true);
    body.lineStyle(2, primary, stunned ? 0.5 : 0.76);
    body.strokePoints(leftFin, true, true);
    body.strokePoints(rightFin, true, true);
    body.lineStyle(2, accent, profile.hostile ? 0.72 : 0.54);
    body.lineBetween(-profile.finReach + 4, -4, -22, -1);
    body.lineBetween(profile.finReach - 4, -4, 22, -1);
    body.lineStyle(1, ROBOT_PANEL_DARK, 0.94);
    body.lineBetween(-profile.finReach + 4, 6, -19, 9);
    body.lineBetween(profile.finReach - 4, 6, 19, 9);

    body.fillStyle(TRON_THEME.robotShell, stunned ? 0.9 : 1);
    body.fillPoints(this.robotHullPoints(), true);
    body.lineStyle(6, ROBOT_CHASSIS_DARK, stunned ? 0.78 : 0.96);
    body.strokePoints(this.robotHullPoints(), true, true);
    body.lineStyle(
      stunned ? 4 : 3,
      stunned ? TRON_THEME.rivalAccent : primary,
      0.94,
    );
    body.strokePoints(this.robotHullPoints(), true, true);
    body.fillStyle(TRON_THEME.panelFill, stunned ? 0.72 : 0.94);
    body.fillPoints(innerPanel, true);
    body.lineStyle(2, ROBOT_CHASSIS_DARK, 0.86);
    body.strokePoints(innerPanel, true, true);
    body.lineStyle(1, accent, profile.hostile ? 0.88 : 0.72);
    body.strokePoints(innerPanel, true, true);
    this.drawRobotPanelLines(body, primary, accent, profile);

    this.drawRobotFrontModule(body, primary, accent, profile, stunned);
    this.drawRobotCore(body, primary, accent, profile, stunned);

    if (stunned) {
      body.lineStyle(3, TRON_THEME.rivalAccent, 0.96);
      body.lineBetween(-13, -13, 13, 13);
      body.lineBetween(13, -13, -13, 13);
    }

    visual.setRotation(this.robotFacingRotation(robot, facing));

    const container = this.track(
      this.add.container(center.x, center.y, [visual, ...badge]),
    );
    container.setDepth(3);
    return container;
  }

  private createRobotOwnerBadge(
    robot: RobotId,
    tile: TilePosition,
  ): Array<Phaser.GameObjects.Graphics | Phaser.GameObjects.Text> {
    const label = this.robotName(robot).toUpperCase();
    const color = this.robotThemeColor(robot);
    const accent = this.robotAccentColor(robot);
    const fontPx = this.boardFontPx(10);
    const factor = fontPx / 10;
    const width = (robot === "player" ? 46 : 62) * factor;
    const height = 18 * factor;
    const y = (tile.row === 0 ? 1 : -1) * (29 + height / 2);
    const cellCenter = tile.col * CELL_SIZE + CELL_SIZE / 2;
    const dx = Math.max(
      width / 2 - cellCenter,
      Math.min(0, BOARD_PIXEL_SIZE - cellCenter - width / 2),
    );
    const bg = this.add.graphics();

    bg.fillStyle(ROBOT_PANEL_DARK, 0.88);
    bg.fillRoundedRect(dx - width / 2, y - height / 2, width, height, 5);
    bg.lineStyle(4, color, 0.1);
    bg.strokeRoundedRect(
      dx - width / 2 - 1,
      y - height / 2 - 1,
      width + 2,
      height + 2,
      6,
    );
    bg.lineStyle(1, accent, 0.88);
    bg.strokeRoundedRect(dx - width / 2, y - height / 2, width, height, 5);

    const text = this.add
      .text(dx, y, label, {
        color: TRON_THEME.textPrimary,
        fontFamily: TRON_THEME.fontFamily,
        fontSize: `${fontPx}px`,
        fontStyle: "900",
      })
      .setOrigin(0.5);
    this.applyTextGlow(text, this.cssColor(color), 8);

    return [bg, text];
  }

  private robotHullPoints(scale = 1): Phaser.Math.Vector2[] {
    return [
      new Phaser.Math.Vector2(-10 * scale, -24 * scale),
      new Phaser.Math.Vector2(10 * scale, -24 * scale),
      new Phaser.Math.Vector2(22 * scale, -15 * scale),
      new Phaser.Math.Vector2(27 * scale, 1 * scale),
      new Phaser.Math.Vector2(18 * scale, 18 * scale),
      new Phaser.Math.Vector2(8 * scale, 23 * scale),
      new Phaser.Math.Vector2(-8 * scale, 23 * scale),
      new Phaser.Math.Vector2(-18 * scale, 18 * scale),
      new Phaser.Math.Vector2(-27 * scale, 1 * scale),
      new Phaser.Math.Vector2(-22 * scale, -15 * scale),
    ];
  }

  private robotInnerPanelPoints(scale: number): Phaser.Math.Vector2[] {
    return [
      new Phaser.Math.Vector2(-9 * scale, -16 * scale),
      new Phaser.Math.Vector2(9 * scale, -16 * scale),
      new Phaser.Math.Vector2(17 * scale, -7 * scale),
      new Phaser.Math.Vector2(16 * scale, 9 * scale),
      new Phaser.Math.Vector2(7 * scale, 16 * scale),
      new Phaser.Math.Vector2(-7 * scale, 16 * scale),
      new Phaser.Math.Vector2(-16 * scale, 9 * scale),
      new Phaser.Math.Vector2(-17 * scale, -7 * scale),
    ];
  }

  private robotSideFinPoints(
    side: "left" | "right",
    profile: RobotMachineProfile,
  ): Phaser.Math.Vector2[] {
    const sign = side === "left" ? -1 : 1;
    const inner = 19 * sign;
    const outer = profile.finReach * sign;

    if (profile.hostile) {
      return [
        new Phaser.Math.Vector2(inner, -14),
        new Phaser.Math.Vector2(outer, -9),
        new Phaser.Math.Vector2((profile.finReach - 4) * sign, 1),
        new Phaser.Math.Vector2(outer, 10),
        new Phaser.Math.Vector2(20 * sign, 17),
        new Phaser.Math.Vector2(15 * sign, 5),
        new Phaser.Math.Vector2(16 * sign, -8),
      ];
    }

    return [
      new Phaser.Math.Vector2(inner, -13),
      new Phaser.Math.Vector2(outer, -7),
      new Phaser.Math.Vector2(outer, 8),
      new Phaser.Math.Vector2(20 * sign, 16),
      new Phaser.Math.Vector2(16 * sign, 7),
      new Phaser.Math.Vector2(16 * sign, -7),
    ];
  }

  private drawRobotPanelLines(
    g: Phaser.GameObjects.Graphics,
    primary: number,
    accent: number,
    profile: RobotMachineProfile,
  ): void {
    g.lineStyle(1, TRON_THEME.gridDim, 0.78);

    if (profile.hostile) {
      g.lineBetween(-16, -9, -7, -4);
      g.lineBetween(16, -9, 7, -4);
      g.lineBetween(-17, 10, -8, 14);
      g.lineBetween(17, 10, 8, 14);
      g.lineStyle(2, accent, 0.68);
      g.lineBetween(-15, -1, -8, 4);
      g.lineBetween(15, -1, 8, 4);
      g.lineStyle(1, primary, 0.58);
      g.lineBetween(-5, -15, 0, -10);
      g.lineBetween(5, -15, 0, -10);
      return;
    }

    g.lineBetween(-14, -8, -6, -7);
    g.lineBetween(14, -8, 6, -7);
    g.lineBetween(-15, 10, -6, 13);
    g.lineBetween(15, 10, 6, 13);
    g.lineStyle(2, primary, 0.54);
    g.lineBetween(-12, -2, -7, 3);
    g.lineBetween(12, -2, 7, 3);
    g.lineStyle(1, accent, 0.52);
    g.lineBetween(-4, -15, 4, -15);
    g.lineBetween(-4, 16, 4, 16);
  }

  private drawRobotFrontModule(
    g: Phaser.GameObjects.Graphics,
    primary: number,
    accent: number,
    profile: RobotMachineProfile,
    stunned: boolean,
  ): void {
    const frontPlate = profile.hostile
      ? [
          new Phaser.Math.Vector2(-10, -profile.frontReach + 1),
          new Phaser.Math.Vector2(0, -profile.frontReach),
          new Phaser.Math.Vector2(10, -profile.frontReach + 1),
          new Phaser.Math.Vector2(profile.frontShoulder, -18),
          new Phaser.Math.Vector2(9, -10),
          new Phaser.Math.Vector2(0, -13),
          new Phaser.Math.Vector2(-9, -10),
          new Phaser.Math.Vector2(-profile.frontShoulder, -18),
        ]
      : [
          new Phaser.Math.Vector2(-10, -profile.frontReach),
          new Phaser.Math.Vector2(10, -profile.frontReach),
          new Phaser.Math.Vector2(profile.frontShoulder, -19),
          new Phaser.Math.Vector2(9, -11),
          new Phaser.Math.Vector2(-9, -11),
          new Phaser.Math.Vector2(-profile.frontShoulder, -19),
        ];

    g.fillStyle(accent, profile.hostile ? 0.34 : 0.24);
    g.fillPoints(frontPlate, true);
    g.lineStyle(3, ROBOT_CHASSIS_DARK, 0.92);
    g.strokePoints(frontPlate, true, true);
    g.lineStyle(2, stunned ? TRON_THEME.rivalAccent : primary, 0.88);
    g.strokePoints(frontPlate, true, true);

    if (profile.hostile) {
      g.fillStyle(ROBOT_CHASSIS_DARK, 0.96);
      g.fillPoints(
        [
          new Phaser.Math.Vector2(-4, -profile.frontReach + 2),
          new Phaser.Math.Vector2(4, -profile.frontReach + 2),
          new Phaser.Math.Vector2(0, -profile.frontReach + 6),
        ],
        true,
      );
      g.lineStyle(2, accent, 0.96);
      g.lineBetween(-7, -20, 0, -23);
      g.lineBetween(0, -23, 7, -20);
      g.lineStyle(1, 0xf4fdff, 0.62);
      g.lineBetween(-5, -22, 5, -22);
      g.lineStyle(2, primary, 0.62);
      g.lineBetween(-13, -19, -8, -17);
      return;
    }

    g.fillStyle(ROBOT_CHASSIS_DARK, 0.96);
    g.fillRect(-4, -profile.frontReach + 1, 8, 3);
    g.lineStyle(2, accent, 0.84);
    g.lineBetween(-8, -18, 8, -18);
    g.lineStyle(1, 0xf4fdff, 0.62);
    g.lineBetween(-5, -22, 5, -22);
    g.fillStyle(primary, 0.76);
    g.fillRect(7, -24, 3, 6);
  }

  private drawRobotCore(
    g: Phaser.GameObjects.Graphics,
    primary: number,
    accent: number,
    profile: RobotMachineProfile,
    stunned: boolean,
  ): void {
    const coreY = 2;

    g.fillStyle(ROBOT_PANEL_DARK, stunned ? 0.78 : 0.96);
    g.fillCircle(0, coreY, 13);
    g.lineStyle(2, primary, stunned ? 0.58 : 0.86);
    g.strokeCircle(0, coreY, 12);
    g.lineStyle(1, accent, profile.hostile ? 0.94 : 0.82);

    if (profile.hostile) {
      g.strokePoints(
        [
          new Phaser.Math.Vector2(0, coreY - 11),
          new Phaser.Math.Vector2(12, coreY),
          new Phaser.Math.Vector2(0, coreY + 11),
          new Phaser.Math.Vector2(-12, coreY),
        ],
        true,
        true,
      );
    } else {
      g.strokeCircle(0, coreY, 8);
      g.lineStyle(1, primary, 0.46);
      g.lineBetween(-10, coreY, -7, coreY);
      g.lineBetween(10, coreY, 7, coreY);
    }

    g.fillStyle(primary, stunned ? 0.18 : 0.28);
    g.fillCircle(0, coreY, 8);
    g.lineStyle(1, accent, stunned ? 0.6 : 0.88);
    g.strokeCircle(0, coreY, 5);
    g.fillStyle(accent, stunned ? 0.74 : 0.98);
    g.fillCircle(0, coreY, profile.hostile ? 4.2 : 4.6);
    g.fillStyle(0xf4fdff, stunned ? 0.58 : 0.92);
    g.fillCircle(0, coreY, 2);
    g.fillStyle(0xffffff, stunned ? 0.5 : 0.88);
    g.fillCircle(0, coreY, 0.8);
    g.lineStyle(2, primary, profile.hostile ? 0.5 : 0.42);
    g.lineBetween(-19, coreY, -13, coreY);
    g.lineBetween(19, coreY, 13, coreY);
    g.lineStyle(1, ROBOT_CHASSIS_DARK, 0.76);
    g.lineBetween(-13, coreY + 4, -8, coreY + 7);
    g.lineBetween(13, coreY + 4, 8, coreY + 7);
  }

  private robotMachineProfile(robot: RobotId): RobotMachineProfile {
    if (robot === "player") {
      return {
        finReach: 29,
        frontReach: 27,
        frontShoulder: 15,
        innerScale: 0.72,
        hostile: false,
      };
    }

    return {
      finReach: 32,
      frontReach: 29,
      frontShoulder: 18,
      innerScale: 0.68,
      hostile: true,
    };
  }

  private robotFacingRotation(robot: RobotId, move: Move): number {
    switch (move) {
      case "up":
        return 0;
      case "down":
        return Math.PI;
      case "left":
        return -Math.PI / 2;
      case "right":
        return Math.PI / 2;
      case "wait":
        return robot === "player" ? Math.PI / 2 : -Math.PI / 2;
    }
  }

  private showPickupCollectionFlash(pickup: Pickup): void {
    const center = this.tileCenter(pickup.tile);
    const style = getPickupStyle(pickup.value);
    const g = this.trackBoard(this.add.graphics());

    g.setDepth(3.4);
    g.setBlendMode(Phaser.BlendModes.ADD);
    g.fillStyle(style.ring, 0.16);
    g.fillCircle(0, 0, pickup.value === 3 ? 32 : 24);
    g.lineStyle(4, style.ring, 0.96);
    g.strokeCircle(0, 0, pickup.value === 3 ? 22 : 18);
    g.fillStyle(style.core, 0.36);
    g.fillCircle(0, 0, pickup.value === 3 ? 12 : 9);
    g.setPosition(center.x, center.y);

    this.tweens.add({
      targets: g,
      alpha: 0,
      scale: 1.45,
      duration: EXECUTION_FEEDBACK_HOLD_MS,
      ease: "Cubic.easeOut",
    });
  }

  private showScorePop(robot: RobotId, delta: number, tile: TilePosition): void {
    const center = this.tileCenter(tile);
    const color = this.robotColor(robot);
    const text = this.applyTextGlow(
      this.trackBoard(
        this.add
          .text(center.x, center.y - 34, `+${delta}`, {
            color,
            fontFamily: TRON_THEME.fontFamily,
            fontSize: delta >= 3 ? "22px" : "18px",
            fontStyle: "900",
          })
          .setOrigin(0.5),
      ),
      color,
      delta >= 3 ? 14 : 10,
    );

    text.setDepth(4);
    this.tweens.add({
      targets: text,
      y: text.y - 18,
      alpha: 0,
      duration: EXECUTION_FEEDBACK_HOLD_MS,
      ease: "Cubic.easeOut",
    });
  }

  private showCollisionImpact(winner: RobotId, loser: RobotId): void {
    const winnerContainer = this.robotContainers[winner];
    const loserContainer = this.robotContainers[loser];
    const impactedRobots: RobotId[] = [winner, loser];

    for (const robot of impactedRobots) {
      const container = this.robotContainers[robot];

      if (!container) {
        continue;
      }

      this.showRobotCollisionFlash(container, robot);
      this.tweens.add({
        targets: container,
        scale: COLLISION_BUMP_SCALE,
        yoyo: true,
        duration: COLLISION_BUMP_MS / 2,
        ease: "Sine.easeInOut",
      });
    }

    this.cameras.main.shake(
      COLLISION_SHAKE_MS,
      COLLISION_SHAKE_INTENSITY,
      false,
    );

    if (winnerContainer) {
      this.showRobotPulse(
        winnerContainer.x,
        winnerContainer.y,
        this.robotThemeColor(winner),
        "PRIORITY",
      );
    }

    if (loserContainer) {
      this.showRobotPulse(
        loserContainer.x,
        loserContainer.y,
        PREVIEW_COLLISION_COLOR,
        "STUN",
      );
    }
  }

  private showRobotCollisionFlash(
    container: Phaser.GameObjects.Container,
    robot: RobotId,
  ): void {
    const profile = this.robotMachineProfile(robot);
    const g = this.add.graphics();

    g.setBlendMode(Phaser.BlendModes.ADD);
    g.fillStyle(0xffffff, 0.18);
    g.fillPoints(this.robotSideFinPoints("left", profile), true);
    g.fillPoints(this.robotSideFinPoints("right", profile), true);
    g.fillStyle(0xffffff, 0.24);
    g.fillPoints(this.robotHullPoints(1.02), true);
    g.lineStyle(5, 0xffffff, 0.82);
    g.strokePoints(this.robotHullPoints(1.06), true, true);
    g.lineStyle(2, 0xffffff, 0.96);
    g.strokePoints(this.robotInnerPanelPoints(profile.innerScale), true, true);
    container.add(g);

    this.tweens.add({
      targets: g,
      alpha: 0,
      duration: COLLISION_FLASH_MS,
      ease: "Cubic.easeOut",
      onComplete: () => g.destroy(),
    });
  }

  private showRobotPulse(
    x: number,
    y: number,
    color: number,
    label: string,
  ): void {
    const g = this.trackBoard(this.add.graphics());
    const text = this.applyTextGlow(
      this.trackBoard(
        this.add
          .text(x, y - 36, label, {
            color: this.cssColor(color),
            fontFamily: TRON_THEME.fontFamily,
            fontSize: "12px",
            fontStyle: "900",
          })
          .setOrigin(0.5),
      ),
      this.cssColor(color),
      10,
    );

    g.setDepth(3.6);
    g.lineStyle(5, color, 0.92);
    g.strokeCircle(0, 0, 27);
    g.setPosition(x, y);
    text.setDepth(4);

    this.tweens.add({
      targets: g,
      alpha: 0,
      scale: 1.35,
      duration: EXECUTION_FEEDBACK_HOLD_MS,
      ease: "Cubic.easeOut",
    });
    this.tweens.add({
      targets: text,
      alpha: 0,
      y: text.y - 10,
      duration: EXECUTION_FEEDBACK_HOLD_MS,
      ease: "Cubic.easeOut",
    });
  }

  private drawHud(): void {
    const compact = this.compact;

    if (compact) {
      this.drawCompactHud(compact);
      return;
    }

    this.drawTerminalFrames();
    this.drawGameTitle();
    this.drawMatchReadout();
    this.drawAudioSettings();
    this.drawRulesAccess();

    if (this.match.status === "match-complete") {
      this.drawMatchCompleteOverlay();
      return;
    }

    this.drawQueueReadout();
    this.drawControls();
    this.drawGuideSkip();
    this.drawGuideCoach();
    this.drawRoundSummaryOverlay();
  }

  private drawGuideSkip(): void {
    if (this.match.mode !== "guided" || this.rulesOverlayVisible) {
      return;
    }

    this.drawButton(
      LEFT_PANEL_X,
      BOARD_ORIGIN.y + 232,
      SIDE_PANEL_WIDTH,
      30,
      "SKIP TO STANDARD MATCH",
      this.match.status !== "executing",
      () => this.skipToStandardMatch(),
      0.2,
      "10px",
    );
  }

  private drawGuideCoach(): void {
    const coach = getGuideCoach({
      mode: this.match.mode,
      round: this.match.currentRound,
      status: this.match.status,
      queueLength: this.round.playerQueue.length,
      maxSteps: this.round.maxSteps,
      priorityOwner: this.round.priorityOwner,
      lastCollisionWinner: this.lastCollisionWinner,
    });

    if (!coach) {
      return;
    }

    const x = BOARD_ORIGIN.x;
    const y = BOARD_ORIGIN.y + BOARD_PIXEL_SIZE + 10;
    const g = this.track(this.add.graphics());

    g.setDepth(0.3);
    g.fillStyle(TRON_THEME.panelFill, 0.9);
    g.fillRoundedRect(x, y, BOARD_PIXEL_SIZE, 70, 6);
    g.lineStyle(2, TRON_THEME.rivalAccent, 0.8);
    g.strokeRoundedRect(x, y, BOARD_PIXEL_SIZE, 70, 6);

    this.drawDepthText(x + 14, y + 8, `GUIDE · ${coach.title}`, {
      color: TRON_THEME.textAmber,
      fontSize: "12px",
      fontStyle: "900",
      depth: 0.4,
    });
    this.drawDepthText(x + 14, y + 28, coach.text, {
      color: TRON_THEME.textPrimary,
      fontSize: "14px",
      fontStyle: "700",
      depth: 0.4,
      wordWrapWidth: BOARD_PIXEL_SIZE - 28,
      lineSpacing: 3,
    });
  }

  private drawRulesOverlay(): void {
    const compact = this.compact;

    if (compact) {
      this.drawCompactRulesOverlay(compact);
      return;
    }

    const panelWidth = 640;
    const panelHeight = 560;
    const panelX = (GAME_WIDTH - panelWidth) / 2;
    const panelY = 80;
    const panelCenterX = GAME_WIDTH / 2;
    const topCardY = panelY + 178;
    const topCardWidth = 254;
    const topCardHeight = 176;
    const bottomCardY = topCardY + topCardHeight + 14;
    const bottomCardHeight = 120;
    const depth = 20;
    const isWelcome = this.rulesOverlayMode === "welcome";
    const priorityOwner = this.robotName(this.round.priorityOwner).toUpperCase();
    const priorityClashLine =
      `This round: ${priorityOwner} wins clashes and takes the tile/node.`;
    const priorityColor = this.robotColor(this.round.priorityOwner);
    const statusLabel = isWelcome ? "WELCOME TO THE GRID" : "TACTICAL REFERENCE";
    const statusHint = isWelcome
      ? "Press any key for a quick guided duel. Press H later to reopen this."
      : "Press H or ESC any time to close this guide.";
    const closeLabel = isWelcome ? "START GUIDED DUEL" : "CLOSE RULES";
    const fadeTargets: Array<Phaser.GameObjects.Graphics | Phaser.GameObjects.Text> =
      [];
    const shade = this.track(this.add.graphics());
    const glow = this.track(this.add.graphics());
    const panel = this.track(this.add.graphics());
    const scanlines = this.track(this.add.graphics());

    fadeTargets.push(shade, glow, panel, scanlines);

    shade.setDepth(depth);
    shade.fillStyle(0x01040a, 0.84);
    shade.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    glow.setDepth(depth + 0.1);
    glow.setBlendMode(Phaser.BlendModes.ADD);
    glow.lineStyle(18, TRON_THEME.player, 0.08);
    glow.strokeRoundedRect(
      panelX - 8,
      panelY - 8,
      panelWidth + 16,
      panelHeight + 16,
      12,
    );
    glow.lineStyle(8, TRON_THEME.player, 0.16);
    glow.strokeRoundedRect(
      panelX - 4,
      panelY - 4,
      panelWidth + 8,
      panelHeight + 8,
      10,
    );

    panel.setDepth(depth + 0.2);
    panel.fillStyle(0x03111d, 0.97);
    panel.fillRoundedRect(panelX, panelY, panelWidth, panelHeight, 8);
    panel.lineStyle(4, TRON_THEME.player, 0.86);
    panel.strokeRoundedRect(panelX, panelY, panelWidth, panelHeight, 8);
    panel.lineStyle(1, TRON_THEME.grid, 0.42);
    panel.strokeRoundedRect(
      panelX + 14,
      panelY + 14,
      panelWidth - 28,
      panelHeight - 28,
      5,
    );
    this.drawOverlayCornerBrackets(
      panel,
      panelX,
      panelY,
      panelWidth,
      panelHeight,
    );

    scanlines.setDepth(depth + 0.3);
    scanlines.lineStyle(1, TRON_THEME.grid, 0.05);
    for (let y = panelY + 24; y < panelY + panelHeight - 20; y += 10) {
      scanlines.lineBetween(panelX + 18, y, panelX + panelWidth - 18, y);
    }
    scanlines.lineStyle(1, TRON_THEME.rivalAccent, 0.16);
    scanlines.lineBetween(
      panelX + 24,
      panelY + 108,
      panelX + panelWidth - 24,
      panelY + 108,
    );

    const title = this.drawOverlayText(
      panelCenterX,
      panelY + 36,
      GAME_TITLE.toUpperCase(),
      {
        color: TRON_THEME.textPrimary,
        fontSize: "44px",
        fontStyle: "900",
        depth: depth + 1,
        glow: this.cssColor(TRON_THEME.player),
        glowBlur: 18,
      },
    );
    const subtitle = this.drawOverlayText(
      panelCenterX,
      panelY + 92,
      statusLabel,
      {
        color: TRON_THEME.textAmber,
        fontSize: "14px",
        fontStyle: "900",
        depth: depth + 1,
        glow: TRON_THEME.textAmber,
        glowBlur: 10,
      },
    );
    const priority = this.drawOverlayText(
      panelCenterX,
      panelY + 126,
      `ROUND ${this.match.currentRound} PRIORITY: ${priorityOwner}`,
      {
        color: priorityColor,
        fontSize: "15px",
        fontStyle: "800",
        depth: depth + 1,
        glow: priorityColor,
        glowBlur: 12,
      },
    );
    const hint = this.drawOverlayText(
      panelCenterX,
      panelY + 154,
      statusHint,
      {
        color: TRON_THEME.textMuted,
        fontSize: "14px",
        fontStyle: "700",
        depth: depth + 1,
        glow: TRON_THEME.textMuted,
        glowBlur: 8,
      },
    );
    fadeTargets.push(title, subtitle, priority, hint);
    fadeTargets.push(
      ...this.drawRulesCard(
        panelX + 36,
        topCardY,
        topCardWidth,
        topCardHeight,
        "ROUND FLOW",
        [
          "You are cyan; enemy is orange.",
          this.rulesOverlayMode === "welcome"
            ? "Queue 4 moves in round 1, then 8."
            : `Queue ${this.round.maxSteps} moves.`,
          "Both robots reveal together.",
          "Small nodes are worth 1.",
          "Large nodes are worth 3.",
          `Highest score after ${this.match.totalRounds} rounds wins.`,
        ],
        depth + 1,
        TRON_THEME.player,
      ),
      ...this.drawRulesCard(
        panelX + panelWidth - 36 - topCardWidth,
        topCardY,
        topCardWidth,
        topCardHeight,
        "CONTROLS",
        [
          "Arrow keys or WASD move.",
          "Space queues WAIT.",
          "Backspace undoes a move.",
          "C or Delete clears the queue.",
          "Enter executes. H opens this guide.",
        ],
        depth + 1,
        TRON_THEME.grid,
      ),
      ...this.drawRulesCard(
        panelX + 36,
        bottomCardY,
        panelWidth - 72,
        bottomCardHeight,
        "COLLISIONS",
        [
          "Same tile or crossing paths causes a clash.",
          "Collision priority swaps each round.",
          priorityClashLine,
          "Loser is stunned: only their next move becomes WAIT.",
        ],
        depth + 1,
        TRON_THEME.rivalAccent,
      ),
    );

    for (const target of fadeTargets) {
      target.setAlpha(0);
    }

    this.tweens.add({
      targets: fadeTargets,
      alpha: 1,
      duration: ONBOARDING_FADE_MS,
      ease: "Cubic.easeOut",
    });
    this.tweens.add({
      targets: glow,
      alpha: 0.62,
      duration: 1100,
      delay: ONBOARDING_FADE_MS,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
    this.tweens.add({
      targets: [title, subtitle, priority],
      alpha: 0.82,
      duration: 1350,
      delay: ONBOARDING_FADE_MS,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
    this.tweens.add({
      targets: scanlines,
      alpha: 0.48,
      duration: 260,
      delay: ONBOARDING_FADE_MS,
      yoyo: true,
      repeat: -1,
      ease: "Stepped",
    });

    const footerDivider = this.track(this.add.graphics());
    footerDivider.setDepth(depth + 1.1);
    footerDivider.lineStyle(1, TRON_THEME.grid, 0.18);
    footerDivider.lineBetween(
      panelX + 36,
      panelY + panelHeight - 68,
      panelX + panelWidth - 36,
      panelY + panelHeight - 68,
    );

    if (isWelcome) {
      this.drawButton(
        panelX + 36,
        panelY + panelHeight - 44,
        268,
        38,
        closeLabel,
        true,
        () => this.beginFromWelcome("guided"),
        depth + 1.4,
      );
      this.drawButton(
        panelX + panelWidth - 36 - 268,
        panelY + panelHeight - 44,
        268,
        38,
        "SKIP TO STANDARD MATCH",
        true,
        () => this.beginFromWelcome("standard"),
        depth + 1.4,
      );
      return;
    }

    this.drawButton(
      panelCenterX - 98,
      panelY + panelHeight - 44,
      196,
      38,
      closeLabel,
      true,
      () => this.hideRulesOverlay(),
      depth + 1.4,
    );
  }

  private drawRulesCard(
    x: number,
    y: number,
    width: number,
    height: number,
    title: string,
    lines: string[],
    depth: number,
    accent: number,
  ): Array<Phaser.GameObjects.Graphics | Phaser.GameObjects.Text> {
    const card = this.track(this.add.graphics());
    card.setDepth(depth - 0.1);
    card.fillStyle(0x041523, 0.96);
    card.fillRoundedRect(x, y, width, height, 8);
    card.lineStyle(4, accent, 0.08);
    card.strokeRoundedRect(x - 1, y - 1, width + 2, height + 2, 9);
    card.lineStyle(1, accent, 0.56);
    card.strokeRoundedRect(x, y, width, height, 8);
    card.lineStyle(1, TRON_THEME.grid, 0.16);
    card.strokeRoundedRect(x + 10, y + 10, width - 20, height - 20, 5);
    card.lineStyle(1, accent, 0.28);
    card.lineBetween(x + 16, y + 34, x + width - 16, y + 34);
    card.lineStyle(1, TRON_THEME.grid, 0.14);
    card.lineBetween(x + 16, y + 37, x + width * 0.62, y + 37);

    const titleText = this.drawOverlayText(x + 16, y + 12, title, {
      color: this.cssColor(accent),
      fontSize: "12px",
      fontStyle: "900",
      depth,
      glow: this.cssColor(accent),
      glowBlur: 10,
      originX: 0,
    });
    const bodyText = this.drawOverlayText(
      x + 16,
      y + 46,
      lines.map((line) => `- ${line}`).join("\n"),
      {
        color: TRON_THEME.textPrimary,
        fontSize: "12px",
        fontStyle: "700",
        depth,
        lineSpacing: 2,
        originX: 0,
        wordWrapWidth: width - 32,
      },
    );

    return [card, titleText, bodyText];
  }

  private drawRulesAccess(): void {
    const x = LEFT_PANEL_X + 4;
    const y = BOARD_ORIGIN.y + 492;
    const width = SIDE_PANEL_WIDTH - 24;
    const height = 82;
    const depth = 0.2;
    const canOpenRules = this.match.status !== "executing";
    const g = this.track(this.add.graphics());

    g.setDepth(depth);
    g.fillStyle(TRON_THEME.panelFill, 0.38);
    g.fillRoundedRect(x - 5, y - 8, width + 10, height, 7);
    g.lineStyle(5, TRON_THEME.grid, 0.05);
    g.strokeRoundedRect(x - 6, y - 9, width + 12, height + 2, 8);
    g.lineStyle(1, TRON_THEME.grid, 0.4);
    g.strokeRoundedRect(x - 5, y - 8, width + 10, height, 7);
    g.lineStyle(1, TRON_THEME.player, 0.18);
    g.lineBetween(x + 6, y + 25, x + width - 6, y + 25);

    this.drawDepthText(x + 2, y + 2, "RULES", {
      color: TRON_THEME.textMuted,
      fontSize: "13px",
      fontStyle: "900",
      depth: depth + 0.1,
    });
    this.drawDepthText(
      x + 2,
      y + 28,
      canOpenRules
        ? "Press H for guide."
        : "Guide reopens after execution.",
      {
        color: canOpenRules ? TRON_THEME.textPrimary : TRON_THEME.textGhost,
        fontSize: "9px",
        fontStyle: "700",
        depth: depth + 0.1,
        lineSpacing: 4,
      },
    );
    this.drawButton(
      x + 8,
      y + 48,
      width - 16,
      22,
      "VIEW RULES",
      canOpenRules,
      () => this.showRulesOverlay("rules"),
      depth + 0.1,
    );
  }

  private drawOverlayCornerBrackets(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    const corner = 34;

    g.lineStyle(3, TRON_THEME.rivalAccent, 0.5);
    g.lineBetween(x, y, x + corner, y);
    g.lineBetween(x, y, x, y + corner);
    g.lineBetween(x + width, y, x + width - corner, y);
    g.lineBetween(x + width, y, x + width, y + corner);
    g.lineBetween(x, y + height, x + corner, y + height);
    g.lineBetween(x, y + height, x, y + height - corner);
    g.lineBetween(x + width, y + height, x + width - corner, y + height);
    g.lineBetween(x + width, y + height, x + width, y + height - corner);
  }

  private drawOverlayText(
    x: number,
    y: number,
    text: string | string[],
    options: {
      color: string;
      fontSize: string;
      fontStyle: string;
      depth: number;
      glow?: string;
      glowBlur?: number;
      lineSpacing?: number;
      originX?: number;
      wordWrapWidth?: number;
    },
  ): Phaser.GameObjects.Text {
    const textObject = this.track(
      this.add
        .text(x, y, text, {
          align: (options.originX ?? 0.5) === 0 ? "left" : "center",
          color: options.color,
          fontFamily: TRON_THEME.fontFamily,
          fontSize: options.fontSize,
          fontStyle: options.fontStyle,
          lineSpacing: options.lineSpacing,
          wordWrap: options.wordWrapWidth
            ? {
                width: options.wordWrapWidth,
                useAdvancedWrap: true,
              }
            : undefined,
        })
        .setOrigin(options.originX ?? 0.5, 0),
    );

    textObject.setDepth(options.depth);
    this.applyTextGlow(
      textObject,
      options.glow ?? options.color,
      options.glowBlur ?? 8,
    );
    return textObject;
  }

  private drawTerminalFrames(): void {
    const y = BOARD_ORIGIN.y - 72;
    const height = BOARD_PIXEL_SIZE + 132;

    this.drawTerminalFrame(
      LEFT_PANEL_X - 12,
      y,
      SIDE_PANEL_WIDTH + 24,
      height,
      TRON_THEME.player,
    );
    this.drawTerminalFrame(
      RIGHT_PANEL_X - 12,
      y,
      SIDE_PANEL_WIDTH + 24,
      height,
      TRON_THEME.rivalAccent,
    );
  }

  private drawTerminalFrame(
    x: number,
    y: number,
    width: number,
    height: number,
    accent: number,
  ): void {
    const g = this.track(this.add.graphics());
    const corner = 18;

    g.setDepth(0);
    g.fillStyle(TRON_THEME.panelFill, 0.66);
    g.fillRoundedRect(x, y, width, height, 7);
    g.lineStyle(6, accent, 0.08);
    g.strokeRoundedRect(x - 2, y - 2, width + 4, height + 4, 9);
    g.lineStyle(1, accent, 0.5);
    g.strokeRoundedRect(x, y, width, height, 7);
    g.lineStyle(1, TRON_THEME.gridDim, 0.18);

    for (let scanY = y + 18; scanY < y + height - 12; scanY += 18) {
      g.lineBetween(x + 8, scanY, x + width - 8, scanY);
    }

    g.lineStyle(3, accent, 0.7);
    g.lineBetween(x, y, x + corner, y);
    g.lineBetween(x, y, x, y + corner);
    g.lineBetween(x + width, y, x + width - corner, y);
    g.lineBetween(x + width, y, x + width, y + corner);
    g.lineBetween(x, y + height, x + corner, y + height);
    g.lineBetween(x, y + height, x, y + height - corner);
    g.lineBetween(x + width, y + height, x + width - corner, y + height);
    g.lineBetween(x + width, y + height, x + width, y + height - corner);
  }

  private drawGameTitle(): void {
    const x = BOARD_ORIGIN.x + BOARD_PIXEL_SIZE / 2;
    const y = BOARD_ORIGIN.y - 50;

    this.applyTextGlow(
      this.track(
        this.add
          .text(x, y, GAME_TITLE.toUpperCase(), {
            color: TRON_THEME.textPrimary,
            fontFamily: TRON_THEME.fontFamily,
            fontSize: "28px",
            fontStyle: "800",
          })
          .setOrigin(0.5),
      ),
      this.cssColor(TRON_THEME.player),
      14,
    );
  }

  private drawExecutionStepBadge(): void {
    if (this.compact || this.match.status !== "executing") {
      return;
    }

    const x = BOARD_ORIGIN.x + BOARD_PIXEL_SIZE / 2;
    const y = BOARD_ORIGIN.y - 28;

    this.applyTextGlow(
      this.track(
        this.add
          .text(x, y, `STEP ${this.round.currentExecutionStep} / ${this.round.maxSteps}`, {
            color: TRON_THEME.textPrimary,
            fontFamily: TRON_THEME.fontFamily,
            fontSize: "18px",
            fontStyle: "900",
          })
          .setOrigin(0.5),
      ),
      this.cssColor(TRON_THEME.player),
      10,
    );
  }

  private drawMatchReadout(): void {
    const readoutX = LEFT_PANEL_X;
    const readoutY = BOARD_ORIGIN.y;
    const readoutGap = 29;
    const playerDelta = this.activeStepVisual?.step?.playerScoreDelta ?? 0;
    const rivalDelta = this.activeStepVisual?.step?.rivalScoreDelta ?? 0;

    if (this.match.status === "match-complete") {
      this.drawReadoutLine(
        readoutX,
        readoutY,
        `ROUND ${this.match.currentRound} / ${this.match.totalRounds}`,
      );
      this.drawReadoutLine(
        readoutX,
        readoutY + readoutGap + 8,
        `YOU: ${this.match.playerScore}`,
        this.robotColor("player"),
        "18px",
        "800",
      );
      this.drawReadoutLine(
        readoutX,
        readoutY + readoutGap * 2 + 8,
        `ENEMY: ${this.match.rivalScore}`,
        this.robotColor("rival"),
        "18px",
        "800",
      );
      return;
    }

    this.drawReadoutLine(
      readoutX,
      readoutY,
      `ROUND ${this.match.currentRound} / ${this.match.totalRounds}`,
    );
    this.drawReadoutLine(
      readoutX,
      readoutY + readoutGap,
      "COLLISION PRIORITY",
      TRON_THEME.textMuted,
      "13px",
      "700",
    );
    this.drawReadoutLine(
      readoutX,
      readoutY + readoutGap * 2,
      this.robotName(this.round.priorityOwner).toUpperCase(),
      this.robotColor(this.round.priorityOwner),
      "21px",
      "800",
    );
    this.drawReadoutSeparator(readoutX, readoutY + readoutGap * 3 + 5);
    this.drawReadoutLine(
      readoutX,
      readoutY + readoutGap * 3 + 20,
      `YOU: ${this.match.playerScore}${playerDelta > 0 ? ` +${playerDelta}` : ""}`,
      this.robotColor("player"),
      "17px",
      playerDelta > 0 ? "800" : "500",
    );
    this.drawReadoutLine(
      readoutX,
      readoutY + readoutGap * 4 + 20,
      `ENEMY: ${this.match.rivalScore}${rivalDelta > 0 ? ` +${rivalDelta}` : ""}`,
      this.robotColor("rival"),
      "17px",
      rivalDelta > 0 ? "800" : "500",
    );

    this.drawRivalMoodDebug(readoutX, readoutY + readoutGap * 5 + 28);
  }

  private drawReadoutSeparator(x: number, y: number): void {
    const g = this.track(this.add.graphics());

    g.setDepth(0.1);
    g.lineStyle(1, TRON_THEME.grid, 0.34);
    g.lineBetween(x, y, x + SIDE_PANEL_WIDTH, y);
    g.lineStyle(1, TRON_THEME.rivalAccent, 0.16);
    g.lineBetween(x, y + 2, x + SIDE_PANEL_WIDTH * 0.58, y + 2);
  }

  private drawRivalMoodDebug(x: number, y: number): void {
    if (!SHOW_RIVAL_MOOD_DEBUG) {
      return;
    }

    const mood = this.getRivalMood();

    if (!mood) {
      return;
    }

    this.drawReadoutLine(
      x,
      y,
      `DEBUG MOOD ${mood.toUpperCase()}`,
      this.cssColor(TRON_THEME.rival),
      "13px",
      "800",
    );
  }

  private getRivalMood(): RivalMood | null {
    return this.round.rivalMood;
  }

  private drawReadoutLine(
    x: number,
    y: number,
    text: string,
    color: string = TRON_THEME.textMuted,
    fontSize = "17px",
    fontStyle = "500",
  ): void {
    this.applyTextGlow(
      this.track(
        this.add.text(x, y, text, {
          color,
          fontFamily: TRON_THEME.fontFamily,
          fontSize,
          fontStyle,
        }),
      ),
      color,
      color === TRON_THEME.textMuted ? 5 : 9,
    );
  }

  private drawMatchCompleteOverlay(): void {
    const panelWidth = 430;
    const panelHeight = 342;
    const compact = this.compact;
    const overlayScale = compact
      ? Math.min(1, (compact.width - 24) / panelWidth, (compact.height - 16) / panelHeight)
      : 1;
    const panelX = compact
      ? 0
      : BOARD_ORIGIN.x + (BOARD_PIXEL_SIZE - panelWidth) / 2;
    const panelY = compact
      ? 0
      : BOARD_ORIGIN.y + (BOARD_PIXEL_SIZE - panelHeight) / 2;
    const panelCenterX = panelX + panelWidth / 2;
    const depth = 8;
    const overlay = createMatchCompleteOverlayModel(this.match);
    const resultStyle = this.finalResultStyle(overlay.resultLabel);
    const shade = this.track(this.add.graphics());

    shade.setDepth(depth);
    shade.fillStyle(0x020712, 0.76);

    if (compact) {
      shade.fillRect(0, 0, compact.width, compact.height);
      this.track(
        this.add.zone(0, 0, compact.width, compact.height).setOrigin(0),
      )
        .setDepth(depth + 0.05)
        .setInteractive();

      const layer = this.track(
        this.add.container(
          (compact.width - panelWidth * overlayScale) / 2,
          (compact.height - panelHeight * overlayScale) / 2,
        ),
      );

      layer.setScale(overlayScale);
      layer.setDepth(depth + 0.1);
      this.activeLayer = layer;
    } else {
      shade.fillRect(
        BOARD_ORIGIN.x - 8,
        BOARD_ORIGIN.y - 8,
        BOARD_PIXEL_SIZE + 16,
        BOARD_PIXEL_SIZE + 16,
      );
    }

    const panel = this.track(this.add.graphics());

    panel.setDepth(depth + 0.1);
    panel.lineStyle(10, resultStyle.accent, 0.1);
    panel.strokeRoundedRect(
      panelX - 4,
      panelY - 4,
      panelWidth + 8,
      panelHeight + 8,
      10,
    );
    panel.fillStyle(TRON_THEME.panelFill, 0.97);
    panel.fillRoundedRect(panelX, panelY, panelWidth, panelHeight, 8);
    panel.lineStyle(4, resultStyle.accent, 0.84);
    panel.strokeRoundedRect(panelX, panelY, panelWidth, panelHeight, 8);
    panel.lineStyle(1, TRON_THEME.grid, 0.42);
    panel.strokeRoundedRect(
      panelX + 12,
      panelY + 12,
      panelWidth - 24,
      panelHeight - 24,
      5,
    );

    this.drawDepthText(panelCenterX, panelY + 44, overlay.resultLabel, {
      color: resultStyle.color,
      fontSize: "44px",
      fontStyle: "900",
      originX: 0.5,
      depth: depth + 1,
    });
    this.drawDepthText(panelCenterX, panelY + 88, overlay.resultSubtitle, {
      color: TRON_THEME.textMuted,
      fontSize: "14px",
      fontStyle: "800",
      originX: 0.5,
      depth: depth + 1,
    });

    const scoreY = panelY + 132;
    overlay.scoreRows.forEach((row, index) => {
      this.drawFinalScoreRow(
        panelX + 52,
        scoreY + index * 44,
        row.label,
        row.value,
        this.scoreRowColor(row.tone),
        depth + 1,
      );
    });

    if (overlay.statLines.length > 0) {
      this.drawFinalStats(panelX + 52, panelY + 246, overlay.statLines, depth + 1);
    }
    this.drawButton(
      panelCenterX - 110,
      panelY + panelHeight - 54,
      220,
      40,
      this.match.mode === "guided" ? "START STANDARD MATCH" : "NEW MATCH",
      true,
      () => this.replayMatch(),
      depth + 1,
    );
    this.activeLayer = undefined;
  }

  private drawRoundSummaryOverlay(): void {
    const summary = this.roundSummary;

    if (
      !summary ||
      this.match.status !== "round-complete" ||
      this.rulesOverlayVisible
    ) {
      return;
    }

    const panelWidth = 430;
    const panelHeight = summary.stunNote ? 318 : 280;
    const compact = this.compact;
    const overlayScale = compact
      ? Math.min(1, (compact.width - 24) / panelWidth, (compact.height - 16) / panelHeight)
      : 1;
    const panelX = compact
      ? 0
      : BOARD_ORIGIN.x + (BOARD_PIXEL_SIZE - panelWidth) / 2;
    const panelY = compact
      ? 0
      : BOARD_ORIGIN.y + (BOARD_PIXEL_SIZE - panelHeight) / 2;
    const centerX = panelX + panelWidth / 2;
    const depth = 8;
    const accent = TRON_THEME.grid;
    const shade = this.track(this.add.graphics());

    shade.setDepth(depth);
    shade.fillStyle(0x020712, 0.7);

    if (compact) {
      shade.fillRect(0, 0, compact.width, compact.height);
      this.track(this.add.zone(0, 0, compact.width, compact.height).setOrigin(0))
        .setDepth(depth + 0.05)
        .setInteractive();

      const layer = this.track(
        this.add.container(
          (compact.width - panelWidth * overlayScale) / 2,
          (compact.height - panelHeight * overlayScale) / 2,
        ),
      );

      layer.setScale(overlayScale);
      layer.setDepth(depth + 0.1);
      this.activeLayer = layer;
    } else {
      shade.fillRect(
        BOARD_ORIGIN.x - 8,
        BOARD_ORIGIN.y - 8,
        BOARD_PIXEL_SIZE + 16,
        BOARD_PIXEL_SIZE + 16,
      );
    }

    const panel = this.track(this.add.graphics());

    panel.setDepth(depth + 0.1);
    panel.fillStyle(TRON_THEME.panelFill, 0.97);
    panel.fillRoundedRect(panelX, panelY, panelWidth, panelHeight, 8);
    panel.lineStyle(3, accent, 0.84);
    panel.strokeRoundedRect(panelX, panelY, panelWidth, panelHeight, 8);

    this.drawDepthText(centerX, panelY + 34, summary.title, {
      color: TRON_THEME.textPrimary,
      fontSize: "24px",
      fontStyle: "900",
      originX: 0.5,
      depth: depth + 1,
    });
    this.drawFinalScoreRow(
      panelX + 52,
      panelY + 72,
      "YOU GAINED",
      `+${summary.playerPoints}`,
      this.robotColor("player"),
      depth + 1,
    );
    this.drawFinalScoreRow(
      panelX + 52,
      panelY + 108,
      "ENEMY GAINED",
      `+${summary.rivalPoints}`,
      this.robotColor("rival"),
      depth + 1,
    );
    this.drawDepthText(centerX, panelY + 152, summary.moment.text, {
      color:
        summary.moment.tone === "neutral"
          ? TRON_THEME.textMuted
          : this.robotColor(summary.moment.tone),
      fontSize: "15px",
      fontStyle: "800",
      originX: 0.5,
      depth: depth + 1,
      wordWrapWidth: panelWidth - 64,
    });

    if (summary.stunNote) {
      this.drawDepthText(centerX, panelY + 190, summary.stunNote, {
        color: TRON_THEME.textMuted,
        fontSize: "13px",
        fontStyle: "700",
        originX: 0.5,
        depth: depth + 1,
        wordWrapWidth: panelWidth - 64,
      });
    }

    this.drawButton(
      centerX - 130,
      panelY + panelHeight - 78,
      260,
      46,
      summary.continueLabel,
      true,
      () => this.continueFromSummary(),
      depth + 1,
      "15px",
      true,
    );
    this.drawDepthText(centerX, panelY + panelHeight - 24, "Enter / Space / tap", {
      color: TRON_THEME.textGhost,
      fontSize: "11px",
      fontStyle: "700",
      originX: 0.5,
      depth: depth + 1,
    });
    this.activeLayer = undefined;
  }

  private finalResultStyle(label: FinalResultLabel): {
    color: string;
    accent: number;
  } {
    if (label === "Draw") {
      return {
        color: TRON_THEME.textPrimary,
        accent: TRON_THEME.grid,
      };
    }

    if (label === "Victory") {
      return {
        color: this.robotColor("player"),
        accent: TRON_THEME.player,
      };
    }

    return {
      color: this.robotColor("rival"),
      accent: TRON_THEME.rivalAccent,
    };
  }

  private drawFinalScoreRow(
    x: number,
    y: number,
    label: string,
    value: string,
    valueColor: string,
    depth: number,
  ): void {
    this.drawDepthText(x, y, label, {
      color: TRON_THEME.textMuted,
      fontSize: "14px",
      fontStyle: "700",
      depth,
    });
    this.drawDepthText(x + 298, y - 4, value, {
      color: valueColor,
      fontSize: "24px",
      fontStyle: "900",
      originX: 1,
      depth,
    });
  }

  private drawFinalStats(
    x: number,
    y: number,
    lines: string[],
    depth: number,
  ): void {
    this.drawDepthText(x, y, lines, {
      color: TRON_THEME.textPrimary,
      fontSize: "15px",
      fontStyle: "700",
      lineSpacing: 9,
      depth,
    });
  }

  private scoreRowColor(tone: ScoreRowTone): string {
    if (tone === "neutral") {
      return TRON_THEME.textPrimary;
    }

    return this.robotColor(tone);
  }

  private drawDepthText(
    x: number,
    y: number,
    text: string | string[],
    options: {
      color: string;
      fontSize: string;
      fontStyle: string;
      depth: number;
      originX?: number;
      lineSpacing?: number;
      wordWrapWidth?: number;
    },
  ): Phaser.GameObjects.Text {
    const textObject = this.track(
      this.add.text(x, y, text, {
        color: options.color,
        fontFamily: TRON_THEME.fontFamily,
        fontSize: options.fontSize,
        fontStyle: options.fontStyle,
        lineSpacing: options.lineSpacing,
        wordWrap: options.wordWrapWidth
          ? { width: options.wordWrapWidth }
          : undefined,
      }),
    );

    textObject.setDepth(options.depth);
    textObject.setOrigin(options.originX ?? 0, 0);
    this.applyTextGlow(textObject, options.color, 9);
    return textObject;
  }

  private drawQueueReadout(): void {
    const x = RIGHT_PANEL_X;
    const y = BOARD_ORIGIN.y;

    this.applyTextGlow(
      this.track(
        this.add.text(
          x,
          y,
          `YOUR QUEUE ${this.round.playerQueue.length}/${this.round.maxSteps}`,
          {
            color: TRON_THEME.textPrimary,
            fontFamily: TRON_THEME.fontFamily,
            fontSize: "14px",
            fontStyle: "800",
          },
        ),
      ),
      this.cssColor(TRON_THEME.player),
      8,
    );

    for (let index = 0; index < this.round.maxSteps; index += 1) {
      this.drawQueueRow(
        x,
        y + 34 + index * QUEUE_ROW_GAP,
        index + 1,
        this.round.playerQueue[index],
      );
    }
  }

  private drawQueueRow(
    x: number,
    y: number,
    step: number,
    move: Move | undefined,
  ): void {
    const queued = move !== undefined;
    const markerColor = queued ? TRON_THEME.player : TRON_THEME.gridDim;
    const textColor = queued ? TRON_THEME.textPrimary : TRON_THEME.textGhost;
    const g = this.track(this.add.graphics());

    g.fillStyle(TRON_THEME.panelFill, queued ? 0.48 : 0.22);
    g.fillRoundedRect(x - 4, y - 4, SIDE_PANEL_WIDTH - 28, 24, 4);
    g.lineStyle(1, markerColor, queued ? 0.3 : 0.14);
    g.strokeRoundedRect(x - 4, y - 4, SIDE_PANEL_WIDTH - 28, 24, 4);
    g.fillStyle(TRON_THEME.boardFill, queued ? 0.92 : 0.62);
    g.fillCircle(x + 8, y + 8, 8);
    g.lineStyle(5, markerColor, queued ? 0.16 : 0.06);
    g.strokeCircle(x + 8, y + 8, 10);
    g.lineStyle(2, markerColor, queued ? 0.86 : 0.38);
    g.strokeCircle(x + 8, y + 8, 8);

    this.applyTextGlow(
      this.track(
        this.add
          .text(x + 8, y + 8, String(step), {
            color: queued ? this.cssColor(TRON_THEME.player) : TRON_THEME.textGhost,
            fontFamily: TRON_THEME.fontFamily,
            fontSize: "9px",
            fontStyle: "900",
          })
          .setOrigin(0.5),
      ),
      queued ? this.cssColor(TRON_THEME.player) : TRON_THEME.textGhost,
      queued ? 6 : 3,
    );

    this.applyTextGlow(
      this.track(
        this.add.text(x + 28, y, this.moveLabel(move), {
          color: textColor,
          fontFamily: TRON_THEME.fontFamily,
          fontSize: "15px",
          fontStyle: queued ? "800" : "500",
        }),
      ),
      textColor,
      queued ? 7 : 3,
    );
  }

  private drawControls(): void {
    const canEdit = !this.rulesOverlayVisible && this.match.status === "queuing";
    const canExecute = canEdit && isPlayerQueueReady(this.round);
    const x = RIGHT_PANEL_X;
    const y = BOARD_ORIGIN.y + 264;
    const w = 54;
    const h = 34;
    const gap = 7;

    this.drawButton(x + w + gap, y, w, h, "UP", canEdit, () => this.addMove("up"));
    this.drawButton(x, y + h + gap, w, h, "LEFT", canEdit, () => this.addMove("left"));
    this.drawButton(
      x + w + gap,
      y + h + gap,
      w,
      h,
      "WAIT",
      canEdit,
      () => this.addMove("wait"),
    );
    this.drawButton(
      x + (w + gap) * 2,
      y + h + gap,
      w,
      h,
      "RIGHT",
      canEdit,
      () => this.addMove("right"),
    );
    this.drawButton(
      x + w + gap,
      y + (h + gap) * 2,
      w,
      h,
      "DOWN",
      canEdit,
      () => this.addMove("down"),
    );

    this.drawButton(
      x,
      y + (h + gap) * 3 + 18,
      84,
      h,
      "UNDO",
      canEdit,
      () => this.undoMove(),
    );
    this.drawButton(
      x + 92,
      y + (h + gap) * 3 + 18,
      84,
      h,
      "CLEAR",
      canEdit,
      () => this.clearQueue(),
    );
    this.drawButton(
      x,
      y + (h + gap) * 4 + 22,
      SIDE_PANEL_WIDTH,
      h,
      "EXECUTE",
      canExecute,
      () => this.startExecution(),
    );

    if (this.match.status === "match-complete") {
      this.drawButton(
        x,
        y + (h + gap) * 5 + 26,
        SIDE_PANEL_WIDTH,
        h,
        "NEW MATCH",
        true,
        () => this.replayMatch(),
      );
    }
  }

  private drawAudioSettings(): void {
    const settings = this.audio.getSettings();
    const x = LEFT_PANEL_X;
    const y = BOARD_ORIGIN.y + 288;
    const width = SIDE_PANEL_WIDTH;
    const height = 164;
    const depth = 0.2;
    const g = this.track(this.add.graphics());

    g.setDepth(depth);
    g.fillStyle(TRON_THEME.panelFill, 0.48);
    g.fillRoundedRect(x - 5, y - 8, width + 10, height, 7);
    g.lineStyle(5, TRON_THEME.grid, 0.06);
    g.strokeRoundedRect(x - 6, y - 9, width + 12, height + 2, 8);
    g.lineStyle(1, TRON_THEME.grid, 0.44);
    g.strokeRoundedRect(x - 5, y - 8, width + 10, height, 7);
    g.lineStyle(1, TRON_THEME.rivalAccent, 0.2);
    g.lineBetween(x + 6, y + 25, x + width - 6, y + 25);

    this.drawDepthText(x + 2, y + 2, "AUDIO", {
      color: TRON_THEME.textMuted,
      fontSize: "13px",
      fontStyle: "900",
      depth: depth + 0.1,
    });
    this.drawButton(
      x + width - 68,
      y - 1,
      68,
      26,
      settings.muted ? "MUTED" : "MUTE",
      true,
      () => this.toggleMute(),
      depth + 0.1,
    );
    this.drawVolumeSlider(
      x + 2,
      y + 42,
      width - 4,
      "MUSIC VOLUME",
      settings.musicVolume,
      "music",
      TRON_THEME.grid,
      depth + 0.1,
    );
    this.drawVolumeSlider(
      x + 2,
      y + 98,
      width - 4,
      "SFX VOLUME",
      settings.sfxVolume,
      "sfx",
      TRON_THEME.rivalAccent,
      depth + 0.1,
    );
  }

  private drawVolumeSlider(
    x: number,
    y: number,
    width: number,
    label: string,
    value: number,
    kind: VolumeSliderKind,
    color: number,
    depth: number,
    hitHeight = 28,
  ): void {
    const percent = Math.round(value * 100);
    const trackX = x + 2;
    const trackY = y + 30;
    const trackWidth = width - 4;
    const fillWidth = Math.max(0, trackWidth * value);
    const knobX = trackX + fillWidth;
    const g = this.track(this.add.graphics());

    g.setDepth(depth);
    g.fillStyle(TRON_THEME.boardFill, 0.86);
    g.fillRoundedRect(trackX, trackY - 4, trackWidth, 8, 4);

    if (fillWidth > 0) {
      g.fillStyle(color, 0.64);
      g.fillRoundedRect(trackX, trackY - 4, fillWidth, 8, 4);
      g.lineStyle(4, color, 0.09);
      g.lineBetween(trackX, trackY, knobX, trackY);
    }

    g.lineStyle(1, TRON_THEME.gridDim, 0.78);
    g.strokeRoundedRect(trackX, trackY - 4, trackWidth, 8, 4);
    g.lineStyle(2, color, 0.92);
    g.fillStyle(TRON_THEME.panelFill, 0.98);
    g.fillCircle(knobX, trackY, 8);
    g.strokeCircle(knobX, trackY, 8);
    g.lineStyle(5, color, 0.12);
    g.strokeCircle(knobX, trackY, 11);

    this.drawDepthText(x, y, `${label} ${percent}%`, {
      color: TRON_THEME.textPrimary,
      fontSize: "11px",
      fontStyle: "800",
      depth: depth + 0.1,
    });

    const hitArea = this.track(
      this.add.zone(trackX, trackY, trackWidth, hitHeight).setOrigin(0, 0.5),
    );
    hitArea.setDepth(depth + 0.2);
    hitArea.setInteractive({ useHandCursor: true });
    hitArea.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      this.beginVolumeSliderDrag(kind, trackX, trackWidth, pointer);
    });
  }

  private beginVolumeSliderDrag(
    kind: VolumeSliderKind,
    x: number,
    width: number,
    pointer: Phaser.Input.Pointer,
  ): void {
    this.audio.startMusic();
    this.activeVolumeSlider = { kind, x, width };
    this.updateVolumeSliderFromPointer(pointer);
  }

  private updateActiveVolumeSlider(pointer: Phaser.Input.Pointer): void {
    if (!this.activeVolumeSlider) {
      return;
    }

    if (!pointer.isDown) {
      this.stopVolumeSliderDrag();
      return;
    }

    this.updateVolumeSliderFromPointer(pointer);
  }

  private updateVolumeSliderFromPointer(pointer: Phaser.Input.Pointer): void {
    const slider = this.activeVolumeSlider;

    if (!slider) {
      return;
    }

    const worldX = this.cameras.main.getWorldPoint(pointer.x, pointer.y).x;
    const value = Math.min(1, Math.max(0, (worldX - slider.x) / slider.width));
    const currentSettings = this.audio.getSettings();
    const currentValue =
      slider.kind === "music"
        ? currentSettings.musicVolume
        : currentSettings.sfxVolume;

    if (Math.abs(currentValue - value) < 0.005) {
      return;
    }

    if (slider.kind === "music") {
      this.audio.setMusicVolume(value);
    } else {
      this.audio.setSfxVolume(value);
    }

    this.renderIfNotExecuting();
  }

  private stopVolumeSliderDrag(): void {
    this.activeVolumeSlider = undefined;
  }

  private toggleMute(): void {
    this.audio.startMusic();
    this.audio.toggleMuted();
    this.renderIfNotExecuting();
  }

  private renderIfNotExecuting(): void {
    if (this.match.status !== "executing") {
      this.render();
    }
  }

  private drawButton(
    x: number,
    y: number,
    width: number,
    height: number,
    label: string,
    enabled: boolean,
    onClick: () => void,
    depth = 0,
    fontSize = "13px",
    emphasis = false,
  ): void {
    const g = this.track(this.add.graphics());
    const fill = enabled ? (emphasis ? 0x0b4a63 : 0x08263a) : 0x07101b;
    const stroke = enabled ? TRON_THEME.grid : TRON_THEME.gridDim;
    const alpha = enabled ? 0.9 : 0.56;

    g.setDepth(depth);
    g.lineStyle(5, stroke, enabled ? 0.1 : 0.04);
    g.strokeRoundedRect(x - 1, y - 1, width + 2, height + 2, 5);
    g.fillStyle(fill, alpha);
    g.fillRoundedRect(x, y, width, height, 4);
    g.lineStyle(1, stroke, enabled ? 0.86 : 0.32);
    g.strokeRoundedRect(x, y, width, height, 4);
    g.lineStyle(
      1,
      enabled ? TRON_THEME.rivalAccent : TRON_THEME.gridDim,
      enabled ? 0.28 : 0.12,
    );
    g.lineBetween(x + 5, y + 4, x + width - 5, y + 4);

    const buttonText = this.applyTextGlow(
      this.track(
        this.add
          .text(x + width / 2, y + height / 2, label, {
            color: enabled ? TRON_THEME.textPrimary : TRON_THEME.textGhost,
            fontFamily: TRON_THEME.fontFamily,
            fontSize,
            fontStyle: emphasis ? "900" : "700",
            align: "center",
          })
          .setOrigin(0.5),
      ),
      enabled ? this.cssColor(TRON_THEME.grid) : TRON_THEME.textGhost,
      enabled ? 8 : 3,
    );
    buttonText.setDepth(depth + 0.1);

    if (!enabled) {
      return;
    }

    const hitArea = this.track(this.add.zone(x, y, width, height).setOrigin(0));
    hitArea.setDepth(depth + 0.2);
    hitArea.setName(label.replace("\n", " "));
    hitArea.setInteractive({ useHandCursor: true });
    hitArea.on("pointerdown", onClick);
  }

  private moveLabel(move: Move | undefined): string {
    if (!move) {
      return "--";
    }

    return move.toUpperCase();
  }

  private robotName(robot: RobotId): string {
    return robot === "player" ? "You" : "Enemy";
  }

  private robotColor(robot: RobotId): string {
    return this.cssColor(this.robotThemeColor(robot));
  }

  private robotThemeColor(robot: RobotId): number {
    return robot === "player" ? TRON_THEME.player : TRON_THEME.rival;
  }

  private robotAccentColor(robot: RobotId): number {
    return robot === "player" ? TRON_THEME.playerAccent : TRON_THEME.rivalAccent;
  }

  private robotFacing(robot: RobotId): Move {
    const activeStep = this.activeStepVisual?.step;

    if (activeStep) {
      return robot === "player" ? activeStep.playerMove : activeStep.rivalMove;
    }

    const queue = robot === "player" ? this.round.playerQueue : this.round.rivalQueue;
    return queue.at(-1) ?? (robot === "player" ? "right" : "left");
  }

  private cssColor(color: number): string {
    return `#${color.toString(16).padStart(6, "0")}`;
  }

  private applyTextGlow<T extends Phaser.GameObjects.Text>(
    text: T,
    color: string = TRON_THEME.textPrimary,
    blur = 8,
  ): T {
    text.setShadow(0, 0, color, blur, true, true);
    return text;
  }

  private previewStepAlpha(step: number, committedSteps: number): number {
    return step <= committedSteps ? 0.9 : 0.24;
  }

  private previewPoint(tile: TilePosition): Phaser.Math.Vector2 {
    const center = this.tileCenter(tile);

    return new Phaser.Math.Vector2(center.x, center.y);
  }

  private drawPreviewStepNumber(
    point: Phaser.Math.Vector2,
    step: number,
    alpha: number,
  ): void {
    const text = this.track(
      this.add
        .text(point.x, point.y, String(step), {
          color: this.cssColor(TRON_THEME.player),
          fontFamily: TRON_THEME.fontFamily,
          fontSize: `${this.boardFontPx(10)}px`,
          fontStyle: "900",
        })
        .setOrigin(0.5),
    );

    text.setAlpha(alpha);
    text.setDepth(1.5);
  }

  // ---------------------------------------------------------------------------
  // Compact (phone) presentation
  // ---------------------------------------------------------------------------

  private drawCompactHud(c: CompactLayout): void {
    const locked = this.rulesOverlayVisible || this.compactPanel !== null;
    const landscape = c.kind === "landscape";

    this.drawCompactStatus(c, landscape);
    this.drawCompactMenu(c, locked);

    if (this.match.status === "match-complete") {
      this.drawMatchCompleteOverlay();
    } else {
      this.drawCompactQueue(c);
      this.drawCompactControls(c, locked);
      this.drawCompactCoach(c, locked);
      this.drawRoundSummaryOverlay();
    }

    this.drawCompactAudioPanel(c);
  }

  private drawCompactCard(rect: Rect, accent: number, alpha = 0.66): void {
    const g = this.track(this.add.graphics());

    g.setDepth(0.1);
    g.fillStyle(TRON_THEME.panelFill, alpha);
    g.fillRoundedRect(rect.x, rect.y, rect.w, rect.h, 6);
    g.lineStyle(1, accent, 0.5);
    g.strokeRoundedRect(rect.x, rect.y, rect.w, rect.h, 6);
  }

  private compactText(
    x: number,
    y: number,
    text: string | string[],
    color: string,
    fontPx: number,
    options: {
      weight?: string;
      originX?: number;
      originY?: number;
      wrap?: number;
      depth?: number;
    } = {},
  ): Phaser.GameObjects.Text {
    const textObject = this.track(
      this.add
        .text(x, y, text, {
          align: (options.originX ?? 0) === 0.5 ? "center" : "left",
          color,
          fontFamily: TRON_THEME.fontFamily,
          fontSize: `${fontPx}px`,
          fontStyle: options.weight ?? "800",
          lineSpacing: 2,
          wordWrap: options.wrap
            ? { width: options.wrap, useAdvancedWrap: true }
            : undefined,
        })
        .setOrigin(options.originX ?? 0, options.originY ?? 0),
    );

    textObject.setDepth(options.depth ?? 0.3);
    this.applyTextGlow(textObject, color, 6);
    return textObject;
  }

  private drawCompactStatus(c: CompactLayout, landscape: boolean): void {
    const step = this.activeStepVisual?.step;
    const playerDelta = step?.playerScoreDelta ?? 0;
    const rivalDelta = step?.rivalScoreDelta ?? 0;
    const round = `ROUND ${this.match.currentRound} / ${this.match.totalRounds}`;
    const owner = this.round.priorityOwner;

    if (landscape) {
      this.compactText(c.round.x, c.round.y + 2, round, TRON_THEME.textPrimary, 13);
    } else {
      this.drawCompactCard(c.round, TRON_THEME.grid, 0.3);
      this.compactText(
        c.round.x + 10,
        c.round.y + c.round.h / 2,
        round,
        TRON_THEME.textPrimary,
        16,
        { originY: 0.5 },
      );
    }

    this.drawCompactCard(
      c.priority,
      owner === "player" ? TRON_THEME.player : TRON_THEME.rival,
    );
    this.compactText(
      c.priority.x + c.priority.w / 2,
      c.priority.y + 5,
      "PRIORITY",
      TRON_THEME.textMuted,
      11,
      { originX: 0.5, weight: "700" },
    );
    this.compactText(
      c.priority.x + c.priority.w / 2,
      c.priority.y + 19,
      this.robotName(owner).toUpperCase(),
      this.robotColor(owner),
      landscape ? 16 : 17,
      { originX: 0.5, weight: "900" },
    );

    const scoreRows: Array<[Rect, RobotId, number, number]> = [
      [c.scores.you, "player", this.match.playerScore, playerDelta],
      [c.scores.enemy, "rival", this.match.rivalScore, rivalDelta],
    ];

    for (const [rect, robot, score, delta] of scoreRows) {
      const color = this.robotColor(robot);
      const value = `${score}${delta > 0 ? ` +${delta}` : ""}`;

      if (landscape) {
        this.compactText(
          rect.x + 2,
          rect.y + rect.h / 2,
          `${this.robotName(robot).toUpperCase()}: ${value}`,
          color,
          14,
          { originY: 0.5, weight: delta > 0 ? "900" : "700" },
        );
        continue;
      }

      this.drawCompactCard(
        rect,
        robot === "player" ? TRON_THEME.player : TRON_THEME.rival,
      );
      this.compactText(
        rect.x + 10,
        rect.y + 5,
        this.robotName(robot).toUpperCase(),
        color,
        11,
        { weight: "700" },
      );
      this.compactText(rect.x + 10, rect.y + 19, value, color, 17, {
        weight: "900",
      });
    }
  }

  private drawCompactMenu(c: CompactLayout, locked: boolean): void {
    const canOpen = !locked && this.match.status !== "executing";
    const muted = this.audio.getSettings().muted;
    const { rules, sound } = c.menu;

    this.drawButton(
      rules.x,
      rules.y,
      rules.w,
      rules.h,
      "RULES",
      canOpen,
      () => this.showRulesOverlay("rules"),
      0.2,
      "13px",
    );
    this.drawButton(
      sound.x,
      sound.y,
      sound.w,
      sound.h,
      muted ? "MUTED" : "AUDIO",
      !locked,
      () => this.openCompactAudioPanel(),
      0.2,
      "13px",
    );
  }

  private openCompactAudioPanel(): void {
    this.audio.startMusic();
    this.stopVolumeSliderDrag();
    this.compactPanel = "audio";
    this.renderIfNotExecuting();
  }

  private closeCompactPanel(): void {
    if (this.compactPanel === null) {
      return;
    }

    this.stopVolumeSliderDrag();
    this.compactPanel = null;
    this.renderIfNotExecuting();
  }

  private drawCompactQueue(c: CompactLayout): void {
    const area = c.queue.area;
    const executing = this.match.status === "executing";
    const label = executing
      ? `EXECUTING STEP ${this.round.currentExecutionStep} / ${this.round.maxSteps}`
      : `YOUR QUEUE ${this.round.playerQueue.length}/${this.round.maxSteps}`;

    this.compactText(
      area.x + 2,
      area.y,
      label,
      executing ? TRON_THEME.textAmber : TRON_THEME.textPrimary,
      12,
      { weight: "900" },
    );

    const count = this.round.maxSteps;
    const gap = 4;
    const top = area.y + 18;
    const height = area.h - 18;
    const columns = c.queue.style === "row" ? count : 4;
    const rows = Math.ceil(count / columns);
    const chipW = (area.w - gap * (columns - 1)) / columns;
    const chipH = (height - gap * (rows - 1)) / rows;
    const next = this.round.playerQueue.length;

    for (let index = 0; index < count; index += 1) {
      const rect = {
        x: area.x + (index % columns) * (chipW + gap),
        y: top + Math.floor(index / columns) * (chipH + gap),
        w: chipW,
        h: chipH,
      };

      this.drawCompactQueueChip(
        rect,
        index + 1,
        this.round.playerQueue[index],
        index === next && !executing,
      );
    }
  }

  private drawCompactQueueChip(
    rect: Rect,
    step: number,
    move: Move | undefined,
    isNext: boolean,
  ): void {
    const queued = move !== undefined;
    const color = queued ? TRON_THEME.player : TRON_THEME.gridDim;
    const g = this.track(this.add.graphics());

    g.setDepth(0.1);
    g.fillStyle(TRON_THEME.panelFill, queued ? 0.9 : 0.4);
    g.fillRoundedRect(rect.x, rect.y, rect.w, rect.h, 5);
    g.lineStyle(
      isNext ? 2 : 1,
      isNext ? 0xffd166 : color,
      queued || isNext ? 0.9 : 0.4,
    );
    g.strokeRoundedRect(rect.x, rect.y, rect.w, rect.h, 5);

    const glyph = move === undefined ? "" : this.moveGlyph(move);
    const inline = rect.h < 40;
    const numberColor = queued ? TRON_THEME.textMuted : TRON_THEME.textGhost;

    if (inline) {
      this.compactText(rect.x + 5, rect.y + rect.h / 2, String(step), numberColor, 11, {
        originY: 0.5,
        weight: "700",
      });
      this.compactText(
        rect.x + rect.w - 5,
        rect.y + rect.h / 2,
        glyph,
        TRON_THEME.textPrimary,
        move === "wait" ? 11 : 17,
        { originX: 1, originY: 0.5, weight: "900" },
      );
      return;
    }

    this.compactText(rect.x + rect.w / 2, rect.y + 3, String(step), numberColor, 11, {
      originX: 0.5,
      weight: "700",
    });
    this.compactText(
      rect.x + rect.w / 2,
      rect.y + rect.h - 5,
      glyph,
      TRON_THEME.textPrimary,
      move === "wait" ? 11 : 20,
      { originX: 0.5, originY: 1, weight: "900" },
    );
  }

  private moveGlyph(move: Move): string {
    switch (move) {
      case "up":
        return "↑";
      case "down":
        return "↓";
      case "left":
        return "←";
      case "right":
        return "→";
      case "wait":
        return "WAIT";
    }
  }

  private drawCompactControls(c: CompactLayout, locked: boolean): void {
    const canEdit = !locked && this.match.status === "queuing";
    const canExecute = canEdit && isPlayerQueueReady(this.round);
    const fontPx = c.controls.moves.up.w < 70 ? "12px" : c.controls.moves.up.h >= 52 ? "16px" : "14px";
    const labels: Record<Move, string> = {
      up: "UP",
      down: "DOWN",
      left: "LEFT",
      right: "RIGHT",
      wait: "WAIT",
    };

    for (const move of ["up", "left", "wait", "right", "down"] as const) {
      const r = c.controls.moves[move];

      this.drawButton(
        r.x,
        r.y,
        r.w,
        r.h,
        labels[move],
        canEdit,
        () => this.addMove(move),
        0.2,
        fontPx,
      );
    }

    const { undo, clear, execute } = c.controls;

    this.drawButton(
      undo.x,
      undo.y,
      undo.w,
      undo.h,
      "UNDO",
      canEdit,
      () => this.undoMove(),
      0.2,
      "13px",
    );
    this.drawButton(
      clear.x,
      clear.y,
      clear.w,
      clear.h,
      "CLEAR",
      canEdit,
      () => this.clearQueue(),
      0.2,
      "13px",
    );
    this.drawButton(
      execute.x,
      execute.y,
      execute.w,
      execute.h,
      "EXECUTE",
      canExecute,
      () => this.startExecution(),
      0.2,
      "17px",
      true,
    );
  }

  private drawCompactCoach(c: CompactLayout, locked: boolean): void {
    if (!c.coach || !c.skip) {
      return;
    }

    const skip = c.skip;
    const canSkip = !locked && this.match.status !== "executing";
    const landscape = c.kind === "landscape";

    this.drawButton(
      skip.x,
      skip.y,
      skip.w,
      skip.h,
      landscape ? "SKIP GUIDE" : "SKIP\nGUIDE",
      canSkip,
      () => this.skipToStandardMatch(),
      0.2,
      "11px",
    );

    const coach = getGuideCoach({
      mode: this.match.mode,
      round: this.match.currentRound,
      status: this.match.status,
      queueLength: this.round.playerQueue.length,
      maxSteps: this.round.maxSteps,
      priorityOwner: this.round.priorityOwner,
      lastCollisionWinner: this.lastCollisionWinner,
      touch: true,
    });

    if (!coach || c.coach.h < 24) {
      return;
    }

    const rect = c.coach;

    this.drawCompactCard(rect, TRON_THEME.rivalAccent, 0.9);

    const heading = this.compactText(
      rect.x + 8,
      rect.y + 5,
      landscape ? coach.title : `GUIDE · ${coach.title}`,
      TRON_THEME.textAmber,
      11,
      { weight: "900", wrap: rect.w - 16 },
    );
    const bodyTop = rect.y + 5 + heading.height + 3;

    const body = this.compactText(
      rect.x + 8,
      bodyTop,
      coach.text,
      TRON_THEME.textPrimary,
      12,
      { weight: "700", wrap: rect.w - 16 },
    );
    let size = 12;

    while (body.height > rect.y + rect.h - bodyTop - 4 && size > 10) {
      size -= 1;
      body.setFontSize(size);
    }
  }

  private drawCompactAudioPanel(c: CompactLayout): void {
    if (this.compactPanel !== "audio") {
      return;
    }

    const settings = this.audio.getSettings();
    const depth = 12;
    const width = Math.min(c.width - 24, 360);
    const height = 288;
    const x = (c.width - width) / 2;
    const y = Math.max(8, (c.height - height) / 2);
    const inner = width - 32;
    const shade = this.track(this.add.graphics());
    const panel = this.track(this.add.graphics());
    const blocker = this.track(
      this.add.zone(0, 0, c.width, c.height).setOrigin(0),
    );

    shade.setDepth(depth);
    shade.fillStyle(0x01040a, 0.78);
    shade.fillRect(0, 0, c.width, c.height);
    blocker.setDepth(depth + 0.05);
    blocker.setInteractive();

    panel.setDepth(depth + 0.1);
    panel.fillStyle(0x03111d, 0.98);
    panel.fillRoundedRect(x, y, width, height, 8);
    panel.lineStyle(3, TRON_THEME.player, 0.8);
    panel.strokeRoundedRect(x, y, width, height, 8);

    this.compactText(x + 16, y + 20, "AUDIO", TRON_THEME.textPrimary, 16, {
      depth: depth + 0.2,
      weight: "900",
    });
    this.drawButton(
      x + width - 16 - 96,
      y + 8,
      96,
      44,
      settings.muted ? "UNMUTE" : "MUTE",
      true,
      () => this.toggleMute(),
      depth + 0.2,
      "13px",
    );
    this.drawVolumeSlider(
      x + 16,
      y + 62,
      inner,
      "MUSIC VOLUME",
      settings.musicVolume,
      "music",
      TRON_THEME.grid,
      depth + 0.2,
      44,
    );
    this.drawVolumeSlider(
      x + 16,
      y + 132,
      inner,
      "SFX VOLUME",
      settings.sfxVolume,
      "sfx",
      TRON_THEME.rivalAccent,
      depth + 0.2,
      44,
    );
    this.drawButton(
      x + 16,
      y + height - 64,
      inner,
      48,
      "CLOSE",
      true,
      () => this.closeCompactPanel(),
      depth + 0.2,
      "15px",
    );
  }

  private drawCompactRulesOverlay(c: CompactLayout): void {
    const depth = 20;
    const isWelcome = this.rulesOverlayMode === "welcome";
    const pad = 8;
    const landscape = c.kind === "landscape";
    const width = Math.min(c.width - pad * 2, 560);
    const height = landscape
      ? c.height - pad * 2
      : Math.min(c.height - pad * 2, isWelcome ? 400 : 380);
    const x = (c.width - width) / 2;
    const y = (c.height - height) / 2;
    const inner = width - 32;
    const shade = this.track(this.add.graphics());
    const panel = this.track(this.add.graphics());
    const blocker = this.track(
      this.add.zone(0, 0, c.width, c.height).setOrigin(0),
    );

    shade.setDepth(depth);
    shade.fillStyle(0x01040a, 0.86);
    shade.fillRect(0, 0, c.width, c.height);
    blocker.setDepth(depth + 0.05);
    blocker.setInteractive();

    panel.setDepth(depth + 0.1);
    panel.fillStyle(0x03111d, 0.98);
    panel.fillRoundedRect(x, y, width, height, 8);
    panel.lineStyle(3, TRON_THEME.player, 0.8);
    panel.strokeRoundedRect(x, y, width, height, 8);

    const priorityOwner = this.robotName(this.round.priorityOwner).toUpperCase();
    const buttonH = 48;
    const footerY = y + height - buttonH - 12;

    if (isWelcome) {
      this.compactText(
        x + width / 2,
        y + 16,
        GAME_TITLE.toUpperCase(),
        TRON_THEME.textPrimary,
        landscape ? 24 : 30,
        { originX: 0.5, weight: "900", depth: depth + 0.2 },
      );
      this.compactText(
        x + width / 2,
        y + (landscape ? 48 : 58),
        "WELCOME TO THE GRID",
        TRON_THEME.textAmber,
        12,
        { originX: 0.5, weight: "900", depth: depth + 0.2 },
      );
      this.compactText(
        x + 16,
        y + (landscape ? 70 : 90),
        [
          "- Queue moves with the on-screen buttons, then tap EXECUTE.",
          "- Small nodes score 1, large nodes score 3.",
          "- Clashes go to the priority owner; the loser is stunned.",
          "- You are cyan, the enemy is orange.",
        ].join("\n"),
        TRON_THEME.textPrimary,
        landscape ? 14 : 14,
        { weight: "700", wrap: inner, depth: depth + 0.2 },
      );

      const half = (inner - 8) / 2;

      if (landscape) {
        this.drawButton(x + 16, footerY, half, buttonH, "START GUIDED DUEL", true, () => this.beginFromWelcome("guided"), depth + 0.3, "13px");
        this.drawButton(x + 24 + half, footerY, half, buttonH, "SKIP TO STANDARD", true, () => this.beginFromWelcome("standard"), depth + 0.3, "13px");
      } else {
        this.drawButton(x + 16, footerY - buttonH - 8, inner, buttonH, "START GUIDED DUEL", true, () => this.beginFromWelcome("guided"), depth + 0.3, "15px");
        this.drawButton(x + 16, footerY, inner, buttonH, "SKIP TO STANDARD MATCH", true, () => this.beginFromWelcome("standard"), depth + 0.3, "13px");
      }

      return;
    }

    const pages: Array<{ title: string; accent: number; lines: string[] }> = [
      {
        title: "ROUND FLOW",
        accent: TRON_THEME.player,
        lines: [
          "You are cyan; enemy is orange.",
          `Queue ${this.round.maxSteps} moves this round.`,
          "Both robots reveal together.",
          "Small nodes are worth 1, large nodes 3.",
          `Highest score after ${this.match.totalRounds} rounds wins.`,
        ],
      },
      {
        title: "CONTROLS",
        accent: TRON_THEME.grid,
        lines: [
          "Tap UP, DOWN, LEFT, RIGHT or WAIT to queue a move.",
          "UNDO removes the last move; CLEAR empties the queue.",
          "EXECUTE runs both plans together.",
          "Keyboard: arrows or WASD, Space, Backspace, Enter, H.",
        ],
      },
      {
        title: "COLLISIONS",
        accent: TRON_THEME.rivalAccent,
        lines: [
          "Same tile or crossing paths causes a clash.",
          `This round: ${priorityOwner} wins clashes and takes the tile/node.`,
          "Collision priority swaps each round.",
          "Loser is stunned: only their next move becomes WAIT.",
        ],
      },
    ];
    const page = Math.min(this.rulesPage, pages.length - 1);
    const current = pages[page];

    this.compactText(
      x + 16,
      y + 14,
      `${current.title}  ${page + 1}/${pages.length}`,
      this.cssColor(current.accent),
      16,
      { weight: "900", depth: depth + 0.2 },
    );
    this.compactText(
      x + 16,
      y + 46,
      current.lines.map((line) => `- ${line}`).join("\n"),
      TRON_THEME.textPrimary,
      landscape ? 15 : 15,
      { weight: "700", wrap: inner, depth: depth + 0.2 },
    );

    const third = (inner - 16) / 3;
    const last = page === pages.length - 1;

    this.drawButton(x + 16, footerY, third, buttonH, "BACK", page > 0, () => this.turnRulesPage(-1), depth + 0.3, "14px");
    this.drawButton(x + 24 + third, footerY, third, buttonH, last ? "DONE" : "NEXT", true, () => (last ? this.hideRulesOverlay() : this.turnRulesPage(1)), depth + 0.3, "14px");
    this.drawButton(x + 32 + third * 2, footerY, third, buttonH, "CLOSE", true, () => this.hideRulesOverlay(), depth + 0.3, "14px");
  }

  private turnRulesPage(delta: number): void {
    this.rulesPage = Math.max(0, this.rulesPage + delta);
    this.render();
  }
}
