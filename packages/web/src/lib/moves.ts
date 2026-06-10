import type { Color, PlayerView, Move } from '@azul/shared';
import { WALL } from './azulejo';

/** The board belonging to the receiving player (`view.you`). */
export function myBoard(view: PlayerView) {
  return view.players.find((p) => p.id === view.you)?.board ?? null;
}

export function isMyTurn(view: PlayerView): boolean {
  return view.currentPlayerId === view.you && view.phase === 'offer';
}

/**
 * Pattern-line rows where the given colour may legally be placed, mirroring the
 * engine's isLegalMove rules (line free + empty-or-same-colour + not yet on the
 * wall in that row). Floor is always allowed and handled separately.
 */
export function legalRowsFor(view: PlayerView, color: Color): number[] {
  const board = myBoard(view);
  if (!board) return [];
  const rows: number[] = [];
  for (let r = 0; r < 5; r++) {
    const line = board.patternLines[r]!;
    if (line.every((c) => c !== null)) continue; // full
    const existing = line.find((c) => c !== null);
    if (existing !== undefined && existing !== color) continue;
    const col = WALL[r]!.indexOf(color);
    if (board.wall[r]![col] !== null) continue; // already tiled
    rows.push(r);
  }
  return rows;
}

/** How many tiles of `color` are available in the chosen source. */
export function countInSource(
  view: PlayerView,
  source: Move['source'],
  color: Color,
): number {
  const pool = source.type === 'factory' ? view.factories[source.index] : view.center;
  return (pool ?? []).filter((c) => c === color).length;
}
