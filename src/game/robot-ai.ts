import { HIGH_PICKUP_VALUE, MOVES, MOVES_PER_ROUND } from "./constants";
import {
  canEnterTile,
  copyTile,
  manhattanDistance,
  moveTile,
  sameTile,
  tileKey,
} from "./board";
import type {
  BoardState,
  Move,
  Pickup,
  RivalMood,
  RobotId,
  TilePosition,
} from "./types";

interface RivalPlanningContext {
  playerTile?: TilePosition;
  priorityOwner?: RobotId;
  seed?: number;
}

interface PlayerPlan {
  tiles: TilePosition[];
  pickupArrivalSteps: Map<string, number>;
  shortestPickupDistances: Map<string, number>;
}

interface TargetRoute {
  pickup: Pickup;
  path: Move[];
  score: number;
  collisionRisk: number;
  playerArrivalStep?: number;
}

interface MoveOption {
  move: Move;
  tile: TilePosition;
}

interface BehaviorTuning {
  behavior: RivalMood;
  riskTaking: boolean;
  temperature: number;
  fallbackTemperature: number;
  valueWeight: number;
  highValueBonus: number;
  distancePenalty: number;
  contestBonus: number;
  latePenalty: number;
  earlyBonus: number;
  collisionPenalty: number;
  repeatedCollisionPenalty: number;
  detourChance: number;
  pathCollisionBias: number;
}

interface WeightedOption<T> {
  item: T;
  weight: number;
}

type RandomSource = () => number;

const BASE_TUNING: Record<
  RivalMood,
  Omit<BehaviorTuning, "behavior" | "riskTaking" | "pathCollisionBias">
> = {
  aggressive: {
    temperature: 6.5,
    fallbackTemperature: 3.2,
    valueWeight: 7,
    highValueBonus: 2.2,
    distancePenalty: 1.45,
    contestBonus: 4.4,
    latePenalty: 1.45,
    earlyBonus: 1.2,
    collisionPenalty: 3.4,
    repeatedCollisionPenalty: 8,
    detourChance: 0.1,
  },
  greedy: {
    temperature: 5.2,
    fallbackTemperature: 2.8,
    valueWeight: 7.8,
    highValueBonus: 4.2,
    distancePenalty: 1.35,
    contestBonus: 1.8,
    latePenalty: 2.3,
    earlyBonus: 1.6,
    collisionPenalty: 4,
    repeatedCollisionPenalty: 7,
    detourChance: 0.14,
  },
  safe: {
    temperature: 4.2,
    fallbackTemperature: 2.2,
    valueWeight: 6.2,
    highValueBonus: 1.8,
    distancePenalty: 2.15,
    contestBonus: 1.2,
    latePenalty: 3.8,
    earlyBonus: 1,
    collisionPenalty: 6.4,
    repeatedCollisionPenalty: 9,
    detourChance: 0.05,
  },
};

export interface RivalPlan {
  moves: Move[];
  mood: RivalMood;
}

export function planRivalMoves(
  board: BoardState,
  startTile: TilePosition,
  pickups: Pickup[],
  context: RivalPlanningContext = {},
): Move[] {
  return planRivalTurn(board, startTile, pickups, context).moves;
}

