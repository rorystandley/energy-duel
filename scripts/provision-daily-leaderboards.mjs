#!/usr/bin/env node
/**
 * Operator tool: makes the Daily Duel leaderboards publicly visible.
 * See docs/DAILY_LEADERBOARD.md.
 *
 *   WAVEDASH_TOKEN=<API key from Developer Portal> \
 *     node scripts/provision-daily-leaderboards.mjs [--from YYYY-MM-DD] [--days 14] [--rules-version N] [--apply]
 *
 * Without --apply it only prints the board names and what it would do.
 * It edits the game in wavedash.toml, which is the LIVE game: there is no sandbox flag.
 *
 * What it can and cannot do (Wavedash documents only PATCH for leaderboards):
 *   - PATCH /api/games/{gameId}/leaderboards/by-name/{name}
 *       sets visible=true, displayName, sortOrder=1 (descending), displayType=0 (numeric)
 *   - It cannot create a board. A board must already exist. A 404 is reported as
 *     "missing" and the script exits non-zero, so a gap is never mistaken for success.
 * Boards the game's players create through the SDK default to Hidden; this script is
 * what turns them public (and corrects their sort order, which a client could have set wrong).
 */
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const apply = args.includes("--apply");

const gameId =
  /game_id\s*=\s*"([^"]+)"/.exec(readFileSync(new URL("wavedash.toml", root), "utf8"))?.[1];
const rulesVersion = Number(
  flag(
    "rules-version",
    /RULES_VERSION\s*=\s*(\d+)/.exec(readFileSync(new URL("src/game/match-rules.ts", root), "utf8"))?.[1],
  ),
);
const days = Number(flag("days", "14"));
const from = flag("from", new Date().toISOString().slice(0, 10));

if (!gameId || !Number.isInteger(rulesVersion) || rulesVersion < 1 || !Number.isInteger(days) || days < 1) {
  console.error("Could not determine game id, rules version or day count.");
  process.exit(2);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(Date.parse(`${from}T00:00:00Z`))) {
  console.error(`Bad --from date: ${from}`);
  process.exit(2);
}

// Must match dailyLeaderboardName() in src/game/daily-leaderboard.ts.
const names = Array.from({ length: days }, (_, i) => {
  const d = new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000);
  return `daily-v${rulesVersion}-${d.toISOString().slice(0, 10)}`;
});

const token = process.env.WAVEDASH_TOKEN;
if (apply && !token) {
  console.error("Set WAVEDASH_TOKEN to an API key from the Developer Portal (API Keys).");
  process.exit(2);
}

console.log(`${apply ? "APPLYING to" : "Dry run for"} game ${gameId}, ${names.length} board(s):`);
let problems = 0;

for (const name of names) {
  if (!apply) {
    console.log(`  would PATCH by-name/${name}  visible=true sort=DESC type=NUMERIC`);
    continue;
  }
  try {
    const response = await fetch(
      `https://api.wavedash.com/api/games/${gameId}/leaderboards/by-name/${encodeURIComponent(name)}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          visible: true,
          displayName: `Daily Duel ${name.slice(-10)} (rules v${rulesVersion})`,
          sortOrder: 1,
          displayType: 0,
        }),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.leaderboard?.visible === true) {
      console.log(`  ok       ${name}`);
    } else if (response.status === 404) {
      problems += 1;
      console.log(`  MISSING  ${name}  -> create it first (portal: Leaderboards, name exactly as shown, Descending, Numeric), then re-run`);
    } else {
      problems += 1;
      console.log(`  FAILED   ${name}  HTTP ${response.status} ${JSON.stringify(body)}`);
    }
  } catch (error) {
    problems += 1;
    console.log(`  FAILED   ${name}  ${error instanceof Error ? error.message : error}`);
  }
}

if (apply && problems > 0) {
  console.error(`${problems} board(s) are NOT public. Players will see "online board not open yet" for them.`);
  process.exit(1);
}
