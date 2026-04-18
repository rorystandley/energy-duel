import type { PickupValue } from "./types";

export const TRON_THEME = {
  backgroundCss: "#02040b",
  background: 0x02040b,
  backdropLine: 0x00eaff,
  boardFill: 0x030b18,
  boardGlow: 0x00eaff,
  grid: 0x00eaff,
  gridDim: 0x075e78,
  panelFill: 0x06111e,
  robotShell: 0x071626,
  blockerFill: 0x060914,
  blockerEdge: 0x00eaff,
  blockerAccent: 0xff4fd8,
  player: 0x00eaff,
  playerAccent: 0xa7f3ff,
  rival: 0xff7a3d,
  rivalAccent: 0xff4fd8,
  textPrimary: "#f4fdff",
  textMuted: "#7ff5ff",
  textGhost: "#2fc8df",
  textMagenta: "#ff4fd8",
  textAmber: "#ffd166",
  fontFamily:
    "Orbitron, Audiowide, Rajdhani, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
} as const;

export function getPickupStyle(value: PickupValue): {
  ring: number;
  core: number;
  text: string;
} {
  if (value === 3) {
    return {
      ring: 0xff4fd8,
      core: 0xffd166,
      text: "#ffd166",
    };
  }

  return {
    ring: 0xa7f3ff,
    core: 0xe7fbff,
    text: "#e7fbff",
  };
}