export function planRivalTurn(
  board: BoardState,
  startTile: TilePosition,
  pickups: Pickup[],
  context: RivalPlanningContext = {},
): RivalPlan {
  const queue: Move[] = [];
  let currentTile = copyTile(startTile);
  let previousTile: TilePosition | undefined;
  const random = createPlanningRandomSource(board, startTile, pickups, context);
  let behavior = chooseBehavior(random);
  let recentCollisionPlans = 0;
  const remainingPickups = pickups.map(copyPickup);
  const playerPlan = createPlayerPlan(
    board,
    context.playerTile,
    pickups,
  );

  while (queue.length < MOVES_PER_ROUND) {
    behavior = maybeShiftBehavior(behavior, queue.length, random);
    const tuning = createBehaviorTuning(
      behavior,
      context.priorityOwner,
      recentCollisionPlans,
      random,
    );
    const targetRoute = chooseTargetRoute(
      board,
      currentTile,
      remainingPickups,
      queue.length,
      playerPlan,
      tuning,
      random,
    );
    const nextMove = targetRoute
      ? chooseRouteMove(
          board,
          currentTile,
          targetRoute,
          previousTile,
          queue.length,
          playerPlan,
          tuning,
          random,
        )
      : chooseFallbackMove(
          board,
          currentTile,
          remainingPickups,
          previousTile,
          queue.length,
          playerPlan,
          tuning,
          random,
        );
    const nextTile = validDestination(board, currentTile, nextMove);
    const plannedCollision = hasPredictedCollision(
      currentTile,
      nextTile,
      queue.length + 1,
      playerPlan,
    );

    queue.push(nextMove);
    previousTile = currentTile;
    currentTile = nextTile;
    recentCollisionPlans = plannedCollision
      ? recentCollisionPlans + 1
      : Math.max(0, recentCollisionPlans - 1);
    removePickupAt(remainingPickups, currentTile);
  }

  return {
    moves: queue,
    mood: behavior,
  };
}

function chooseBehavior(random: RandomSource): RivalMood {
  return chooseWeighted(
    [
      { item: "aggressive" as const, weight: 0.3 },
      { item: "greedy" as const, weight: 0.35 },
      { item: "safe" as const, weight: 0.35 },
    ],
    random,
  ) ?? "greedy";
}

function maybeShiftBehavior(
  behavior: RivalMood,
  queuedMoves: number,
  random: RandomSource,
): RivalMood {
  if (queuedMoves === 0 || queuedMoves % 3 !== 0 || random() > 0.28) {
    return behavior;
  }

  return chooseBehavior(random);
}

function createBehaviorTuning(
  behavior: RivalMood,
  priorityOwner: RobotId | undefined,
  recentCollisionPlans: number,
  random: RandomSource,
): BehaviorTuning {
  const base = BASE_TUNING[behavior];
  const riskTaking = random() < getRiskChance(behavior);
  const rivalHasPriority = priorityOwner === "rival";
  let collisionPenalty = base.collisionPenalty;
  let pathCollisionBias = base.collisionPenalty + 2;

  if (rivalHasPriority) {
    collisionPenalty -= riskTaking ? 2.4 : 1.2;
    pathCollisionBias = riskTaking ? -1.2 : 1.6;
  } else {
    collisionPenalty += riskTaking ? -0.8 : 1.8;
    pathCollisionBias = riskTaking ? 3 : 8;
  }

  if (recentCollisionPlans > 0) {
    collisionPenalty += recentCollisionPlans * 3.5;
    pathCollisionBias = Math.max(pathCollisionBias, 7 + recentCollisionPlans * 4);
  }

  return {
    ...base,
    behavior,
    riskTaking,
    collisionPenalty: Math.max(0.9, collisionPenalty),
    pathCollisionBias,
  };
}

function getRiskChance(behavior: RivalMood): number {
  switch (behavior) {
    case "aggressive":
      return 0.42;
    case "greedy":
      return 0.24;
    case "safe":
      return 0.1;
  }
}

function chooseTargetRoute(
  board: BoardState,
  from: TilePosition,
  pickups: Pickup[],
  queuedMoves: number,
  playerPlan: PlayerPlan | undefined,
  tuning: BehaviorTuning,
  random: RandomSource,
): TargetRoute | undefined {
  const routes = pickups
    .map((pickup) =>
      createTargetRoute(
        board,
        from,
        pickup,
        queuedMoves,
        playerPlan,
        tuning,
        random,
      ),
    )
    .filter((route): route is TargetRoute => route !== undefined);

  if (routes.length === 0) {
    return undefined;
  }

  return chooseWeightedRoute(routes, tuning, random);
}

