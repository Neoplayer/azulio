// ---------------------------------------------------------------------------
// @azul/server — roomManager.ts
// Orchestrates one game over the pure engine: turn timers, turnSeq race-guard,
// auto-move on timeout, phase progression, and per-player views.
// Transport-agnostic — emits plain data via callbacks; no sockets here.
// ---------------------------------------------------------------------------

import {
  createGame,
  isLegalMove,
  isOfferPhaseOver,
  resolveTiling,
  isGameOver,
  startNextRound,
  finalizeScores,
  autoMove,
  toPlayerView,
  applyMove,
} from '@azul/engine';
import type { GameState, Move, PlayerId, PlayerView } from '@azul/shared';
import type {
  Clock,
  RoomManager,
  OnStateCallback,
  OnTurnCallback,
  OnAppliedCallback,
  OnOverCallback,
} from './types.js';
import { realClock } from './types.js';

export interface RoomManagerOptions {
  clock?: Clock;
}

// ---------------------------------------------------------------------------
// createRoomManager
// ---------------------------------------------------------------------------

export function createRoomManager(options: RoomManagerOptions = {}): RoomManager {
  const clock: Clock = options.clock ?? realClock;

  // Game state — null until startGame() is called.
  let state: GameState | null = null;
  let turnMs = 60_000;

  // Current turn timer handle.
  let timerHandle: ReturnType<typeof setTimeout> | null = null;

  // Connection tracking: playerId → connected.
  const connectedMap = new Map<PlayerId, boolean>();

  // ---------------------------------------------------------------------------
  // Callbacks — stored on the returned manager object directly.
  // Internal functions read them via `mgr.onXxx` so gateway assignments are
  // picked up without any getter/setter trickery.
  // ---------------------------------------------------------------------------

  // Forward declaration so internal functions can reference `mgr`.
  // eslint-disable-next-line prefer-const
  let mgr: RoomManager;

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  function connectedSet(): ReadonlySet<PlayerId> {
    const ids = new Set<PlayerId>();
    for (const [id, connected] of connectedMap) {
      if (connected) ids.add(id);
    }
    return ids;
  }

  function emitState(s: GameState): void {
    if (!mgr.onState) return;
    const connected = connectedSet();
    const views = new Map<PlayerId, PlayerView>();
    for (const player of s.players) {
      views.set(player.id, toPlayerView(s, player.id, connected));
    }
    mgr.onState(views);
  }

  function cancelTimer(): void {
    if (timerHandle !== null) {
      clock.clearTimeout(timerHandle);
      timerHandle = null;
    }
  }

  function scheduleTimer(s: GameState): number {
    const deadline = clock.now() + turnMs;
    const capturedSeq = s.turnSeq;

    timerHandle = clock.setTimeout(() => {
      // Race guard: only fire if turnSeq hasn't changed.
      if (state === null || state.turnSeq !== capturedSeq) return;
      const currentPid = state.players[state.currentPlayerIndex]!.id;
      const move = autoMove(state);
      submitMove(currentPid, move, capturedSeq);
    }, turnMs);

    return deadline;
  }

  function advancePhase(s: GameState): GameState {
    if (s.phase === 'offer' && isOfferPhaseOver(s)) {
      s = resolveTiling(s);
      if (isGameOver(s)) {
        s = finalizeScores(s);
      } else {
        s = startNextRound(s);
      }
    }
    return s;
  }

  function applyAndAdvance(s: GameState, move: Move, byPlayerId: PlayerId): void {
    cancelTimer();

    s = applyMove(s, move);
    const appliedSeq = s.turnSeq;

    if (mgr.onApplied) mgr.onApplied(move, byPlayerId, appliedSeq);

    s = advancePhase(s);
    state = s;

    if (s.phase === 'finished') {
      emitState(s);
      if (mgr.onOver) {
        const scores = s.players.map((p) => ({ playerId: p.id, score: p.board.score }));
        mgr.onOver(scores, s.winnerIds ?? []);
      }
    } else {
      const deadline = scheduleTimer(s);
      emitState(s);
      const currentPid = s.players[s.currentPlayerIndex]!.id;
      if (mgr.onTurn) mgr.onTurn(currentPid, deadline);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function startGame(
    playerInfos: { id: string; name: string }[],
    seed: number,
    turnMsParam: number,
  ): void {
    turnMs = turnMsParam;
    connectedMap.clear();
    for (const p of playerInfos) connectedMap.set(p.id, true);

    state = createGame(playerInfos, seed);

    emitState(state);
    const deadline = scheduleTimer(state);
    const currentPid = state.players[state.currentPlayerIndex]!.id;
    if (mgr.onTurn) mgr.onTurn(currentPid, deadline);
  }

  function submitMove(
    playerId: PlayerId,
    move: Move,
    expectedTurnSeq: number,
  ): string | null {
    if (state === null) return 'Game not started';

    if (expectedTurnSeq !== state.turnSeq) {
      return `Stale move: expected turnSeq ${state.turnSeq}, got ${expectedTurnSeq}`;
    }

    const currentPid = state.players[state.currentPlayerIndex]!.id;
    if (playerId !== currentPid) {
      return `Not your turn: current player is ${currentPid}`;
    }

    if (!isLegalMove(state, move)) return 'Illegal move';

    applyAndAdvance(state, move, playerId);
    return null;
  }

  function setConnected(playerId: PlayerId, connected: boolean): void {
    connectedMap.set(playerId, connected);
  }

  function getState(): GameState {
    if (state === null) throw new Error('Game not started');
    return state;
  }

  function dispose(): void {
    cancelTimer();
  }

  // Assign mgr — internal helpers already reference it via closure.
  mgr = {
    startGame,
    submitMove,
    setConnected,
    getState,
    dispose,
    onState: null,
    onTurn: null,
    onApplied: null,
    onOver: null,
  };

  return mgr;
}
