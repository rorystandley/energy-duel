import { describe, expect, it } from "vitest";

import { classifyViewport, computeLayout, isCompact } from "./layout";
import type { CompactLayout, Rect } from "./layout";

const VIEWPORTS: Array<[string, number, number]> = [
  ["phone portrait", 390, 844],
  ["small phone", 320, 568],
  ["mid phone", 375, 667],
  ["phone landscape", 844, 390],
  ["mid landscape", 667, 375],
  ["small landscape", 568, 320],
  ["tablet portrait", 768, 1024],
];

function compact(width: number, height: number, guided: boolean): CompactLayout {
  const layout = computeLayout(width, height, { guided });

  if (!isCompact(layout)) {
    throw new Error("expected a compact layout");
  }

  return layout;
}

function interactiveRects(layout: CompactLayout): Rect[] {
  return [
    ...Object.values(layout.controls.moves),
    layout.controls.undo,
    layout.controls.clear,
    layout.controls.execute,
    layout.menu.rules,
    layout.menu.sound,
  ];
}

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w - 0.5 &&
    b.x < a.x + a.w - 0.5 &&
    a.y < b.y + b.h - 0.5 &&
    b.y < a.y + a.h - 0.5
  );
}

function allRects(layout: CompactLayout): Rect[] {
  const board = layout.board;
  const rects: Rect[] = [
    { x: board.x, y: board.y, w: board.size, h: board.size },
    layout.round,
    layout.priority,
    layout.scores.you,
    layout.scores.enemy,
    layout.queue.area,
    ...interactiveRects(layout),
  ];

  if (layout.coach) {
    rects.push(layout.coach);
  }

  if (layout.skip) {
    rects.push(layout.skip);
  }

  return rects;
}

describe("classifyViewport", () => {
  it("picks a layout for each target viewport", () => {
    expect(classifyViewport(390, 844)).toBe("portrait");
    expect(classifyViewport(320, 568)).toBe("portrait");
    expect(classifyViewport(844, 390)).toBe("landscape");
    expect(classifyViewport(667, 375)).toBe("landscape");
    expect(classifyViewport(1280, 720)).toBe("desktop");
    expect(classifyViewport(960, 720)).toBe("desktop");
  });

  it("keeps the fixed desktop composition scaled to fit", () => {
    const layout = computeLayout(1920, 1080);

    expect(layout.kind).toBe("desktop");
    expect(layout.zoom).toBeCloseTo(1.5);
  });
});

describe.each(VIEWPORTS)("compact layout at %s (%ix%i)", (_name, width, height) => {
  for (const guided of [false, true]) {
    it(`fits the viewport without overlaps (guided: ${guided})`, () => {
      const layout = compact(width, height, guided);
      const rects = allRects(layout);

      for (const r of rects) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(width + 0.5);
        expect(r.y + r.h).toBeLessThanOrEqual(height + 0.5);
      }

      for (let i = 0; i < rects.length; i += 1) {
        for (let j = i + 1; j < rects.length; j += 1) {
          expect(overlaps(rects[i], rects[j]), `${i} vs ${j}`).toBe(false);
        }
      }
    });

    it(`keeps touch targets reachable and large (guided: ${guided})`, () => {
      const layout = compact(width, height, guided);
      const smallest = height < 340 ? 40 : 44;

      for (const r of interactiveRects(layout)) {
        expect(r.h).toBeGreaterThanOrEqual(smallest);
        expect(r.w).toBeGreaterThanOrEqual(smallest);
      }
    });
  }

  it("gives the board most of the shorter screen edge", () => {
    const layout = compact(width, height, false);
    const limit = Math.min(width, height);

    expect(layout.board.size).toBeGreaterThanOrEqual(limit * 0.72);
  });
});

describe("portrait thumb reach", () => {
  it("anchors controls to the bottom half at 390x844", () => {
    const layout = compact(390, 844, true);

    for (const r of Object.values(layout.controls.moves)) {
      expect(r.y).toBeGreaterThan(844 / 2);
    }

    expect(layout.controls.execute.y).toBeGreaterThan(844 / 2);
    expect(layout.board.size).toBeGreaterThanOrEqual(390 * 0.85);
  });
});