function chooseWeightedRoute(
  routes: TargetRoute[],
  tuning: BehaviorTuning,
  random: RandomSource,
): TargetRoute {
  const bestRoute = routes
    .slice()
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length)[0];
  const scoreWindow = tuning.riskTaking ? 16 : 11;
  const candidates = routes.filter((route) => {
    const scoreGap = bestRoute.score - route.score;
    const extraValueGrace = route.pickup.value === HIGH_PICKUP_VALUE ? 4 : 0;

    return scoreGap <= scoreWindow + extraValueGrace;
  });
  const bestScore = Math.max(...candidates.map((route) => route.score));
  const weightedRoutes = candidates.map((route) => ({
    item: route,
    weight:
      Math.exp((route.score - bestScore) / tuning.temperature) *
      (route.pickup.value === HIGH_PICKUP_VALUE ? 1.35 : 1) *
      getContestWeight(route, tuning),
  }));

  return chooseWeighted(weightedRoutes, random) ?? bestRoute;
}

function getContestWeight(route: TargetRoute, tuning: BehaviorTuning): number {
  if (
    route.playerArrivalStep === undefined ||
    route.playerArrivalStep > MOVES_PER_ROUND
  ) {
    return 1;
  }

  if (tuning.behavior === "aggressive") {
    return 1.25;
  }

  return tuning.riskTaking ? 1.12 : 1;
}

function createTargetRoute(
  board: BoardState,
  from: TilePosition,
  pickup: Pickup,
  queuedMoves: number,
  playerPlan: PlayerPlan | undefined,
  tuning: BehaviorTuning,
  random: RandomSource,
): TargetRoute | undefined {
  const path = findShortestPath(
    board,
    from,
    pickup.tile,
    queuedMoves,
    playerPlan,
    tuning,
    random,
  );

  if (!path) {
    return undefined;
  }

  const collisionRisk = estimateCollisionRisk(
    from,
    path,
    queuedMoves,
    playerPlan,
  );
  const playerArrivalStep = getPlayerArrivalStep(playerPlan, pickup);

  return {
    pickup,
    path,
    collisionRisk,
    playerArrivalStep,
    score: scoreTargetRoute(
      pickup,
      path,
      queuedMoves,
      collisionRisk,
      playerArrivalStep,
      tuning,
    ),
  };
}

function scoreTargetRoute(
  pickup: Pickup,
  path: Move[],
  queuedMoves: number,
  collisionRisk: number,
  playerArrivalStep: number | undefined,
  tuning: BehaviorTuning,
): number {
  const distance = path.length;
  const remainingMoves = MOVES_PER_ROUND - queuedMoves;
  const rivalArrivalStep = queuedMoves + distance;
  let score =
    pickup.value * tuning.valueWeight -
    distance * tuning.distancePenalty -
    Math.max(0, distance - remainingMoves) * 2.5;

  if (pickup.value === HIGH_PICKUP_VALUE) {
    score += tuning.highValueBonus;
  }

  if (distance <= remainingMoves) {
    score += pickup.value * 1.25;
  }

  if (playerArrivalStep !== undefined) {
    const playerAdvantage = rivalArrivalStep - playerArrivalStep;

    if (isContestablePlayerTarget(playerAdvantage, playerArrivalStep, tuning)) {
      score += pickup.value * tuning.contestBonus;
    }

    if (playerAdvantage >= 2) {
      score -=
        playerAdvantage *
        (pickup.value === HIGH_PICKUP_VALUE
          ? tuning.latePenalty
          : tuning.latePenalty * 1.45);
    } else if (playerAdvantage <= -1) {
      score += Math.min(3, Math.abs(playerAdvantage)) * tuning.earlyBonus;
    }
  }

  score -=
    collisionRisk *
    (pickup.value === HIGH_PICKUP_VALUE
      ? tuning.collisionPenalty * 0.65
      : tuning.collisionPenalty);
  score -= Math.max(0, collisionRisk - 1) * tuning.repeatedCollisionPenalty;

  return score;
}

function isContestablePlayerTarget(
  playerAdvantage: number,
  playerArrivalStep: number,
  tuning: BehaviorTuning,
): boolean {
  if (playerArrivalStep > MOVES_PER_ROUND) {
    return false;
  }

  const contestWindow = tuning.riskTaking ? 2 : 1;

  if (tuning.behavior === "aggressive") {
    return playerAdvantage >= -1 && playerAdvantage <= contestWindow + 1;
  }

  return playerAdvantage >= -1 && playerAdvantage <= contestWindow;
}

