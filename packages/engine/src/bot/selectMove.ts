import type { GameState, Move } from '@azul/shared';
import { legalMoves, applyMove } from '../moves.js';
import { evaluate } from './evaluate.js';
import { searchBestMove } from './search.js';
import type { BotConfig } from './types.js';

/** Number of top candidates to sample from when epsilon noise fires. */
const EPSILON_TOP_N = 3;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Floor cost (tiles that would land on the floor) for a candidate move. */
function floorCostForMove(state: GameState, move: Move, playerIndex: number): number {
  const pool =
    move.source.type === 'factory'
      ? state.factories[move.source.index]!
      : state.center;
  const taken = pool.filter((c) => c === move.color).length;
  const markerCost =
    move.source.type === 'center' && state.centerHasFirstToken ? 1 : 0;

  if (move.target.type === 'floor') return taken + markerCost;

  const line =
    state.players[playerIndex]!.board.patternLines[
      move.target.row
    ]!;
  const freeSlots = line.filter((c) => c === null).length;
  return Math.max(0, taken - freeSlots) + markerCost;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns all legal moves sorted best-first by greedy 1-ply evaluation.
 * Exported so task #2 (minimax) can reuse the list without re-computing scores.
 */
export function greedyBestMoves(
  state: GameState,
  playerIndex: number,
  config: BotConfig,
): Move[] {
  const moves = legalMoves(state);
  if (moves.length === 0) return [];

  const scored = moves.map((move) => ({
    move,
    score: evaluate(applyMove(state, move), playerIndex, config),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.move);
}

/**
 * Select a move for the bot at `playerIndex`.
 *
 * @param state       Current game state (phase must be 'offer').
 * @param playerIndex Index of the player whose turn it is.
 * @param config      Bot configuration (level, epsilon, flags …).
 * @param rng         Seeded random function — use `makeRng(seed)` for reproducibility.
 */
export function selectMove(
  state: GameState,
  playerIndex: number,
  config: BotConfig,
  rng: () => number,
): Move {
  const moves = legalMoves(state);
  if (moves.length === 0) {
    throw new Error('selectMove: no legal moves available');
  }

  // ── Easy: random, but prefer moves that don't spill to the floor ─────────
  if (config.level === 'easy') {
    const noFloor = moves.filter((m) => floorCostForMove(state, m, playerIndex) === 0);
    const pool = noFloor.length > 0 ? noFloor : moves;
    return pool[Math.floor(rng() * pool.length)]!;
  }

  // ── Medium / Hard: greedy ordering for epsilon noise ────────────────────
  const ranked = greedyBestMoves(state, playerIndex, config);

  // Epsilon noise: with probability epsilon pick uniformly from top-N candidates
  // so the bot occasionally plays sub-optimal moves (makes it less exploitable).
  const topN = ranked.slice(0, EPSILON_TOP_N);
  if (topN.length > 1 && rng() < config.epsilon) {
    return topN[Math.floor(rng() * topN.length)]!;
  }

  // Hard bot (searchDepth > 1): use alpha-beta minimax for the best move.
  if (config.searchDepth > 1) {
    return searchBestMove(state, playerIndex, config, rng);
  }

  // Medium bot: greedy best.
  return ranked[0]!;
}
