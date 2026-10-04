import * as Phaser from "phaser";

import { GameScene } from "./GameScene";
import "./style.css";

// Signal to Wavedash that the game is ready, dismissing the platform loading screen.
// WavedashJS is injected automatically when running on Wavedash — safe to skip elsewhere.
if (typeof WavedashJS !== "undefined") {
  WavedashJS.init();
}

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: "game",
  backgroundColor: "#050814",
  scene: [GameScene],
  scale: {
    // The scene lays itself out for the real viewport size (desktop composition,
    // portrait phone or landscape phone), so the canvas tracks its container 1:1.
    mode: Phaser.Scale.RESIZE,
    width: "100%",
    height: "100%",
  },
};

const game = new Phaser.Game(config);

if (import.meta.env.DEV) {
  // Lets scripted browsers find on-screen controls to tap during layout checks.
  (window as unknown as { __energyDuel?: Phaser.Game }).__energyDuel = game;
}