function getPlayerArrivalStep(
  playerPlan: PlayerPlan | undefined,
  pickup: Pickup,
): number | undefined {
  const plannedArrival = playerPlan?.pickupArrivalSteps.get(pickup.id);

  if (plannedArrival !== undefined) {
    return plannedArrival;
  }

  return playerPlan?.shortestPickupDistances.get(pickup.id);
}

function findShortestPath(
  board: BoardState,
  from: TilePosition,
  target: TilePosition,
  startStep: number,
  playerPlan?: PlayerPlan,
  tuning?: BehaviorTuning,
  random?: RandomSource,
): Move[] | undefined {
  if (sameTile(from, target)) {
    return [];
  }

  const visited = new Set<string>([tileKey(from)]);
  const frontier: Array<{ tile: TilePosition; path: Move[] }> = [
    { tile: copyTile(from), path: [] },
  ];

  for (let index = 0; index < frontier.length; index += 1) {
    const node = frontier[index];
    const nextStep = startStep + node.path.length + 1;
    const options = getValidMoveOptions(board, node.tile)
      .map((option) => ({
        ...option,
        score: scorePathOption(
          node.tile,
          option.tile,
          target,
          nextStep,
          playerPlan,
          tuning,
        ) + (random ? random() * 0.12 : 0),
      }))
      .sort((a, b) => b.score - a.score);

    for (const option of options) {
      const optionKey = tileKey(option.tile);

      if (visited.has(optionKey)) {
        continue;
      }

      const path = [...node.path, option.move];

      if (sameTile(option.tile, target)) {
        return path;
      }

      visited.add(optionKey);
      frontier.push({ tile: option.tile, path });
    }
  }

  return undefined;
}

function scorePathOption(
  from: TilePosition,
  to: TilePosition,
  target: TilePosition,
  step: number,
  playerPlan: PlayerPlan | undefined,
  tuning: BehaviorTuning | undefined,
): number {
  let score = -manhattanDistance(to, target) * 2;

  if (hasPredictedCollision(from, to, step, playerPlan)) {
    score -= tuning?.pathCollisionBias ?? 8;
  }

  return score;
}

function chooseRouteMove(
  board: BoardState,
  from: TilePosition,
  route: TargetRoute,
  previousTile: TilePosition | undefined,
  queuedMoves: number,
  playerPlan: PlayerPlan | undefined,
  tuning: BehaviorTuning,
  random: RandomSource,
): Move {
  const plannedMove = route.path[0] ?? "wait";

  if (
    plannedMove === "wait" ||
    route.path.length <= 1 ||
    random() > tuning.detourChance
  ) {
    return plannedMove;
  }

  const options = getValidMoveOptions(board, from)
    .filter((option) => option.move !== plannedMove)
    .map((option) => ({
      ...option,
      score: scoreRouteStepOption(
        from,
        option.tile,
        route.pickup.tile,
        previousTile,
        queuedMoves,
        playerPlan,
        tuning,
      ),
    }));

  if (options.length === 0) {
    return plannedMove;
  }

  const plannedTile = validDestination(board, from, plannedMove);
  const plannedScore = scoreRouteStepOption(
    from,
    plannedTile,
    route.pickup.tile,
    previousTile,
    queuedMoves,
    playerPlan,
    tuning,
  );
  const allowableSlip = tuning.riskTaking ? 2.2 : 1.2;
  const candidates = options.filter(
    (option) => option.score >= plannedScore - allowableSlip,
  );

  if (candidates.length === 0) {
    return plannedMove;
  }

  return chooseWeightedMove(candidates, tuning.fallbackTemperature, random);
}

function scoreRouteStepOption(
  from: TilePosition,
  to: TilePosition,
  target: TilePosition,
  previousTile: TilePosition | undefined,
  queuedMoves: number,
  playerPlan: PlayerPlan | undefined,
  tuning: BehaviorTuning,
): number {
  let score = -manhattanDistance(to, target) * 2;

  if (previousTile && sameTile(to, previousTile)) {
    score -= 1.6;
  }

  if (hasPredictedCollision(from, to, queuedMoves + 1, playerPlan)) {
    score -= tuning.pathCollisionBias;
  }

  return score;
}

