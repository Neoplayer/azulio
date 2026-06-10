import { COLORS } from '@azul/shared';
import type { GameState } from '@azul/shared';
import { resolveTiling } from '../tiling.js';
import type { BotConfig } from './types.js';

// ---------------------------------------------------------------------------
// Tunable weight constants — adjust here to change bot evaluation priorities.
// ---------------------------------------------------------------------------

/** Weight applied to the score delta after simulating end-of-round tiling.
 *  Captures adjacency points gained minus floor penalties for this player. */
const W_SCORE_DELTA = 1;

/** Bonus per short pattern line (capacity ≤ 2) that is already full and will
 *  tile this round — short lines complete faster and score reliably. */
const W_SHORT_COMPLETE = 3;

/** Bonus per medium pattern line (capacity 3) that is already full. */
const W_MID_COMPLETE = 2;

/** Bonus per long pattern line (capacity ≥ 4) that is already full. */
const W_LONG_COMPLETE = 1;

/** Penalty per unfilled slot in a long (capacity ≥ 4) pattern line that is
 *  less than half-filled — unlikely to complete this round. */
const W_LONG_PARTIAL_PENALTY = -0.3;

/** Extra penalty per tile currently sitting on the floor (beyond what
 *  resolveTiling already deducts), to more aggressively avoid floor dumps. */
const W_FLOOR_TILE = -0.5;

/** Projected end-game bonus weights (mirrors finalizeScores constants). */
const W_ENDGAME_ROW = 2;
const W_ENDGAME_COL = 7;
const W_ENDGAME_COLOR = 10;

// ---------------------------------------------------------------------------

/**
 * Heuristic evaluation of `state` from the perspective of `playerIndex`.
 *
 * A higher value means the state is more favourable for that player.
 * Designed to be called on the state *after* applyMove so the board already
 * reflects the candidate move's effects.
 */
export function evaluate(state: GameState, playerIndex: number, config: BotConfig): number {
  const player = state.players[playerIndex]!;
  const board = player.board;
  const scoreBeforeTiling = board.score;

  // ── Feature 1: round-end score delta ────────────────────────────────────
  // Simulate tiling on a clone to get the accurate end-of-round delta,
  // including adjacency points and floor-line penalties.
  const resolved = resolveTiling(structuredClone(state));
  const scoreDelta = resolved.players[playerIndex]!.board.score - scoreBeforeTiling;

  // ── Feature 2: pattern line completion value ─────────────────────────────
  // Reward lines that are already full (will tile next) and penalise long
  // lines that are only partially filled (low probability of completing).
  let lineValue = 0;
  for (let row = 0; row < 5; row++) {
    const line = board.patternLines[row]!;
    const capacity = row + 1; // row 0 → cap 1, row 4 → cap 5
    const filled = line.filter((c) => c !== null).length;
    if (filled === 0) continue;

    if (filled === capacity) {
      // Line will tile at end of round
      if (capacity <= 2) lineValue += W_SHORT_COMPLETE;
      else if (capacity === 3) lineValue += W_MID_COMPLETE;
      else lineValue += W_LONG_COMPLETE;
    } else if (capacity >= 4 && filled < capacity / 2) {
      // Long line, less than half filled — penalise each empty slot
      lineValue += (capacity - filled) * W_LONG_PARTIAL_PENALTY;
    }
  }

  // ── Feature 3: floor tile penalty ───────────────────────────────────────
  // Apply extra weight to the raw count of floor tiles to reinforce avoidance
  // beyond what resolveTiling already deducts from the score.
  const floorPenalty = board.floor.length * W_FLOOR_TILE;

  let total = W_SCORE_DELTA * scoreDelta + lineValue + floorPenalty;

  // ── Feature 4: projected end-game bonuses ───────────────────────────────
  // When the config opts in, reward partial progress toward end-game bonuses.
  if (config.useEndgameBonuses) {
    const wall = board.wall;

    // Complete rows already on the wall
    const rows = wall.filter((r) => r.every((c) => c !== null)).length;

    // Complete columns already on the wall
    let cols = 0;
    for (let c = 0; c < 5; c++) {
      if (wall.every((r) => r[c] !== null)) cols++;
    }

    // Colors where all 5 instances are on the wall
    let colors = 0;
    for (const color of COLORS) {
      if (wall.flat().filter((c) => c === color).length === 5) colors++;
    }

    total += W_ENDGAME_ROW * rows + W_ENDGAME_COL * cols + W_ENDGAME_COLOR * colors;
  }

  return total;
}
