import { describe, it, expect } from 'vitest';
import type { Color, GameState } from '@azul/shared';
import { createGame, startNextRound, isGameOver } from './index.js';

const players2 = [
  { id: 'p1', name: 'Alice' },
  { id: 'p2', name: 'Bob' },
];

function postTiling(): GameState {
  const s = createGame(players2, 1);
  s.factories = [[], [], [], [], []];
  s.center = [];
  s.centerHasFirstToken = true; // marker returned during tiling
  s.bag = [];
  s.discard = [];
  s.round = 1;
  s.firstPlayerIndex = 1;
  s.currentPlayerIndex = 0;
  s.phase = 'tiling';
  return s;
}

describe('startNextRound', () => {
  it('fills every factory with 4 tiles when the bag has enough', () => {
    const s = postTiling();
    s.bag = new Array<Color>(40).fill('blue');
    const next = startNextRound(s);
    expect(next.factories).toHaveLength(5);
    expect(next.factories.every((f) => f.length === 4)).toBe(true);
  });

  it('sets the next round to offer phase, the first player to move, and increments the round', () => {
    const s = postTiling();
    s.bag = new Array<Color>(40).fill('blue');
    const next = startNextRound(s);
    expect(next.phase).toBe('offer');
    expect(next.currentPlayerIndex).toBe(1); // = firstPlayerIndex
    expect(next.round).toBe(2);
    expect(next.center).toEqual([]);
    expect(next.centerHasFirstToken).toBe(true);
  });

  it('reshuffles the discard into the bag when the bag runs out mid-refill', () => {
    const s = postTiling();
    s.bag = new Array<Color>(3).fill('blue'); // not enough for 5x4=20
    s.discard = new Array<Color>(30).fill('red');
    const next = startNextRound(s);
    const onFactories = next.factories.reduce((n, f) => n + f.length, 0);
    expect(onFactories).toBe(20); // 3 + 30 >= 20, so all factories full
  });

  it('fills factories only partially when both bag and discard are exhausted', () => {
    const s = postTiling();
    s.bag = new Array<Color>(6).fill('blue'); // only 6 tiles total available
    s.discard = [];
    const next = startNextRound(s);
    const onFactories = next.factories.reduce((n, f) => n + f.length, 0);
    expect(onFactories).toBe(6);
    expect(next.bag).toHaveLength(0);
    expect(next.discard).toHaveLength(0);
  });
});

describe('isGameOver', () => {
  it('is false when no wall row is complete', () => {
    const s = postTiling();
    s.players[0]!.board.wall[0] = ['blue', 'yellow', 'red', 'black', null];
    expect(isGameOver(s)).toBe(false);
  });

  it('is true when some player has a complete horizontal wall row', () => {
    const s = postTiling();
    s.players[1]!.board.wall[3] = ['red', 'black', 'white', 'blue', 'yellow'];
    expect(isGameOver(s)).toBe(true);
  });
});
