import { FLOOR_PENALTIES } from '@azul/shared';
import type { Color, GameState, PlayerBoard } from '@azul/shared';
import { wallColumnForColor } from './moves.js';

export function isOfferPhaseOver(state: GameState): boolean {
  return state.factories.every((f) => f.length === 0) && state.center.length === 0;
}

/** Contiguous run length through (row,col) along a direction, including the cell itself. */
function runLength(
  wall: (Color | null)[][],
  row: number,
  col: number,
  dRow: number,
  dCol: number,
): number {
  let count = 1;
  for (let r = row + dRow, c = col + dCol; r >= 0 && r < 5 && c >= 0 && c < 5; r += dRow, c += dCol) {
    if (wall[r]![c] === null) break;
    count++;
  }
  return count;
}

/** Score for placing a tile at (row,col), per the Azul adjacency rule. */
export function scorePlacement(wall: (Color | null)[][], row: number, col: number): number {
  const h =
    runLength(wall, row, col, 0, -1) + runLength(wall, row, col, 0, 1) - 1;
  const v =
    runLength(wall, row, col, -1, 0) + runLength(wall, row, col, 1, 0) - 1;
  if (h === 1 && v === 1) return 1;
  return (h > 1 ? h : 0) + (v > 1 ? v : 0);
}

function floorPenalty(board: PlayerBoard): number {
  let total = 0;
  for (let i = 0; i < board.floor.length && i < FLOOR_PENALTIES.length; i++) {
    total += FLOOR_PENALTIES[i]!;
  }
  return total;
}

/**
 * Wall-tiling phase: for every player, tile completed pattern lines, score them,
 * apply floor penalties, clear floors, return the first-player marker to the
 * center. Pure: returns a new state.
 */
export function resolveTiling(state: GameState): GameState {
  const next: GameState = structuredClone(state);

  for (const player of next.players) {
    const board = player.board;

    for (let row = 0; row < 5; row++) {
      const line = board.patternLines[row]!;
      const isFull = line.every((c) => c !== null);
      if (!isFull) continue;

      const color = line[0] as Color;
      const col = wallColumnForColor(row, color);
      board.wall[row]![col] = color;
      board.score += scorePlacement(board.wall, row, col);

      // one tile to the wall, the rest of the line to discard
      for (let i = 1; i < line.length; i++) next.discard.push(color);
      board.patternLines[row] = new Array<Color | null>(line.length).fill(null);
    }

    // floor penalties (applied every round, including the last)
    board.score = Math.max(0, board.score + floorPenalty(board));

    // discard floor colour tiles, return the marker to the center
    for (const slot of board.floor) {
      if (slot === 'FIRST') {
        next.centerHasFirstToken = true;
      } else {
        next.discard.push(slot);
      }
    }
    board.floor = [];
  }

  return next;
}
