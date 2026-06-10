import type { GameState, Move } from '@azul/shared';
import { applyMove } from '../moves.js';
import { isOfferPhaseOver, resolveTiling } from '../tiling.js';
import { evaluate } from './evaluate.js';
import { greedyBestMoves } from './selectMove.js';
import type { BotConfig } from './types.js';

/**
 * Maximum candidate moves explored at each ply.
 * Moves are already ordered best-first by greedyBestMoves, so trimming here
 * loses little quality while keeping the tree manageable.
 */
const BRANCH_CAP = 12;

/**
 * Recursive alpha-beta minimax.
 *
 * Strategy (paranoid / 2-player minimax):
 *   - The node owned by `botPlayerIndex` maximises evaluate(…, botPlayerIndex).
 *   - Every other node minimises that same value.
 *
 * This is exact for 2 players; for >2 it is a conservative "paranoid"
 * approximation — all opponents gang up against the bot.  Correct and simple.
 *
 * Round-boundary rule: when a move causes isOfferPhaseOver to become true we
 * do NOT recurse into the next round (which requires bag draws and introduces
 * stochastic information).  Instead we apply resolveTiling to the resulting
 * state and return evaluate() of that snapshot as the leaf value.  state.bag
 * is never read during search.
 */
function alphabeta(
  state: GameState,
  depth: number,
  alpha: number,
  beta: number,
  botPlayerIndex: number,
  config: BotConfig,
): number {
  if (depth === 0) {
    return evaluate(state, botPlayerIndex, config);
  }

  const candidates = greedyBestMoves(state, state.currentPlayerIndex, config)
    .slice(0, BRANCH_CAP);

  if (candidates.length === 0) {
    return evaluate(state, botPlayerIndex, config);
  }

  const maximising = state.currentPlayerIndex === botPlayerIndex;

  if (maximising) {
    let value = -Infinity;
    for (const move of candidates) {
      const next = applyMove(state, move);
      const child = isOfferPhaseOver(next)
        ? evaluate(resolveTiling(next), botPlayerIndex, config)
        : alphabeta(next, depth - 1, alpha, beta, botPlayerIndex, config);
      if (child > value) value = child;
      if (value > alpha) alpha = value;
      if (alpha >= beta) break; // β-cutoff
    }
    return value;
  } else {
    let value = +Infinity;
    for (const move of candidates) {
      const next = applyMove(state, move);
      const child = isOfferPhaseOver(next)
        ? evaluate(resolveTiling(next), botPlayerIndex, config)
        : alphabeta(next, depth - 1, alpha, beta, botPlayerIndex, config);
      if (child < value) value = child;
      if (value < beta) beta = value;
      if (alpha >= beta) break; // α-cutoff
    }
    return value;
  }
}

/**
 * Select the best move for `playerIndex` using alpha-beta minimax to
 * depth `config.searchDepth`.
 *
 * The `rng` parameter is kept for API symmetry with `selectMove` but is not
 * used — search is fully deterministic given (state, config).
 */
export function searchBestMove(
  state: GameState,
  playerIndex: number,
  config: BotConfig,
  _rng: () => number,
): Move {
  const candidates = greedyBestMoves(state, playerIndex, config).slice(0, BRANCH_CAP);
  if (candidates.length === 0) {
    throw new Error('searchBestMove: no legal moves available');
  }
  if (candidates.length === 1) return candidates[0]!;

  let bestMove = candidates[0]!;
  let bestValue = -Infinity;
  let alpha = -Infinity;
  const beta = +Infinity;

  for (const move of candidates) {
    const next = applyMove(state, move);
    const value = isOfferPhaseOver(next)
      ? evaluate(resolveTiling(next), playerIndex, config)
      : alphabeta(next, config.searchDepth - 1, alpha, beta, playerIndex, config);
    if (value > bestValue) {
      bestValue = value;
      bestMove = move;
    }
    if (value > alpha) alpha = value;
  }

  return bestMove;
}
