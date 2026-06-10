import { describe, it, expect } from 'vitest';
import type { GameState } from '@azul/shared';
import {
  createGame,
  legalMoves,
  applyMove,
  isOfferPhaseOver,
  resolveTiling,
  isGameOver,
  finalizeScores,
  startNextRound,
} from '../index.js';
import { makeRng } from '../rng.js';
import { BOT_PRESETS, type BotConfig } from './types.js';
import { selectMove } from './selectMove.js';
import { searchBestMove } from './search.js';

// ---------------------------------------------------------------------------
// Game runner
// ---------------------------------------------------------------------------

interface GameResult {
  winnerIds: string[];
  scores: number[];
}

function runGame(configs: BotConfig[], gameSeed: number): GameResult {
  const playerInfos = configs.map((_, i) => ({ id: `player${i}`, name: `P${i}` }));
  let state: GameState = createGame(playerInfos, gameSeed);
  // Each player gets an independent seeded RNG derived from the game seed.
  const rngs = configs.map((_, i) => makeRng(gameSeed * 997 + i * 131));

  const MAX_TURNS = 600; // safety cap against infinite loops
  let turns = 0;

  while (turns < MAX_TURNS) {
    if (isOfferPhaseOver(state)) {
      state = resolveTiling(state);
      if (isGameOver(state)) {
        state = finalizeScores(state);
        break;
      }
      state = startNextRound(state);
      continue;
    }

    const legal = legalMoves(state);
    if (legal.length === 0) break;

    const pi = state.currentPlayerIndex;
    const move = selectMove(state, pi, configs[pi]!, rngs[pi]!);
    state = applyMove(state, move);
    turns++;
  }

  const winnerIds = state.winnerIds ?? [];
  const scores = state.players.map((p) => p.board.score);
  return { winnerIds, scores };
}

/** Win rate of player 0 vs player 1 over N games (0.5 for a draw). */
function winRate(
  config0: BotConfig,
  config1: BotConfig,
  games: number,
  baseSeed = 1,
): number {
  let points0 = 0;

  for (let g = 0; g < games; g++) {
    const { winnerIds } = runGame([config0, config1], baseSeed + g);
    const w0 = winnerIds.includes('player0');
    const w1 = winnerIds.includes('player1');
    if (w0 && !w1) points0 += 1;
    else if (w0 && w1) points0 += 0.5; // tie
  }

  return points0 / games;
}

// ---------------------------------------------------------------------------
// Tournament: Hard vs Medium
// ---------------------------------------------------------------------------

describe('tournament: Hard vs Medium', () => {
  it('Hard beats Medium in >60% of games (30 fixed-seed games)', () => {
    const rate = winRate(BOT_PRESETS.hard, BOT_PRESETS.medium, 30, 1000);
    expect(rate, `Hard win rate vs Medium = ${(rate * 100).toFixed(1)}%`).toBeGreaterThan(0.60);
  });
}, { timeout: 90_000 });

// ---------------------------------------------------------------------------
// Tournament: Medium vs Easy
// ---------------------------------------------------------------------------

describe('tournament: Medium vs Easy', () => {
  it('Medium beats Easy in >60% of games (30 fixed-seed games)', () => {
    const rate = winRate(BOT_PRESETS.medium, BOT_PRESETS.easy, 30, 2000);
    expect(rate, `Medium win rate vs Easy = ${(rate * 100).toFixed(1)}%`).toBeGreaterThan(0.60);
  });
}, { timeout: 60_000 });

// ---------------------------------------------------------------------------
// Performance: one hard move must complete under 1000 ms
// ---------------------------------------------------------------------------

describe('searchBestMove — performance', () => {
  it('one hard move on a fresh 4-player mid-round state completes < 1000 ms', () => {
    const state = createGame(
      [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
        { id: 'c', name: 'C' },
        { id: 'd', name: 'D' },
      ],
      42,
    );
    // Advance a few moves so factories are partially depleted (mid-round).
    let s = state;
    const rng = makeRng(77);
    for (let i = 0; i < 8; i++) {
      const legal = legalMoves(s);
      if (legal.length === 0) break;
      s = applyMove(s, legal[Math.floor(rng() * legal.length)]!);
    }

    const start = performance.now();
    searchBestMove(s, s.currentPlayerIndex, BOT_PRESETS.hard, makeRng(0));
    const elapsed = performance.now() - start;

    expect(elapsed, `Hard move took ${elapsed.toFixed(0)} ms`).toBeLessThan(1000);
  });
});
