#!/usr/bin/env node
/**
 * Owner tool, run ONCE: makes the permanent Daily Duel leaderboard public.
 * See docs/DAILY_LEADERBOARD.md.
 *
 *   WAVEDASH_TOKEN=<API key from Developer Portal> node scripts/provision-daily-leaderboards.mjs [--apply]
 *
 * Without --apply it only prints what it would do.
 * It edits the game in wavedash.toml, which is the LIVE game: there is no sandbox flag.
 *
 * Wavedash documents only PATCH for leaderboards, so this cannot create the board:
 *   - PATCH /api/games/{gameId}/leaderboards/by-name/{name}
 *       sets visible=true, displayName, sortOrder=1 (descending), displayType=0 (numeric)
 *   - A 404 is reported as "missing" (create it first) and exits non-zero.
 */
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const apply = process.argv.includes("--apply");

const gameId =
  /game_id\s*=\s*"([^"]+)"/.exec(readFileSync(new URL("wavedash.toml", root), "utf8"))?.[1];
const name =
  /DAILY_LEADERBOARD_NAME\s*=\s*"([^"]+)"/.exec(
    readFileSync(new URL("src/game/daily-leaderboard.ts", root), "utf8"),
  )?.[1];

if (!gameId || !name) {
  console.error("Could not determine game id or board name.");
  process.exit(2);
}

const token = process.env.WAVEDASH_TOKEN;
if (apply && !token) {
  console.error("Set WAVEDASH_TOKEN to an API key from the Developer Portal (API Keys).");
  process.exit(2);
}

if (!apply) {
  console.log(`Dry run for game ${gameId}: would PATCH by-name/${name}  visible=true sort=DESC type=NUMERIC`);
  process.exit(0);
}

try {
  const response = await fetch(
    `https://api.wavedash.com/api/games/${gameId}/leaderboards/by-name/${encodeURIComponent(name)}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ visible: true, displayName: "Daily Duel - best margin", sortOrder: 1, displayType: 0 }),
    },
  );
  const body = await response.json().catch(() => ({}));
  if (response.ok && body.leaderboard?.visible === true) {
    console.log(`ok       ${name} is public`);
  } else if (response.status === 404) {
    console.error(`MISSING  ${name} -> create it first (portal: Leaderboards, exact name, Descending, Numeric), then re-run`);
    process.exit(1);
  } else {
    console.error(`FAILED   ${name}  HTTP ${response.status} ${JSON.stringify(body)}`);
    process.exit(1);
  }
} catch (error) {
  console.error(`FAILED   ${name}  ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
