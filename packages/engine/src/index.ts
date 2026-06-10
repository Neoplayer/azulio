import {
  COLORS,
  TILES_PER_COLOR,
  TILES_PER_FACTORY,
  FACTORY_COUNT_BY_PLAYERS,
} from '@azul/shared';
import type { Color, GameState, PlayerBoard, PlayerSlot } from '@azul/shared';
import { makeRng, shuffle } from './rng.js';

export { isLegalMove, legalMoves, applyMove, wallColumnForColor } from './moves.js';
export { isOfferPhaseOver, resolveTiling, scorePlacement } from './tiling.js';
export { isGameOver, startNextRound } from './nextRound.js';
export { finalizeScores, autoMove, toPlayerView } from './finalize.js';

export interface PlayerInfo {
  id: string;
  name: string;
}

function makeFullBag(): Color[] {
  const bag: Color[] = [];
  for (const color of COLORS) {
    for (let i = 0; i < TILES_PER_COLOR; i++) bag.push(color);
  }
  return bag;
}

function emptyBoard(): PlayerBoard {
  const patternLines: (Color | null)[][] = [];
  for (let cap = 1; cap <= 5; cap++) {
    patternLines.push(new Array<Color | null>(cap).fill(null));
  }
  const wall: (Color | null)[][] = [];
  for (let r = 0; r < 5; r++) {
    wall.push(new Array<Color | null>(5).fill(null));
  }
  return { patternLines, wall, floor: [], score: 0 };
}

export function createGame(playerInfos: PlayerInfo[], seed: number): GameState {
  const factoryCount = FACTORY_COUNT_BY_PLAYERS[playerInfos.length];
  if (factoryCount === undefined) {
    throw new Error(`Unsupported player count: ${playerInfos.length} (expected 2-4)`);
  }

  const rng = makeRng(seed);
  const bag = shuffle(makeFullBag(), rng);

  const factories: Color[][] = [];
  for (let f = 0; f < factoryCount; f++) {
    factories.push(bag.splice(0, TILES_PER_FACTORY));
  }

  const players: PlayerSlot[] = playerInfos.map((p) => ({
    id: p.id,
    name: p.name,
    board: emptyBoard(),
  }));

  return {
    players,
    factories,
    center: [],
    centerHasFirstToken: true,
    bag,
    discard: [],
    currentPlayerIndex: 0,
    firstPlayerIndex: 0,
    phase: 'offer',
    round: 1,
    winnerIds: null,
    rngSeed: seed,
    turnSeq: 0,
  };
}
