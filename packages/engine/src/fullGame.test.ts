import { describe, it, expect } from 'vitest';
import type { GameState } from '@azul/shared';
import {
  createGame,
  autoMove,
  applyMove,
  isOfferPhaseOver,
  resolveTiling,
  isGameOver,
  startNextRound,
  finalizeScores,
} from './index.js';

function totalTiles(state: GameState): number {
  let n = state.bag.length + state.discard.length + state.center.length;
  for (const f of state.factories) n += f.length;
  for (const p of state.players) {
    for (const line of p.board.patternLines) n += line.filter((c) => c !== null).length;
    for (const row of p.board.wall) n += row.filter((c) => c !== null).length;
    n += p.board.floor.filter((s) => s !== 'FIRST').length;
  }
  return n;
}

/** Play a full deterministic game to completion using autoMove. */
function playFullGame(seed: number, playerCount: number): { state: GameState; rounds: number } {
  const infos = Array.from({ length: playerCount }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
  let state = createGame(infos, seed);
  let rounds = 0;
  const MAX_ROUNDS = 200;

  while (state.phase !== 'finished' && rounds < MAX_ROUNDS) {
    // offer phase
    while (!isOfferPhaseOver(state)) {
      state = applyMove(state, autoMove(state));
      expect(totalTiles(state)).toBe(100);
      for (const p of state.players) expect(p.board.score).toBeGreaterThanOrEqual(0);
    }
    // tiling phase
    state = resolveTiling(state);
    expect(totalTiles(state)).toBe(100);
    for (const p of state.players) expect(p.board.score).toBeGreaterThanOrEqual(0);

    if (isGameOver(state)) {
      state = finalizeScores(state);
    } else {
      state = startNextRound(state);
    }
    rounds++;
  }
  return { state, rounds };
}

describe('full game (engine integration)', () => {
  it.each([
    [1, 2],
    [42, 3],
    [7, 4],
    [99, 2],
  ])('conserves 100 tiles throughout and terminates with a winner (seed %i, %i players)', (seed, players) => {
    const { state, rounds } = playFullGame(seed, players);
    expect(state.phase).toBe('finished');
    expect(rounds).toBeLessThan(200);
    expect(totalTiles(state)).toBe(100);
    expect(state.winnerIds).not.toBeNull();
    expect(state.winnerIds!.length).toBeGreaterThanOrEqual(1);

    // the winner has the maximum score
    const maxScore = Math.max(...state.players.map((p) => p.board.score));
    for (const id of state.winnerIds!) {
      expect(state.players.find((p) => p.id === id)!.board.score).toBe(maxScore);
    }
  });
});
