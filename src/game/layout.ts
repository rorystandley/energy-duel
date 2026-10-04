import { BOARD_SIZE, CELL_SIZE, GAME_HEIGHT, GAME_WIDTH } from "./constants";
import type { Move } from "./types";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type LayoutKind = "desktop" | "portrait" | "landscape";

export interface DesktopLayout {
  kind: "desktop";
  width: number;
  height: number;
  /** Camera zoom that fits the fixed 960x720 composition into the viewport. */
  zoom: number;
}

export interface CompactLayout {
  kind: "portrait" | "landscape";
  width: number;
  height: number;
  zoom: 1;
  /** The board layer is drawn at 512px design size and scaled by `scale`. */
  board: { x: number; y: number; size: number; scale: number };
  round: Rect;
  priority: Rect;
  scores: { you: Rect; enemy: Rect };
  menu: { rules: Rect; sound: Rect };
  queue: { area: Rect; style: "row" | "grid" };
  coach: Rect | null;
  skip: Rect | null;
  controls: {
    moves: Record<Move, Rect>;
    undo: Rect;
    clear: Rect;
    execute: Rect;
  };
}

export type GameLayout = DesktopLayout | CompactLayout;

export interface LayoutOptions {
  guided?: boolean;
}

export const DESIGN_BOARD_PIXELS = BOARD_SIZE * CELL_SIZE;
export const MIN_TOUCH_TARGET = 44;

const PORTRAIT_RATIO = 0.9;
const DESKTOP_MIN_WIDTH = 700;
const DESKTOP_MIN_HEIGHT = 560;

export function classifyViewport(width: number, height: number): LayoutKind {
  if (width < height * PORTRAIT_RATIO) {
    return "portrait";
  }

  if (width < DESKTOP_MIN_WIDTH || height < DESKTOP_MIN_HEIGHT) {
    return "landscape";
  }

  return "desktop";
}

export function computeLayout(
  width: number,
  height: number,
  options: LayoutOptions = {},
): GameLayout {
  const kind = classifyViewport(width, height);

  if (kind === "desktop") {
    return {
      kind,
      width,
      height,
      zoom: Math.min(width / GAME_WIDTH, height / GAME_HEIGHT),
    };
  }

  return kind === "portrait"
    ? computePortrait(width, height, Boolean(options.guided))
    : computeLandscape(width, height, Boolean(options.guided));
}

function rect(x: number, y: number, w: number, h: number): Rect {
  return { x, y, w, h };
}

function moveRects(
  mode: "pad" | "row",
  x: number,
  y: number,
  width: number,
  buttonHeight: number,
  gap: number,
): { moves: Record<Move, Rect>; height: number } {
  if (mode === "row") {
    const w = (width - gap * 4) / 5;
    const at = (index: number) => rect(x + index * (w + gap), y, w, buttonHeight);

    return {
      moves: {
        left: at(0),
        up: at(1),
        down: at(2),
        right: at(3),
        wait: at(4),
      },
      height: buttonHeight,
    };
  }

  const w = Math.min(96, (width - gap * 2) / 3);
  const left = x + (width - (w * 3 + gap * 2)) / 2;
  const col = (index: number) => left + index * (w + gap);
  const row = (index: number) => y + index * (buttonHeight + gap);

  return {
    moves: {
      up: rect(col(1), row(0), w, buttonHeight),
      left: rect(col(0), row(1), w, buttonHeight),
      wait: rect(col(1), row(1), w, buttonHeight),
      right: rect(col(2), row(1), w, buttonHeight),
      down: rect(col(1), row(2), w, buttonHeight),
    },
    height: buttonHeight * 3 + gap * 2,
  };
}

function actionRects(
  x: number,
  y: number,
  width: number,
  height: number,
  gap: number,
): { undo: Rect; clear: Rect; execute: Rect } {
  const usable = width - gap * 2;
  const undoW = usable * 0.27;
  const clearW = usable * 0.27;
  const executeW = usable - undoW - clearW;

  return {
    undo: rect(x, y, undoW, height),
    clear: rect(x + undoW + gap, y, clearW, height),
    execute: rect(x + undoW + clearW + gap * 2, y, executeW, height),
  };
}

