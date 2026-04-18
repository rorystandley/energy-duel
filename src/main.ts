import * as Phaser from "phaser";

import { GameScene } from "./GameScene";
import { GAME_HEIGHT, GAME_WIDTH } from "./game/constants";
import "./style.css";

// Signal to Wavedash that the game is ready, dismissing the platform loading screen.
// WavedashJS is injected automatically when running on Wavedash — safe to skip elsewhere.
if (typeof WavedashJS !== "undefined") {
  WavedashJS.init();
}

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: "game",
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: "#050814",
  scene: [GameScene],
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
};

new Phaser.Game(config);
