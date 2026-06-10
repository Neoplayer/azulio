import { FACTORY_COUNT_BY_PLAYERS, TILES_PER_FACTORY } from '@azul/shared';
import type { Color, GameState } from '@azul/shared';
import { makeRng, shuffle } from './rng.js';

export function isGameOver(state: GameState): boolean {
  return state.players.some((p) =>
    p.board.wall.some((row) => row.every((cell) => cell !== null)),
  );
}

/**
 * Draw one tile, refilling the bag from the discard (reshuffled) when empty.
 * Returns undefined when both bag and discard are exhausted.
 */
function drawTile(bag: Color[], discard: Color[], rng: () => number): Color | undefined {
  if (bag.length === 0) {
    if (discard.length === 0) return undefined;
    bag.push(...shuffle(discard, rng));
    discard.length = 0;
  }
  return bag.pop();
}

/**
 * Start the next round: refill factories from the bag (reshuffling the discard
 * when needed; partial fill if tiles run out), reset the center with the
 * first-player marker, and hand the turn to the round's first player.
 */
export function startNextRound(state: GameState): GameState {
  const next: GameState = structuredClone(state);
  const rng = makeRng(next.rngSeed + next.round * 1000);
  const factoryCount = FACTORY_COUNT_BY_PLAYERS[next.players.length]!;

  const factories: Color[][] = [];
  for (let f = 0; f < factoryCount; f++) {
    const factory: Color[] = [];
    for (let i = 0; i < TILES_PER_FACTORY; i++) {
      const tile = drawTile(next.bag, next.discard, rng);
      if (tile === undefined) break;
      factory.push(tile);
    }
    factories.push(factory);
  }

  next.factories = factories;
  next.center = [];
  next.centerHasFirstToken = true;
  next.currentPlayerIndex = next.firstPlayerIndex;
  next.round += 1;
  next.phase = 'offer';
  return next;
}
