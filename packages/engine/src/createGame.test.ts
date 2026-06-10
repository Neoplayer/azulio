import { describe, it, expect } from 'vitest';
import { COLORS, TILES_PER_COLOR } from '@azul/shared';
import type { GameState } from '@azul/shared';
import { createGame } from './index.js';

function totalTiles(state: GameState): number {
  let n = state.bag.length + state.discard.length + state.center.length;
  for (const f of state.factories) n += f.length;
  for (const p of state.players) {
    for (const line of p.board.patternLines) {
      n += line.filter((c) => c !== null).length;
    }
    for (const row of p.board.wall) {
      n += row.filter((c) => c !== null).length;
    }
    // floor: count only colour tiles, the FIRST marker is not a real tile
    n += p.board.floor.filter((s) => s !== 'FIRST').length;
  }
  return n;
}

const players2 = [
  { id: 'p1', name: 'Alice' },
  { id: 'p2', name: 'Bob' },
];

describe('createGame', () => {
  it('creates 5 factories for 2 players, each with 4 tiles', () => {
    const state = createGame(players2, 123);
    expect(state.factories).toHaveLength(5);
    for (const f of state.factories) {
      expect(f).toHaveLength(4);
    }
  });

  it('creates 7 factories for 3 players and 9 for 4 players', () => {
    const s3 = createGame(
      [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
        { id: 'c', name: 'C' },
      ],
      1,
    );
    const s4 = createGame(
      [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
        { id: 'c', name: 'C' },
        { id: 'd', name: 'D' },
      ],
      1,
    );
    expect(s3.factories).toHaveLength(7);
    expect(s4.factories).toHaveLength(9);
  });

  it('conserves exactly 100 tiles across bag + factories + center', () => {
    const state = createGame(players2, 7);
    expect(COLORS.length * TILES_PER_COLOR).toBe(100);
    expect(totalTiles(state)).toBe(100);
  });

  it('puts the first-player marker in the center and leaves the center empty of tiles', () => {
    const state = createGame(players2, 7);
    expect(state.centerHasFirstToken).toBe(true);
    expect(state.center).toEqual([]);
  });

  it('starts each player with empty pattern lines (capacity 1..5), empty wall and floor, score 0', () => {
    const state = createGame(players2, 7);
    expect(state.players).toHaveLength(2);
    for (const p of state.players) {
      expect(p.board.patternLines.map((l) => l.length)).toEqual([1, 2, 3, 4, 5]);
      expect(p.board.patternLines.every((l) => l.every((c) => c === null))).toBe(true);
      expect(p.board.wall).toHaveLength(5);
      expect(p.board.wall.every((row) => row.length === 5 && row.every((c) => c === null))).toBe(true);
      expect(p.board.floor).toEqual([]);
      expect(p.board.score).toBe(0);
    }
  });

  it('starts in the offer phase, round 1, player 0 to move, turnSeq 0', () => {
    const state = createGame(players2, 7);
    expect(state.phase).toBe('offer');
    expect(state.round).toBe(1);
    expect(state.currentPlayerIndex).toBe(0);
    expect(state.turnSeq).toBe(0);
    expect(state.winnerIds).toBeNull();
  });

  it('is deterministic for a given seed', () => {
    const a = createGame(players2, 42);
    const b = createGame(players2, 42);
    expect(a.factories).toEqual(b.factories);
    expect(a.bag).toEqual(b.bag);
  });
});
