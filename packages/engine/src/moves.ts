import { WALL_PATTERN, FLOOR_PENALTIES } from '@azul/shared';
import type { Color, GameState, Move, PlayerBoard } from '@azul/shared';

const FLOOR_CAPACITY = FLOOR_PENALTIES.length;

/** Column index on the wall where `color` lives in `row` (canonical pattern). */
export function wallColumnForColor(row: number, color: Color): number {
  return WALL_PATTERN[row]!.indexOf(color);
}

/** True if `color` is already tiled on the wall in `row`. */
function wallHasColorInRow(board: PlayerBoard, row: number, color: Color): boolean {
  const col = wallColumnForColor(row, color);
  return board.wall[row]![col] !== null;
}

function tilesInSource(state: GameState, source: Move['source'], color: Color): number {
  const pool = source.type === 'factory' ? state.factories[source.index] : state.center;
  if (!pool) return 0;
  return pool.filter((c) => c === color).length;
}

export function isLegalMove(state: GameState, move: Move): boolean {
  if (state.phase !== 'offer') return false;

  if (move.source.type === 'factory') {
    if (move.source.index < 0 || move.source.index >= state.factories.length) return false;
  }
  if (tilesInSource(state, move.source, move.color) === 0) return false;

  if (move.target.type === 'floor') return true;

  const row = move.target.row;
  if (row < 0 || row > 4) return false;

  const board = state.players[state.currentPlayerIndex]!.board;
  const line = board.patternLines[row]!;

  // line must have a free slot
  if (line.every((c) => c !== null)) return false;
  // line must be empty or already hold this colour
  const existing = line.find((c) => c !== null);
  if (existing !== undefined && existing !== move.color) return false;
  // colour must not be tiled on the wall in this row already
  if (wallHasColorInRow(board, row, move.color)) return false;

  return true;
}

export function legalMoves(state: GameState): Move[] {
  if (state.phase !== 'offer') return [];
  const moves: Move[] = [];
  const sources: Move['source'][] = state.factories.map((_, index) => ({
    type: 'factory' as const,
    index,
  }));
  sources.push({ type: 'center' });

  const colors: Color[] = ['blue', 'yellow', 'red', 'black', 'white'];
  for (const source of sources) {
    for (const color of colors) {
      if (tilesInSource(state, source, color) === 0) continue;
      for (let row = 0; row < 5; row++) {
        const m: Move = { source, color, target: { type: 'patternLine', row } };
        if (isLegalMove(state, m)) moves.push(m);
      }
      moves.push({ source, color, target: { type: 'floor' } });
    }
  }
  return moves;
}

/** Push tiles onto the floor, capping at 7 slots; excess colour tiles go to discard. */
function pushToFloor(board: PlayerBoard, tiles: (Color | 'FIRST')[], discard: Color[]): void {
  for (const t of tiles) {
    if (board.floor.length < FLOOR_CAPACITY) {
      board.floor.push(t);
    } else if (t !== 'FIRST') {
      discard.push(t);
    }
  }
}

export function applyMove(state: GameState, move: Move): GameState {
  if (!isLegalMove(state, move)) {
    throw new Error(`Illegal move: ${JSON.stringify(move)}`);
  }

  const next: GameState = structuredClone(state);
  const board = next.players[next.currentPlayerIndex]!.board;

  // 1. Collect taken tiles and route leftovers.
  let taken = 0;
  if (move.source.type === 'factory') {
    const factory = next.factories[move.source.index]!;
    taken = factory.filter((c) => c === move.color).length;
    const leftovers = factory.filter((c) => c !== move.color);
    next.center.push(...leftovers);
    next.factories[move.source.index] = [];
  } else {
    taken = next.center.filter((c) => c === move.color).length;
    next.center = next.center.filter((c) => c !== move.color);
    if (next.centerHasFirstToken) {
      next.centerHasFirstToken = false;
      next.firstPlayerIndex = next.currentPlayerIndex;
      pushToFloor(board, ['FIRST'], next.discard);
    }
  }

  // 2. Place taken tiles.
  if (move.target.type === 'floor') {
    pushToFloor(board, new Array<Color>(taken).fill(move.color), next.discard);
  } else {
    const line = board.patternLines[move.target.row]!;
    let placed = 0;
    for (let i = 0; i < line.length && placed < taken; i++) {
      if (line[i] === null) {
        line[i] = move.color;
        placed++;
      }
    }
    const overflow = taken - placed;
    if (overflow > 0) {
      pushToFloor(board, new Array<Color>(overflow).fill(move.color), next.discard);
    }
  }

  // 3. Advance turn.
  next.currentPlayerIndex = (next.currentPlayerIndex + 1) % next.players.length;
  next.turnSeq += 1;
  return next;
}