function chooseFallbackMove(
  board: BoardState,
  from: TilePosition,
  pickups: Pickup[],
  previousTile: TilePosition | undefined,
  queuedMoves: number,
  playerPlan: PlayerPlan | undefined,
  tuning: BehaviorTuning,
  random: RandomSource,
): Move {
  const options = getValidMoveOptions(board, from);

  if (options.length === 0) {
    return "wait";
  }

  const scoredOptions = options.map((option) => ({
    ...option,
    score: scoreFallbackMove(
      from,
      option.tile,
      pickups,
      previousTile,
      queuedMoves,
      playerPlan,
      tuning,
    ),
  }));

  return chooseWeightedMove(scoredOptions, tuning.fallbackTemperature, random);
}

function scoreFallbackMove(
  from: TilePosition,
  to: TilePosition,
  pickups: Pickup[],
  previousTile: TilePosition | undefined,
  queuedMoves: number,
  playerPlan: PlayerPlan | undefined,
  tuning: BehaviorTuning,
): number {
  const nearestPickupDistance =
    pickups.length > 0
      ? Math.min(...pickups.map((pickup) => manhattanDistance(to, pickup.tile)))
      : 0;
  let score = -nearestPickupDistance;

  if (previousTile && sameTile(to, previousTile)) {
    score -= 1.5;
  }

  if (hasPredictedCollision(from, to, queuedMoves + 1, playerPlan)) {
    score -= tuning.collisionPenalty + tuning.repeatedCollisionPenalty * 0.5;
  }

  return score;
}

function chooseWeightedMove<T extends { move: Move; score: number }>(
  options: T[],
  temperature: number,
  random: RandomSource,
): Move {
  const sortedOptions = options
    .slice()
    .sort((a, b) => b.score - a.score);
  const bestOption = sortedOptions[0];
  const candidates = sortedOptions.filter(
    (option) => bestOption.score - option.score <= 6,
  );
  const bestScore = bestOption.score;
  const choice = chooseWeighted(
    candidates.map((option) => ({
      item: option,
      weight: Math.exp((option.score - bestScore) / temperature),
    })),
    random,
  );

  return (choice ?? bestOption).move;
}

function chooseWeighted<T>(
  options: Array<WeightedOption<T>>,
  random: RandomSource,
): T | undefined {
  const totalWeight = options.reduce(
    (total, option) => total + Math.max(0, option.weight),
    0,
  );

  if (totalWeight <= 0) {
    return undefined;
  }

  let roll = random() * totalWeight;

  for (const option of options) {
    roll -= Math.max(0, option.weight);

    if (roll <= 0) {
      return option.item;
    }
  }

  return options[options.length - 1]?.item;
}

function getValidMoveOptions(board: BoardState, from: TilePosition): MoveOption[] {
  return MOVES.filter((move) => move !== "wait")
    .map((move) => ({
      move,
      tile: moveTile(from, move),
    }))
    .filter(({ tile }) => canEnterTile(board, tile));
}

function estimateCollisionRisk(
  from: TilePosition,
  path: Move[],
  startStep: number,
  playerPlan: PlayerPlan | undefined,
): number {
  let currentTile = copyTile(from);
  let risk = 0;

  for (let index = 0; index < path.length; index += 1) {
    const nextTile = moveTile(currentTile, path[index]);
    const step = startStep + index + 1;

    if (hasPredictedCollision(currentTile, nextTile, step, playerPlan)) {
      risk += index === 0 ? 2 : 1;
    }

    currentTile = nextTile;
  }

  return risk;
}

function hasPredictedCollision(
  rivalFrom: TilePosition,
  rivalTo: TilePosition,
  step: number,
  playerPlan: PlayerPlan | undefined,
): boolean {
  const playerFrom = getPredictedPlayerTile(playerPlan, step - 1);
  const playerTo = getPredictedPlayerTile(playerPlan, step);

  if (!playerFrom || !playerTo) {
    return false;
  }

  return (
    sameTile(rivalTo, playerTo) ||
    (sameTile(rivalFrom, playerTo) && sameTile(rivalTo, playerFrom))
  );
}