function computePortrait(
  width: number,
  height: number,
  guided: boolean,
): CompactLayout {
  const pad = Math.max(8, Math.min(12, Math.round(width * 0.03)));
  const gap = 8;
  const innerW = width - pad * 2;
  const rowH = MIN_TOUCH_TARGET;
  const buttonH = 52;
  const queueH = 54;
  const coachH = guided ? 66 : 0;
  const coachBlock = guided ? coachH + gap : 0;
  const header = pad + rowH + 6 + rowH + gap;
  const tail = gap + queueH + gap + coachBlock;
  const padControlsH = buttonH * 3 + gap * 2 + gap + buttonH;
  const rowControlsH = buttonH + gap + buttonH;

  // Prefer the thumb-friendly cross pad when the board can still own the width.
  const padBoard = height - pad - header - tail - padControlsH - gap * 0;
  const usePad = padBoard >= innerW * 0.9;
  const controlsH = usePad ? padControlsH : rowControlsH;
  const available = height - header - tail - controlsH - pad;
  const size = Math.max(180, Math.min(innerW, available));
  const boardX = (width - size) / 2;
  const boardY = header;
  const queueY = boardY + size + gap;
  const coachY = queueY + queueH + gap;
  const controlsY = height - pad - controlsH;
  const moves = moveRects(usePad ? "pad" : "row", pad, controlsY, innerW, buttonH, gap);
  const actions = actionRects(
    pad,
    controlsY + moves.height + gap,
    innerW,
    buttonH,
    gap,
  );
  const menuW = 70;
  const scoreW = (innerW - gap * 2) / 3;
  const scoreY = pad + rowH + 6;

  return {
    kind: "portrait",
    width,
    height,
    zoom: 1,
    board: { x: boardX, y: boardY, size, scale: size / DESIGN_BOARD_PIXELS },
    round: rect(pad, pad, innerW - menuW * 2 - gap * 2, rowH),
    menu: {
      rules: rect(width - pad - menuW * 2 - gap, pad, menuW, rowH),
      sound: rect(width - pad - menuW, pad, menuW, rowH),
    },
    scores: {
      you: rect(pad, scoreY, scoreW, rowH),
      enemy: rect(pad + scoreW * 2 + gap * 2, scoreY, scoreW, rowH),
    },
    priority: rect(pad + scoreW + gap, scoreY, scoreW, rowH),
    queue: { area: rect(pad, queueY, innerW, queueH), style: "row" },
    coach: guided ? rect(pad, coachY, innerW - 84, coachH) : null,
    skip: guided ? rect(width - pad - 76, coachY, 76, coachH) : null,
    controls: { moves: moves.moves, ...actions },
  };
}

function computeLandscape(
  width: number,
  height: number,
  guided: boolean,
): CompactLayout {
  const pad = 8;
  const gap = 6;
  const leftW = width >= 640 ? 120 : 104;
  const rightMin = width >= 640 ? 176 : 164;
  const rightMax = 300;
  const size = Math.max(
    180,
    Math.min(height - pad * 2, width - leftW - rightMin - pad * 4),
  );
  const rightW = Math.min(rightMax, width - leftW - size - pad * 4);
  const groupW = leftW + pad + size + pad + rightW;
  const startX = Math.max(pad, Math.round((width - groupW) / 2));
  const leftX = startX;
  const boardX = leftX + leftW + pad;
  const rightX = boardX + size + pad;
  const boardY = Math.round((height - size) / 2);
  const top = pad;

  const queueH = 74;
  const buttonH = Math.max(
    MIN_TOUCH_TARGET - 4,
    Math.min(48, Math.floor((height - pad * 2 - queueH - gap * 4) / 4)),
  );
  const queueArea = rect(rightX, top, rightW, queueH);
  const controlsY = top + queueH + gap;
  const moves = moveRects("pad", rightX, controlsY, rightW, buttonH, gap);
  const actions = actionRects(
    rightX,
    controlsY + moves.height + gap,
    rightW,
    buttonH,
    gap,
  );

  const menuH = MIN_TOUCH_TARGET;
  const menuW = (leftW - gap) / 2;
  const menuY = height - pad - menuH;
  const skipH = 36;
  const skipY = menuY - gap - skipH;
  const statusBottom = top + 20 + 6 + 40 + 6 + 22 + 22;
  const coachTop = statusBottom + gap;
  const coachBottom = guided ? skipY - gap : menuY - gap;

  return {
    kind: "landscape",
    width,
    height,
    zoom: 1,
    board: { x: boardX, y: boardY, size, scale: size / DESIGN_BOARD_PIXELS },
    round: rect(leftX, top, leftW, 20),
    priority: rect(leftX, top + 26, leftW, 40),
    scores: {
      you: rect(leftX, top + 72, leftW, 22),
      enemy: rect(leftX, top + 94, leftW, 22),
    },
    menu: {
      rules: rect(leftX, menuY, menuW, menuH),
      sound: rect(leftX + menuW + gap, menuY, menuW, menuH),
    },
    queue: { area: queueArea, style: "grid" },
    coach: guided ? rect(leftX, coachTop, leftW, Math.max(0, coachBottom - coachTop)) : null,
    skip: guided ? rect(leftX, skipY, leftW, skipH) : null,
    controls: { moves: moves.moves, ...actions },
  };
}

export function isCompact(layout: GameLayout): layout is CompactLayout {
  return layout.kind !== "desktop";
}
