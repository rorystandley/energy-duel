import * as Phaser from "phaser";

import { GameScene } from "./GameScene";
import { wavedash } from "./platform/wavedash";
import "./style.css";

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

// Dismisses the Wavedash loading screen once Phaser is up; a no-op for guests.
game.events.once(Phaser.Core.Events.READY, () => {
  void wavedash.initialize();
});

if (import.meta.env.DEV) {
  // Lets scripted browsers find on-screen controls to tap during layout checks.
  (window as unknown as { __energyDuel?: Phaser.Game }).__energyDuel = game;
}