function getPredictedPlayerTile(
  playerPlan: PlayerPlan | undefined,
  step: number,
): TilePosition | undefined {
  if (!playerPlan || step < 0) {
    return undefined;
  }

  return playerPlan.tiles[Math.min(step, playerPlan.tiles.length - 1)];
}

function createPlayerPlan(
  board: BoardState,
  playerTile: TilePosition | undefined,
  pickups: Pickup[],
): PlayerPlan | undefined {
  if (!playerTile) {
    return undefined;
  }

  const playerQueue = predictPlayerQueue(board, playerTile, pickups);

  const tiles = [copyTile(playerTile)];
  const pickupArrivalSteps = new Map<string, number>();
  const shortestPickupDistances = new Map<string, number>();
  let currentTile = copyTile(playerTile);

  for (let index = 0; index < MOVES_PER_ROUND; index += 1) {
    currentTile = validDestination(board, currentTile, playerQueue[index] ?? "wait");
    tiles.push(copyTile(currentTile));

    for (const pickup of pickups) {
      if (
        !pickupArrivalSteps.has(pickup.id) &&
        sameTile(currentTile, pickup.tile)
      ) {
        pickupArrivalSteps.set(pickup.id, index + 1);
      }
    }
  }

  for (const pickup of pickups) {
    const path = findShortestPath(board, playerTile, pickup.tile, 0);

    if (path) {
      shortestPickupDistances.set(pickup.id, path.length);
    }
  }

  return {
    tiles,
    pickupArrivalSteps,
    shortestPickupDistances,
  };
}

// The rival cannot see the player's committed queue, so it assumes the player
// heads for the pickup that looks best from the public board: highest value
// per step, nearest first.
function predictPlayerQueue(
  board: BoardState,
  playerTile: TilePosition,
  pickups: Pickup[],
): Move[] {
  let bestPath: Move[] = [];
  let bestRatio = 0;

  for (const pickup of pickups) {
    const path = findShortestPath(board, playerTile, pickup.tile, 0);

    if (!path || path.length === 0) {
      continue;
    }

    const ratio = pickup.value / path.length;

    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestPath = path;
    }
  }

  return bestPath;
}

function createPlanningRandomSource(
  board: BoardState,
  startTile: TilePosition,
  pickups: Pickup[],
  context: RivalPlanningContext,
): RandomSource {
  const pickupSignature = pickups
    .map((pickup) => `${pickup.id}:${pickup.value}:${tileKey(pickup.tile)}`)
    .sort()
    .join("|");
  const blockerSignature = board.blockers.map(tileKey).sort().join("|");
  let seed = 2166136261;

  seed = hashString(seed, `size:${board.size}`);
  seed = hashString(seed, `start:${tileKey(startTile)}`);
  seed = hashString(seed, `blockers:${blockerSignature}`);
  seed = hashString(seed, `pickups:${pickupSignature}`);
  seed = hashString(
    seed,
    `player:${context.playerTile ? tileKey(context.playerTile) : "none"}`,
  );
  seed = hashString(seed, `seed:${context.seed ?? 0}`);
  seed = hashString(seed, `priority:${context.priorityOwner ?? "none"}`);

  return createRandomSource(seed);
}

function createRandomSource(seed: number): RandomSource {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(seed: number, value: string): number {
  let hash = seed >>> 0;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function validDestination(
  board: BoardState,
  from: TilePosition,
  move: Move,
): TilePosition {
  const target = moveTile(from, move);
  return canEnterTile(board, target) ? target : copyTile(from);
}

function removePickupAt(pickups: Pickup[], tile: TilePosition): void {
  const pickupIndex = pickups.findIndex((pickup) => sameTile(pickup.tile, tile));

  if (pickupIndex !== -1) {
    pickups.splice(pickupIndex, 1);
  }
}

function copyPickup(pickup: Pickup): Pickup {
  return {
    ...pickup,
    tile: copyTile(pickup.tile),
  };
}
