import { COLORS } from '@azul/shared';
import type { Color, GameState, PlayerId, PlayerView, Move } from '@azul/shared';
import { legalMoves } from './moves.js';

function completeRows(wall: (Color | null)[][]): number {
  return wall.filter((row) => row.every((c) => c !== null)).length;
}

function completeCols(wall: (Color | null)[][]): number {
  let n = 0;
  for (let c = 0; c < 5; c++) {
    if (wall.every((row) => row[c] !== null)) n++;
  }
  return n;
}

function completeColors(wall: (Color | null)[][]): number {
  let n = 0;
  for (const color of COLORS) {
    let count = 0;
    for (const row of wall) {
      if (row.includes(color)) count++;
    }
    if (count === 5) n++;
  }
  return n;
}

/** Add end-of-game bonuses, set the winner(s) with tie-breaks, mark finished. */
export function finalizeScores(state: GameState): GameState {
  const next: GameState = structuredClone(state);

  for (const player of next.players) {
    const wall = player.board.wall;
    player.board.score +=
      completeRows(wall) * 2 + completeCols(wall) * 7 + completeColors(wall) * 10;
  }

  const maxScore = Math.max(...next.players.map((p) => p.board.score));
  const topScorers = next.players.filter((p) => p.board.score === maxScore);

  let winners: PlayerId[];
  if (topScorers.length === 1) {
    winners = [topScorers[0]!.id];
  } else {
    const maxRows = Math.max(...topScorers.map((p) => completeRows(p.board.wall)));
    winners = topScorers
      .filter((p) => completeRows(p.board.wall) === maxRows)
      .map((p) => p.id);
  }

  next.winnerIds = winners;
  next.phase = 'finished';
  return next;
}

/** Floor cost (tiles that would end on the floor) for a candidate move. */
function floorCost(state: GameState, move: Move): number {
  const pool = move.source.type === 'factory' ? state.factories[move.source.index]! : state.center;
  const taken = pool.filter((c) => c === move.color).length;
  const markerCost = move.source.type === 'center' && state.centerHasFirstToken ? 1 : 0;

  if (move.target.type === 'floor') return taken + markerCost;

  const line = state.players[state.currentPlayerIndex]!.board.patternLines[move.target.row]!;
  const freeSlots = line.filter((c) => c === null).length;
  return Math.max(0, taken - freeSlots) + markerCost;
}

function sourceRank(state: GameState, move: Move): number {
  return move.source.type === 'factory' ? move.source.index : state.factories.length;
}

function targetRank(move: Move): number {
  return move.target.type === 'patternLine' ? move.target.row : 5;
}

/**
 * Deterministic timeout move: minimise floor cost, then break ties by
 * source index, colour order, and target row (floor last).
 */
export function autoMove(state: GameState): Move {
  const candidates = legalMoves(state);
  if (candidates.length === 0) {
    throw new Error('autoMove called with no legal moves');
  }
  let best = candidates[0]!;
  let bestKey = rankKey(state, best);
  for (const m of candidates.slice(1)) {
    const key = rankKey(state, m);
    if (compareKeys(key, bestKey) < 0) {
      best = m;
      bestKey = key;
    }
  }
  return best;
}

type RankKey = [number, number, number, number];

function rankKey(state: GameState, move: Move): RankKey {
  return [floorCost(state, move), sourceRank(state, move), COLORS.indexOf(move.color), targetRank(move)];
}

function compareKeys(a: RankKey, b: RankKey): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return 0;
}

/**
 * Build the redacted public view for `playerId`. The bag composition is hidden
 * (only `bagCount` is exposed). `connectedIds`, when given, marks which players
 * are currently connected; everyone defaults to connected.
 */
export function toPlayerView(
  state: GameState,
  playerId: PlayerId,
  connectedIds?: ReadonlySet<PlayerId>,
): PlayerView {
  return {
    players: state.players.map((p) => ({
      ...structuredClone(p),
      connected: connectedIds ? connectedIds.has(p.id) : true,
    })),
    factories: structuredClone(state.factories),
    center: [...state.center],
    centerHasFirstToken: state.centerHasFirstToken,
    bagCount: state.bag.length,
    discard: [...state.discard],
    currentPlayerId: state.players[state.currentPlayerIndex]!.id,
    firstPlayerId: state.players[state.firstPlayerIndex]!.id,
    phase: state.phase,
    round: state.round,
    turnSeq: state.turnSeq,
    you: playerId,
    winnerIds: state.winnerIds,
  };
}
