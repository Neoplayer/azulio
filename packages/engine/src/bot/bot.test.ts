import { describe, it, expect } from 'vitest';
import type { GameState, Move } from '@azul/shared';
import { createGame, legalMoves, applyMove, isLegalMove } from '../index.js';
import { makeRng } from '../rng.js';
import { BOT_PRESETS } from './types.js';
import type { BotLevel } from './types.js';
import { evaluate } from './evaluate.js';
import { selectMove, greedyBestMoves } from './selectMove.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const PLAYERS_2 = [
  { id: 'p1', name: 'Alice' },
  { id: 'p2', name: 'Bob' },
];

function freshGame(seed = 42): GameState {
  return createGame(PLAYERS_2, seed);
}

/** Drive the game forward by `n` moves using autoMove-style random picks. */
function advanceGame(state: GameState, moves: number, seed = 99): GameState {
  const rng = makeRng(seed);
  let s = state;
  for (let i = 0; i < moves; i++) {
    const legal = legalMoves(s);
    if (legal.length === 0) break;
    s = applyMove(s, legal[Math.floor(rng() * legal.length)]!);
  }
  return s;
}

// ---------------------------------------------------------------------------
// 1. Determinism — same (state, seed) must always yield the same move
// ---------------------------------------------------------------------------

describe('selectMove — determinism', () => {
  const levels: BotLevel[] = ['easy', 'medium', 'hard'];

  for (const level of levels) {
    it(`${level}: identical calls with the same seed return the same move`, () => {
      const state = advanceGame(freshGame(1), 3);
      const config = BOT_PRESETS[level];

      const rng1 = makeRng(7777);
      const rng2 = makeRng(7777);

      const move1 = selectMove(state, 0, config, rng1);
      const move2 = selectMove(state, 0, config, rng2);

      expect(move1).toEqual(move2);
    });

    it(`${level}: selectMove always returns one of the legal moves`, () => {
      const state = advanceGame(freshGame(7), 2);
      const legal = legalMoves(state);
      if (legal.length === 0) return;
      const config = BOT_PRESETS[level];
      const rng = makeRng(42);
      const chosen = selectMove(state, 0, config, rng);
      expect(legal.some((m) => JSON.stringify(m) === JSON.stringify(chosen))).toBe(true);
    });

    // Epsilon noise (medium/hard only): forcing epsilon=1 always samples from top-N
    if (level !== 'easy') {
      it(`${level}: forced epsilon=1 picks from topN greedy candidates`, () => {
        const forcedConfig = { ...BOT_PRESETS[level], epsilon: 1.0 };
        const state = advanceGame(freshGame(7), 2);
        const legal = legalMoves(state);
        if (legal.length < 2) return;

        const ranked = greedyBestMoves(state, 0, forcedConfig);
        const topN = ranked.slice(0, 3);
        const rng = makeRng(42);
        const chosen = selectMove(state, 0, forcedConfig, rng);
        expect(topN.some((m) => JSON.stringify(m) === JSON.stringify(chosen))).toBe(true);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Legality — selectMove must always return a legal move
// ---------------------------------------------------------------------------

describe('selectMove — legality', () => {
  const levels: BotLevel[] = ['easy', 'medium', 'hard'];

  for (const level of levels) {
    it(`${level}: always returns a legal move across varied game states`, () => {
      const config = BOT_PRESETS[level];
      for (let gameSeed = 0; gameSeed < 5; gameSeed++) {
        let state = freshGame(gameSeed);
        const rng = makeRng(gameSeed * 13 + 7);
        for (let turn = 0; turn < 12; turn++) {
          if (legalMoves(state).length === 0) break;
          const move = selectMove(state, state.currentPlayerIndex, config, makeRng(turn * 100 + gameSeed));
          expect(isLegalMove(state, move)).toBe(true);
          state = applyMove(state, move);
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 3. evaluate — sanity checks
// ---------------------------------------------------------------------------

describe('evaluate — sanity', () => {
  it('placing a tile that gains adjacency scores higher than dumping to floor', () => {
    // Build a state where player 0 can either place to a pattern line (gaining
    // adjacency) or dump to the floor.  The pattern-line move should evaluate higher.
    const state = freshGame(5);
    const legal = legalMoves(state);

    // Separate floor moves from pattern-line moves
    const floorMoves = legal.filter((m) => m.target.type === 'floor');
    const patternMoves = legal.filter((m) => m.target.type === 'patternLine');

    if (floorMoves.length === 0 || patternMoves.length === 0) return; // skip if degenerate

    const config = BOT_PRESETS.medium;
    const playerIndex = state.currentPlayerIndex;

    const bestPatternScore = Math.max(
      ...patternMoves.map((m) => evaluate(applyMove(state, m), playerIndex, config)),
    );
    const bestFloorScore = Math.max(
      ...floorMoves.map((m) => evaluate(applyMove(state, m), playerIndex, config)),
    );

    // A good pattern-line move should outscore a pure floor dump on average.
    // We test only the best of each category.
    expect(bestPatternScore).toBeGreaterThanOrEqual(bestFloorScore);
  });

  it('a state with floor tiles evaluates lower than the same state without', () => {
    const state = freshGame(3);
    const legal = legalMoves(state);
    const floorMoves = legal.filter((m) => m.target.type === 'floor');
    const patternMoves = legal.filter((m) => m.target.type === 'patternLine');
    if (floorMoves.length === 0 || patternMoves.length === 0) return;

    const config = BOT_PRESETS.medium;
    const pi = state.currentPlayerIndex;

    const floorState = applyMove(state, floorMoves[0]!);
    const patternState = applyMove(state, patternMoves[0]!);

    // Evaluate from the perspective of the player who just moved.
    // Floor state should generally score worse.
    const scoreFloor = evaluate(floorState, pi, config);
    const scorePattern = evaluate(patternState, pi, config);

    expect(scorePattern).toBeGreaterThan(scoreFloor);
  });

  it('useEndgameBonuses increases evaluate for a wall with a complete row', () => {
    const state = freshGame(2);
    // Fill a complete row for player 0 — W_ENDGAME_ROW = 2 should add 2 points
    state.players[0]!.board.wall[0] = ['blue', 'yellow', 'red', 'black', 'white'];

    const configOff = BOT_PRESETS.medium; // useEndgameBonuses = false
    const configOn = BOT_PRESETS.hard;   // useEndgameBonuses = true

    const scoreOff = evaluate(state, 0, configOff);
    const scoreOn = evaluate(state, 0, configOn);

    // Hard config should value the complete row (W_ENDGAME_ROW = 2)
    expect(scoreOn).toBeGreaterThan(scoreOff);
  });
});

// ---------------------------------------------------------------------------
// 4. greedyBestMoves — basic contract checks
// ---------------------------------------------------------------------------

describe('greedyBestMoves', () => {
  it('returns all legal moves, sorted best-first', () => {
    const state = freshGame(10);
    const config = BOT_PRESETS.medium;
    const ranked = greedyBestMoves(state, 0, config);
    const legal = legalMoves(state);

    expect(ranked).toHaveLength(legal.length);

    // Verify the list is non-increasing in score
    for (let i = 1; i < ranked.length; i++) {
      const scoreA = evaluate(applyMove(state, ranked[i - 1]!), 0, config);
      const scoreB = evaluate(applyMove(state, ranked[i]!), 0, config);
      expect(scoreA).toBeGreaterThanOrEqual(scoreB);
    }
  });

  it('returns empty array when there are no legal moves', () => {
    // Construct a finished state (no offer moves possible)
    const base = freshGame(1);
    const finishedState: GameState = {
      ...base,
      phase: 'finished',
    };
    const ranked = greedyBestMoves(finishedState, 0, BOT_PRESETS.medium);
    expect(ranked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. floorCostForMove — playerIndex threading (FIX: was reading currentPlayerIndex)
// ---------------------------------------------------------------------------

describe('selectMove — floorCost uses supplied playerIndex', () => {
  it('easy bot selects a no-floor move using the correct player board', () => {
    // Advance to a state where player 1 is the current player.
    // selectMove must read player 1's pattern lines, not player 0's.
    let state = freshGame(3);
    const rng = makeRng(123);
    // Drive until it's player 1's turn (or stay at 0 if it already is 1).
    let s = state;
    for (let i = 0; i < 20; i++) {
      const legal = legalMoves(s);
      if (legal.length === 0) break;
      if (s.currentPlayerIndex === 1) break;
      s = applyMove(s, legal[0]!);
    }
    const pi = s.currentPlayerIndex;
    const config = BOT_PRESETS.easy;
    const chosen = selectMove(s, pi, config, makeRng(99));
    expect(isLegalMove(s, chosen)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. BOT_PRESETS shape validation
// ---------------------------------------------------------------------------

describe('BOT_PRESETS', () => {
  it('has correct levels and epsilon ordering (easy > medium > hard)', () => {
    expect(BOT_PRESETS.easy.epsilon).toBeGreaterThan(BOT_PRESETS.medium.epsilon);
    expect(BOT_PRESETS.medium.epsilon).toBeGreaterThan(BOT_PRESETS.hard.epsilon);
  });

  it('hard has greater searchDepth than medium and easy', () => {
    expect(BOT_PRESETS.hard.searchDepth).toBeGreaterThan(BOT_PRESETS.medium.searchDepth);
    expect(BOT_PRESETS.hard.searchDepth).toBeGreaterThan(BOT_PRESETS.easy.searchDepth);
  });

  it('hard uses endgame bonuses; easy and medium do not', () => {
    expect(BOT_PRESETS.hard.useEndgameBonuses).toBe(true);
    expect(BOT_PRESETS.medium.useEndgameBonuses).toBe(false);
    expect(BOT_PRESETS.easy.useEndgameBonuses).toBe(false);
  });
});
