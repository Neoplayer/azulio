import { describe, it, expect } from 'vitest';
import type { Color, GameState } from '@azul/shared';
import { createGame, isOfferPhaseOver, resolveTiling } from './index.js';

const players2 = [
  { id: 'p1', name: 'Alice' },
  { id: 'p2', name: 'Bob' },
];

function base(): GameState {
  const s = createGame(players2, 1);
  // wipe randomness-dependent fields for deterministic tiling tests
  s.factories = [[], [], [], [], []];
  s.center = [];
  s.centerHasFirstToken = false;
  s.bag = [];
  s.discard = [];
  return s;
}

function fullLine(color: Color, capacity: number): (Color | null)[] {
  return new Array<Color | null>(capacity).fill(color);
}

describe('isOfferPhaseOver', () => {
  it('is false while any factory or the center still holds tiles', () => {
    const s = base();
    s.factories[0] = ['blue'];
    expect(isOfferPhaseOver(s)).toBe(false);
    s.factories[0] = [];
    s.center = ['red'];
    expect(isOfferPhaseOver(s)).toBe(false);
  });

  it('is true when all factories and the center are empty (first marker alone does not matter)', () => {
    const s = base();
    s.centerHasFirstToken = true;
    expect(isOfferPhaseOver(s)).toBe(true);
  });
});

describe('resolveTiling — wall placement', () => {
  it('moves one tile from a full pattern line to the wall and discards the rest', () => {
    const s = base();
    // row 2 capacity 3, full of blue -> wall[2][col blue]=blue, 2 tiles to discard
    s.players[0]!.board.patternLines[2] = fullLine('blue', 3);
    const next = resolveTiling(s);
    // WALL_PATTERN[2] = black,white,blue,yellow,red -> blue is column 2
    expect(next.players[0]!.board.wall[2]![2]).toBe('blue');
    expect(next.players[0]!.board.patternLines[2]!.every((c) => c === null)).toBe(true);
    expect(next.discard.filter((c) => c === 'blue')).toHaveLength(2);
  });

  it('leaves partial (not full) pattern lines untouched', () => {
    const s = base();
    s.players[0]!.board.patternLines[3] = ['red', 'red', null, null]; // 2/4 -> stays
    const next = resolveTiling(s);
    expect(next.players[0]!.board.patternLines[3]).toEqual(['red', 'red', null, null]);
    expect(next.players[0]!.board.wall[3]!.every((c) => c === null)).toBe(true);
  });
});

describe('resolveTiling — scoring algorithm', () => {
  it('scores an isolated tile as exactly 1', () => {
    const s = base();
    s.players[0]!.board.patternLines[0] = fullLine('blue', 1);
    const next = resolveTiling(s);
    expect(next.players[0]!.board.score).toBe(1);
  });

  it('scores a horizontal run by its length only (vertical axis = 1 not counted)', () => {
    const s = base();
    // pre-place white at wall[2][1]; place blue at wall[2][2] -> horizontal run of 2
    s.players[0]!.board.wall[2]![1] = 'white';
    s.players[0]!.board.patternLines[2] = fullLine('blue', 3);
    const next = resolveTiling(s);
    expect(next.players[0]!.board.score).toBe(2);
  });

  it('scores a vertical run by its length only', () => {
    const s = base();
    // column 2: pre-place rows 1 and 3, then place row 2 -> vertical run of 3
    s.players[0]!.board.wall[1]![2] = 'yellow';
    s.players[0]!.board.wall[3]![2] = 'white';
    s.players[0]!.board.patternLines[2] = fullLine('blue', 3);
    const next = resolveTiling(s);
    expect(next.players[0]!.board.score).toBe(3);
  });

  it('scores both axes when the tile has horizontal and vertical neighbours', () => {
    const s = base();
    s.players[0]!.board.wall[2]![1] = 'white'; // horizontal neighbour
    s.players[0]!.board.wall[1]![2] = 'yellow'; // vertical neighbour
    s.players[0]!.board.patternLines[2] = fullLine('blue', 3);
    const next = resolveTiling(s);
    // h = 2 (cols 1,2), v = 2 (rows 1,2) -> 4
    expect(next.players[0]!.board.score).toBe(4);
  });
});

describe('resolveTiling — floor penalties & marker', () => {
  it('subtracts floor penalties from the score but never below zero', () => {
    const s = base();
    s.players[0]!.board.score = 1;
    s.players[0]!.board.floor = ['blue', 'red', 'white']; // -1 -1 -2 = -4
    const next = resolveTiling(s);
    expect(next.players[0]!.board.score).toBe(0);
    expect(next.players[0]!.board.floor).toEqual([]);
  });

  it('penalises the first-player marker slot and returns the marker to the center', () => {
    const s = base();
    s.players[0]!.board.score = 5;
    s.players[0]!.board.floor = ['FIRST', 'blue']; // -1 -1 = -2
    s.firstPlayerIndex = 0;
    const next = resolveTiling(s);
    expect(next.players[0]!.board.score).toBe(3);
    expect(next.players[0]!.board.floor).toEqual([]);
    expect(next.centerHasFirstToken).toBe(true);
  });
});
