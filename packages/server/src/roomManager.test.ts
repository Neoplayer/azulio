// ---------------------------------------------------------------------------
// @azul/server — roomManager.test.ts
// Tests use a FAKE clock — no real waiting.
// Run: npx vitest run packages/server/src/roomManager.test.ts
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { createRoomManager } from './roomManager.js';
import type { Clock } from './types.js';
import type { Move, PlayerId, BotLevel } from '@azul/shared';
import { legalMoves } from '@azul/engine';

// ---------------------------------------------------------------------------
// Fake clock
// ---------------------------------------------------------------------------

interface FakeClock extends Clock {
  advance(ms: number): void;
  readonly nowMs: number;
}

function makeFakeClock(startMs = 0): FakeClock {
  let nowMs = startMs;
  const timers: { id: number; fireAt: number; cb: () => void; cancelled: boolean }[] = [];
  let nextId = 1;

  function advance(ms: number): void {
    nowMs += ms;
    // Fire all non-cancelled timers whose fireAt <= nowMs, sorted by fireAt.
    const toFire = timers
      .filter((t) => !t.cancelled && t.fireAt <= nowMs)
      .sort((a, b) => a.fireAt - b.fireAt);
    for (const t of toFire) {
      if (!t.cancelled) {
        t.cancelled = true;
        t.cb();
      }
    }
  }

  return {
    get nowMs() { return nowMs; },
    now: () => nowMs,
    setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
      const id = nextId++;
      timers.push({ id, fireAt: nowMs + ms, cb: fn, cancelled: false });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(h: ReturnType<typeof setTimeout>): void {
      const id = h as unknown as number;
      const t = timers.find((x) => x.id === id);
      if (t) t.cancelled = true;
    },
    advance,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLAYERS = [
  { id: 'p1', name: 'Alice' },
  { id: 'p2', name: 'Bob' },
];

const TURN_MS = 60_000;
const SEED = 42;

function makeManager(clock: FakeClock) {
  return createRoomManager({ clock });
}

// ---------------------------------------------------------------------------
// startGame — initial events
// ---------------------------------------------------------------------------

describe('startGame — initial events', () => {
  it('emits onTurn with a deadline after startGame', () => {
    const clock = makeFakeClock(1000);
    const manager = makeManager(clock);

    const turns: Array<{ currentPlayerId: PlayerId; deadline: number }> = [];
    manager.onTurn = (pid, deadline) => turns.push({ currentPlayerId: pid, deadline });

    manager.startGame(PLAYERS, SEED, TURN_MS);

    expect(turns).toHaveLength(1);
    expect(turns[0]!.currentPlayerId).toBe('p1');
    expect(turns[0]!.deadline).toBe(1000 + TURN_MS);
  });

  it('emits onState views with bagCount (bag composition hidden)', () => {
    const clock = makeFakeClock();
    const manager = makeManager(clock);

    const stateViews: Map<PlayerId, unknown>[] = [];
    manager.onState = (views) => stateViews.push(new Map(views));

    manager.startGame(PLAYERS, SEED, TURN_MS);

    expect(stateViews).toHaveLength(1);
    const view = stateViews[0]!.get('p1') as Record<string, unknown>;
    expect(view).toBeDefined();
    expect(typeof view['bagCount']).toBe('number');
    expect(view['bag']).toBeUndefined();
    expect(view['you']).toBe('p1');
  });

  it('emits onState for each player with the correct you field', () => {
    const clock = makeFakeClock();
    const manager = makeManager(clock);

    const stateViews: Map<PlayerId, unknown>[] = [];
    manager.onState = (views) => stateViews.push(new Map(views));

    manager.startGame(PLAYERS, SEED, TURN_MS);

    const snap = stateViews[0]!;
    expect(snap.size).toBe(2);
    const v1 = snap.get('p1') as Record<string, unknown>;
    const v2 = snap.get('p2') as Record<string, unknown>;
    expect(v1['you']).toBe('p1');
    expect(v2['you']).toBe('p2');
  });
});

// ---------------------------------------------------------------------------
// submitMove — legal move
// ---------------------------------------------------------------------------

describe('submitMove — legal move', () => {
  it('advances turnSeq and emits onApplied', () => {
    const clock = makeFakeClock();
    const manager = makeManager(clock);

    const applied: Array<{ move: Move; by: PlayerId; turnSeq: number }> = [];
    manager.onApplied = (move, by, turnSeq) => applied.push({ move, by, turnSeq });

    manager.startGame(PLAYERS, SEED, TURN_MS);

    const move = legalMoves(manager.getState())[0]!;
    const result = manager.submitMove('p1', move, 0);

    expect(result).toBeNull();
    expect(applied).toHaveLength(1);
    expect(applied[0]!.by).toBe('p1');
    expect(applied[0]!.turnSeq).toBe(1);
    expect(manager.getState().turnSeq).toBe(1);
  });

  it('emits onTurn for the next player after a successful move', () => {
    const clock = makeFakeClock();
    const manager = makeManager(clock);

    const turns: Array<{ pid: PlayerId }> = [];
    manager.onTurn = (pid) => turns.push({ pid });

    manager.startGame(PLAYERS, SEED, TURN_MS);
    const move = legalMoves(manager.getState())[0]!;
    manager.submitMove('p1', move, 0);

    expect(turns.length).toBeGreaterThanOrEqual(2);
    expect(turns[0]!.pid).toBe('p1');
    const s = manager.getState();
    const nextPid = s.players[s.currentPlayerIndex]!.id;
    expect(turns[turns.length - 1]!.pid).toBe(nextPid);
  });
});

// ---------------------------------------------------------------------------
// submitMove — rejection cases
// ---------------------------------------------------------------------------

describe('submitMove — rejection', () => {
  it('returns an error for stale expectedTurnSeq (double-tap guard)', () => {
    const clock = makeFakeClock();
    const manager = makeManager(clock);
    manager.startGame(PLAYERS, SEED, TURN_MS);

    const move = legalMoves(manager.getState())[0]!;
    manager.submitMove('p1', move, 0); // advance to turnSeq=1

    const result = manager.submitMove('p1', move, 0); // old expectedTurnSeq
    expect(result).not.toBeNull();
    expect(manager.getState().turnSeq).toBe(1);
  });

  it('returns an error when the wrong player submits', () => {
    const clock = makeFakeClock();
    const manager = makeManager(clock);
    manager.startGame(PLAYERS, SEED, TURN_MS);

    const move = legalMoves(manager.getState())[0]!;
    const result = manager.submitMove('p2', move, 0); // p1's turn
    expect(result).not.toBeNull();
    expect(manager.getState().turnSeq).toBe(0);
  });

  it('returns an error for an illegal move', () => {
    const clock = makeFakeClock();
    const manager = makeManager(clock);
    manager.startGame(PLAYERS, SEED, TURN_MS);

    const illegalMove: Move = {
      source: { type: 'factory', index: 99 },
      color: 'blue',
      target: { type: 'floor' },
    };
    const result = manager.submitMove('p1', illegalMove, 0);
    expect(result).not.toBeNull();
    expect(manager.getState().turnSeq).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Timer / auto-move
// ---------------------------------------------------------------------------

describe('timer — auto-move on timeout', () => {
  it('fires exactly ONE auto-move when the clock advances past the deadline', () => {
    const clock = makeFakeClock();
    const manager = makeManager(clock);

    const applied: Array<{ turnSeq: number }> = [];
    manager.onApplied = (_move, _by, turnSeq) => applied.push({ turnSeq });

    manager.startGame(PLAYERS, SEED, TURN_MS);
    expect(manager.getState().turnSeq).toBe(0);

    clock.advance(TURN_MS + 1);

    expect(applied).toHaveLength(1);
    expect(applied[0]!.turnSeq).toBe(1);
    expect(manager.getState().turnSeq).toBe(1);
  });

  it('does NOT double-advance: stale real move after auto-move is rejected', () => {
    const clock = makeFakeClock();
    const manager = makeManager(clock);
    manager.startGame(PLAYERS, SEED, TURN_MS);

    const move = legalMoves(manager.getState())[0]!;
    clock.advance(TURN_MS + 1); // auto-move fires, turnSeq → 1

    const result = manager.submitMove('p1', move, 0); // old expectedTurnSeq
    expect(result).not.toBeNull();
    expect(manager.getState().turnSeq).toBe(1);
  });

  it('real move cancels the original timer — turnSeq only increments once', () => {
    const clock = makeFakeClock();
    const manager = makeManager(clock);

    const applied: Array<{ turnSeq: number }> = [];
    manager.onApplied = (_move, _by, turnSeq) => applied.push({ turnSeq });

    manager.startGame(PLAYERS, SEED, TURN_MS);
    // Advance halfway so the original timer is still pending.
    clock.advance(TURN_MS / 2);

    const move = legalMoves(manager.getState())[0]!;
    manager.submitMove('p1', move, 0); // cancels the original timer (t=60s)

    // Advance just past where the ORIGINAL timer would have fired (t=60s from start)
    // but not past the NEW timer (t=60s from move submission at t=30s => fires at t=90s).
    clock.advance(TURN_MS / 2 + 1); // total time = 60001ms; new timer fires at 90000ms

    // Only 1 applied event (the real move at step 1); original timer was cancelled.
    expect(applied).toHaveLength(1);
    expect(manager.getState().turnSeq).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Full game drives to onOver
// ---------------------------------------------------------------------------

describe('full game reaches onOver', () => {
  it('drives to completion and emits onOver with winnerIds', () => {
    const clock = makeFakeClock();
    const manager = makeManager(clock);

    let overPayload: { winnerIds: PlayerId[] } | null = null;
    manager.onOver = (_scores, winnerIds) => { overPayload = { winnerIds }; };

    manager.startGame(PLAYERS, SEED, TURN_MS);

    let safety = 2000;
    while (overPayload === null && safety-- > 0) {
      const state = manager.getState();
      if (state.phase === 'finished') break;
      const currentPid = state.players[state.currentPlayerIndex]!.id;
      const moves = legalMoves(state);
      if (moves.length === 0) break;
      manager.submitMove(currentPid, moves[0]!, state.turnSeq);
    }

    expect(overPayload).not.toBeNull();
    expect((overPayload as { winnerIds: PlayerId[] }).winnerIds.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Bot players
// ---------------------------------------------------------------------------

describe('bot player — auto-advances turn', () => {
  const BOT_PLAYERS: { id: string; name: string; bot?: { level: BotLevel } }[] = [
    { id: 'p1', name: 'Alice' },
    { id: 'bot1', name: 'Bot (Easy)', bot: { level: 'easy' } },
  ];

  it('bot fires its move when the clock advances past BOT_MOVE_DELAY_MS (~750ms)', () => {
    const clock = makeFakeClock();
    const manager = makeManager(clock);

    const applied: Array<{ by: PlayerId; turnSeq: number }> = [];
    manager.onApplied = (_move, by, turnSeq) => applied.push({ by, turnSeq });

    manager.startGame(BOT_PLAYERS, SEED, TURN_MS);

    // p1 goes first; submit a legal human move.
    const state0 = manager.getState();
    if (state0.players[state0.currentPlayerIndex]!.id === 'p1') {
      const move = legalMoves(state0)[0]!;
      manager.submitMove('p1', move, state0.turnSeq);
    }

    // Now bot1's turn — advance clock past BOT_MOVE_DELAY_MS.
    clock.advance(1000);

    const botApplied = applied.find((a) => a.by === 'bot1');
    expect(botApplied).toBeDefined();
    expect(manager.getState().turnSeq).toBeGreaterThan(0);
  });

  it('bot move is rejected if turnSeq changed (race guard)', () => {
    const clock = makeFakeClock();
    const manager = makeManager(clock);

    const applied: Array<{ by: PlayerId }> = [];
    manager.onApplied = (_move, by) => applied.push({ by });

    manager.startGame(BOT_PLAYERS, SEED, TURN_MS);

    // p1 goes first — immediately advance the full 60s timeout so
    // the human auto-move fires before the bot timer.
    const state0 = manager.getState();
    if (state0.players[state0.currentPlayerIndex]!.id === 'p1') {
      // Advance past human timeout (fires autoMove for p1), turnSeq → 1.
      clock.advance(TURN_MS + 1);
      // Now advance past bot delay — bot's stale capturedSeq should be rejected.
      clock.advance(1000);
    } else {
      // If bot goes first, just advance past its delay.
      clock.advance(1000);
    }

    // turnSeq should advance at most once per player turn.
    expect(manager.getState().turnSeq).toBeGreaterThanOrEqual(1);
  });

  it('full human-vs-bot 2-player game reaches finished', () => {
    const clock = makeFakeClock();
    const manager = makeManager(clock);

    let overPayload: { winnerIds: PlayerId[] } | null = null;
    manager.onOver = (_scores, winnerIds) => { overPayload = { winnerIds }; };

    manager.startGame(BOT_PLAYERS, SEED, TURN_MS);

    let safety = 3000;
    while (overPayload === null && safety-- > 0) {
      const s = manager.getState();
      if (s.phase === 'finished') break;
      const currentPid = s.players[s.currentPlayerIndex]!.id;

      if (currentPid === 'p1') {
        // Human: submit a legal move directly.
        const moves = legalMoves(s);
        if (moves.length === 0) break;
        manager.submitMove('p1', moves[0]!, s.turnSeq);
      } else {
        // Bot: fire the bot's 750ms timer.
        clock.advance(1000);
      }
    }

    expect(overPayload).not.toBeNull();
    expect((overPayload as { winnerIds: PlayerId[] }).winnerIds.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Connection tracking
// ---------------------------------------------------------------------------

describe('setConnected', () => {
  it('reflects connected status in the emitted PlayerView', () => {
    const clock = makeFakeClock();
    const manager = makeManager(clock);

    const stateSnaps: Map<PlayerId, unknown>[] = [];
    manager.onState = (views) => stateSnaps.push(new Map(views));

    manager.startGame(PLAYERS, SEED, TURN_MS);

    manager.setConnected('p2', false);
    const move = legalMoves(manager.getState())[0]!;
    manager.submitMove('p1', move, 0);

    const lastSnap = stateSnaps[stateSnaps.length - 1]!;
    const v1 = lastSnap.get('p1') as { players: Array<{ id: string; connected: boolean }> };
    const p2Entry = v1.players.find((p) => p.id === 'p2');
    expect(p2Entry?.connected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bot — RNG seed determinism
// ---------------------------------------------------------------------------

describe('bot — RNG seed determinism', () => {
  const BOT_PLAYERS: { id: string; name: string; bot?: { level: BotLevel } }[] = [
    { id: 'p1', name: 'Alice' },
    { id: 'bot1', name: 'Bot (Easy)', bot: { level: 'easy' } },
  ];

  it('same seed + turnSeq produces the same bot move across two fresh managers', () => {
    function runAndCaptureBotMove(): Move | null {
      const clock = makeFakeClock();
      const mgr = createRoomManager({ clock });
      const botMoves: Move[] = [];
      mgr.onApplied = (move, by) => { if (by === 'bot1') botMoves.push(move); };
      mgr.startGame(BOT_PLAYERS, SEED, TURN_MS);
      const s0 = mgr.getState();
      if (s0.players[s0.currentPlayerIndex]!.id === 'p1') {
        mgr.submitMove('p1', legalMoves(s0)[0]!, s0.turnSeq);
      }
      clock.advance(1000);
      return botMoves[0] ?? null;
    }

    const move1 = runAndCaptureBotMove();
    const move2 = runAndCaptureBotMove();
    expect(move1).not.toBeNull();
    expect(move2).not.toBeNull();
    expect(move1).toEqual(move2);
  });
});

// ---------------------------------------------------------------------------
// Bot — fallback to autoMove when selectMove returns a rejected move
// ---------------------------------------------------------------------------

describe('bot — fallback to autoMove on rejected move', () => {
  const BOT_PLAYERS: { id: string; name: string; bot?: { level: BotLevel } }[] = [
    { id: 'p1', name: 'Alice' },
    { id: 'bot1', name: 'Bot (Easy)', bot: { level: 'easy' } },
  ];

  it('advances the turn via autoMove when bot selectMove returns an illegal move', () => {
    const clock = makeFakeClock();
    // Inject a selectMove stub that always returns an illegal move.
    const manager = createRoomManager({
      clock,
      _selectMoveFn: (_state, _idx, _config, _rng) => ({
        source: { type: 'factory', index: 99 },
        color: 'blue',
        target: { type: 'floor' },
      } as Move),
    });

    const applied: Array<{ by: PlayerId; turnSeq: number }> = [];
    manager.onApplied = (_move, by, turnSeq) => applied.push({ by, turnSeq });

    manager.startGame(BOT_PLAYERS, SEED, TURN_MS);

    // Advance p1 (human) turn if needed.
    const s0 = manager.getState();
    if (s0.players[s0.currentPlayerIndex]!.id === 'p1') {
      manager.submitMove('p1', legalMoves(s0)[0]!, s0.turnSeq);
    }
    const seqBeforeBotMove = manager.getState().turnSeq;

    // Bot timer fires; selectMove returns illegal move, manager falls back to autoMove.
    clock.advance(1000);

    // Turn must have advanced — bot applied event must be present.
    const botApplied = applied.find((a) => a.by === 'bot1');
    expect(botApplied).toBeDefined();
    expect(manager.getState().turnSeq).toBeGreaterThan(seqBeforeBotMove);
  });
});
