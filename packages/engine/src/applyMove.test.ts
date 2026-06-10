import { describe, it, expect } from 'vitest';
import type { GameState, Move } from '@azul/shared';
import { createGame, applyMove, isLegalMove, legalMoves } from './index.js';

const players2 = [
  { id: 'p1', name: 'Alice' },
  { id: 'p2', name: 'Bob' },
];

/**
 * Build a deterministic, hand-crafted offer-phase state so move tests don't
 * depend on shuffle output. Two players, simple factories, empty center.
 */
function handState(): GameState {
  const base = createGame(players2, 1);
  return {
    ...base,
    factories: [
      ['blue', 'blue', 'red', 'white'],
      ['yellow', 'yellow', 'yellow', 'black'],
    ],
    center: [],
    centerHasFirstToken: true,
    bag: [],
    discard: [],
  };
}

describe('isLegalMove / legalMoves', () => {
  it('rejects taking a colour that is not present in the source', () => {
    const s = handState();
    const move: Move = {
      source: { type: 'factory', index: 0 },
      color: 'yellow', // factory 0 has no yellow
      target: { type: 'patternLine', row: 0 },
    };
    expect(isLegalMove(s, move)).toBe(false);
  });

  it('rejects placing into a pattern line that already holds a different colour', () => {
    const s = handState();
    s.players[0]!.board.patternLines[1] = ['red', null]; // row capacity 2, holds red
    const move: Move = {
      source: { type: 'factory', index: 0 },
      color: 'blue',
      target: { type: 'patternLine', row: 1 },
    };
    expect(isLegalMove(s, move)).toBe(false);
  });

  it('rejects placing a colour already tiled on the wall in that row', () => {
    const s = handState();
    // wall row 0, the blue cell is already filled
    s.players[0]!.board.wall[0]![0] = 'blue';
    const move: Move = {
      source: { type: 'factory', index: 0 },
      color: 'blue',
      target: { type: 'patternLine', row: 0 },
    };
    expect(isLegalMove(s, move)).toBe(false);
  });

  it('rejects placing into a full pattern line', () => {
    const s = handState();
    s.players[0]!.board.patternLines[0] = ['blue']; // capacity-1 line already full
    const move: Move = {
      source: { type: 'factory', index: 0 },
      color: 'blue',
      target: { type: 'patternLine', row: 0 },
    };
    expect(isLegalMove(s, move)).toBe(false);
  });

  it('always allows dumping a present colour onto the floor', () => {
    const s = handState();
    const move: Move = {
      source: { type: 'factory', index: 0 },
      color: 'blue',
      target: { type: 'floor' },
    };
    expect(isLegalMove(s, move)).toBe(true);
  });

  it('enumerates only legal moves for the current player', () => {
    const s = handState();
    const moves = legalMoves(s);
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((m) => isLegalMove(s, m))).toBe(true);
  });
});

describe('applyMove — from factory', () => {
  it('takes all tiles of the colour, sends the rest to the center, empties the factory', () => {
    const s = handState();
    const next = applyMove(s, {
      source: { type: 'factory', index: 0 },
      color: 'blue',
      target: { type: 'patternLine', row: 1 }, // capacity 2 -> holds both blues
    });
    expect(next.factories[0]).toEqual([]);
    expect([...next.center].sort()).toEqual(['red', 'white']);
    expect(next.players[0]!.board.patternLines[1]).toEqual(['blue', 'blue']);
  });

  it('overflows excess tiles onto the floor line', () => {
    const s = handState();
    const next = applyMove(s, {
      source: { type: 'factory', index: 0 },
      color: 'blue',
      target: { type: 'patternLine', row: 0 }, // capacity 1, but two blues taken
    });
    expect(next.players[0]!.board.patternLines[0]).toEqual(['blue']);
    expect(next.players[0]!.board.floor).toEqual(['blue']);
  });

  it('does not mutate the input state and increments turnSeq, advances the player', () => {
    const s = handState();
    const before = JSON.stringify(s);
    const next = applyMove(s, {
      source: { type: 'factory', index: 0 },
      color: 'blue',
      target: { type: 'floor' },
    });
    expect(JSON.stringify(s)).toBe(before); // immutable
    expect(next.turnSeq).toBe(s.turnSeq + 1);
    expect(next.currentPlayerIndex).toBe(1);
  });

  it('throws on an illegal move and leaves state untouched', () => {
    const s = handState();
    expect(() =>
      applyMove(s, {
        source: { type: 'factory', index: 0 },
        color: 'yellow',
        target: { type: 'patternLine', row: 0 },
      }),
    ).toThrow();
  });
});

describe('applyMove — from center', () => {
  it('gives the first-player marker to the first taker (onto their floor) and clears the center token', () => {
    const s = handState();
    s.factories = [['blue', 'red', 'red', 'white'], []];
    s.center = ['yellow', 'yellow'];
    s.centerHasFirstToken = true;
    const next = applyMove(s, {
      source: { type: 'center' },
      color: 'yellow',
      target: { type: 'patternLine', row: 1 },
    });
    expect(next.centerHasFirstToken).toBe(false);
    expect(next.players[0]!.board.floor).toContain('FIRST');
    expect(next.players[0]!.board.patternLines[1]).toEqual(['yellow', 'yellow']);
    expect(next.firstPlayerIndex).toBe(0);
  });

  it('does not grant the marker again once it is taken', () => {
    let s = handState();
    s.factories = [[], []];
    s.center = ['yellow', 'yellow', 'red'];
    s.centerHasFirstToken = true;
    s = applyMove(s, {
      source: { type: 'center' },
      color: 'yellow',
      target: { type: 'floor' },
    });
    // player 1 now takes red from center; no marker left
    const next = applyMove(s, {
      source: { type: 'center' },
      color: 'red',
      target: { type: 'floor' },
    });
    expect(next.players[1]!.board.floor).not.toContain('FIRST');
  });
});
