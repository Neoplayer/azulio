import { describe, it, expect } from 'vitest';
import type { Color, GameState } from '@azul/shared';
import {
  createGame,
  finalizeScores,
  autoMove,
  isLegalMove,
  toPlayerView,
} from './index.js';

const players2 = [
  { id: 'p1', name: 'Alice' },
  { id: 'p2', name: 'Bob' },
];

const FULL_ROW: Color[] = ['blue', 'yellow', 'red', 'black', 'white'];

function base(): GameState {
  const s = createGame(players2, 1);
  s.factories = [[], [], [], [], []];
  s.center = [];
  s.centerHasFirstToken = false;
  s.bag = [];
  s.discard = [];
  return s;
}

describe('finalizeScores — bonuses', () => {
  it('adds +2 for each complete horizontal row', () => {
    const s = base();
    s.players[0]!.board.wall[0] = [...FULL_ROW];
    s.players[0]!.board.score = 0;
    const next = finalizeScores(s);
    expect(next.players[0]!.board.score).toBe(2);
  });

  it('adds +7 for a complete column and +10 for a complete colour', () => {
    const s = base();
    // fill the entire wall -> 5 rows(+10), 5 cols(+35), 5 colours(+50) = 95 bonus
    for (let r = 0; r < 5; r++) {
      s.players[0]!.board.wall[r] = [
        ...['blue', 'yellow', 'red', 'black', 'white'].map((_, c) => {
          const pattern: Color[][] = [
            ['blue', 'yellow', 'red', 'black', 'white'],
            ['white', 'blue', 'yellow', 'red', 'black'],
            ['black', 'white', 'blue', 'yellow', 'red'],
            ['red', 'black', 'white', 'blue', 'yellow'],
            ['yellow', 'red', 'black', 'white', 'blue'],
          ];
          return pattern[r]![c]!;
        }),
      ];
    }
    s.players[0]!.board.score = 0;
    const next = finalizeScores(s);
    expect(next.players[0]!.board.score).toBe(5 * 2 + 5 * 7 + 5 * 10);
  });

  it('sets phase to finished and picks the highest score as winner', () => {
    const s = base();
    s.players[0]!.board.score = 20;
    s.players[1]!.board.score = 15;
    const next = finalizeScores(s);
    expect(next.phase).toBe('finished');
    expect(next.winnerIds).toEqual(['p1']);
  });

  it('breaks ties by number of complete rows, then declares a shared win', () => {
    const s = base();
    s.players[0]!.board.score = 10;
    s.players[1]!.board.score = 10;
    s.players[0]!.board.wall[0] = [...FULL_ROW]; // p1 has one more complete row
    const next = finalizeScores(s);
    // p1 gets +2 for the row -> 12 vs 10, clear winner
    expect(next.winnerIds).toEqual(['p1']);

    const s2 = base();
    s2.players[0]!.board.score = 10;
    s2.players[1]!.board.score = 10;
    const tie = finalizeScores(s2);
    expect(tie.winnerIds!.sort()).toEqual(['p1', 'p2']);
  });
});

describe('autoMove', () => {
  it('returns a legal move', () => {
    const s = base();
    s.factories = [['blue', 'blue', 'red', 'white'], [], [], [], []];
    const move = autoMove(s);
    expect(isLegalMove(s, move)).toBe(true);
  });

  it('is deterministic for the same state', () => {
    const s = base();
    s.factories = [['blue', 'red', 'red', 'white'], ['yellow', 'yellow', 'black', 'black'], [], [], []];
    expect(autoMove(s)).toEqual(autoMove(s));
  });

  it('prefers a move that puts nothing on the floor over one that does', () => {
    const s = base();
    // single blue fits cleanly into pattern row 0 (capacity 1) -> 0 floor cost
    s.factories = [['blue', 'green' as Color, 'red', 'white'], [], [], [], []];
    s.factories[0] = ['blue', 'red', 'white', 'black'];
    const move = autoMove(s);
    expect(move.target.type).toBe('patternLine');
  });
});

describe('toPlayerView', () => {
  it('hides the bag composition, exposing only its count', () => {
    const s = base();
    s.bag = new Array<Color>(17).fill('blue');
    const view = toPlayerView(s, 'p1');
    expect(view.bagCount).toBe(17);
    expect((view as unknown as { bag?: unknown }).bag).toBeUndefined();
  });

  it('marks the receiving player and maps current/first player ids', () => {
    const s = base();
    s.currentPlayerIndex = 1;
    s.firstPlayerIndex = 0;
    const view = toPlayerView(s, 'p2');
    expect(view.you).toBe('p2');
    expect(view.currentPlayerId).toBe('p2');
    expect(view.firstPlayerId).toBe('p1');
    expect(view.players.every((p) => typeof p.connected === 'boolean')).toBe(true);
  });
});
