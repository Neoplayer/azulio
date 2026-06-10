// ---------------------------------------------------------------------------
// types.ts — Server-internal interfaces for injectable dependencies.
// These are implemented by worker-2 (sessionStore, RoomRepository, RoomManager).
// ---------------------------------------------------------------------------

import type { Move, GameState, PlayerId, PlayerView } from '@azul/shared';

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

export interface Session {
  playerId: PlayerId;
  token: string;
  name: string;
}

export interface SessionStore {
  createSession(name: string): { playerId: PlayerId; token: string };
  getByToken(token: string): Session | null;
  getByPlayerId(playerId: PlayerId): Session | null;
  bindRoom(token: string, roomId: string): void;
  unbindRoom(token: string): void;
}

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------

export interface RoomPlayer {
  id: PlayerId;
  name: string;
}

export type RoomStatus = 'waiting' | 'playing' | 'finished';

export interface Room {
  id: string;
  name: string;
  hostId: PlayerId;
  maxPlayers: number;
  players: RoomPlayer[];
  status: RoomStatus;
  isPrivate: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Room repository
// ---------------------------------------------------------------------------

export interface RoomRepository {
  create(room: Omit<Room, 'id'>): Room;
  get(id: string): Room | null;
  list(): Room[];
  listWaiting(): Room[];
  update(id: string, patch: Partial<Room>): Room;
  delete(id: string): void;
}

// ---------------------------------------------------------------------------
// Injected clock (for deterministic test control)
// ---------------------------------------------------------------------------

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
};

// ---------------------------------------------------------------------------
// RoomManager events
// ---------------------------------------------------------------------------

/** Full game-state update — each player gets their own private view. */
export type OnStateCallback = (views: Map<PlayerId, PlayerView>) => void;
/** It's a player's turn; deadline is an epoch-ms timestamp. */
export type OnTurnCallback = (currentPlayerId: PlayerId, deadline: number) => void;
/** A move was applied (broadcast to room for animations). */
export type OnAppliedCallback = (move: Move, byPlayerId: PlayerId, turnSeq: number) => void;
/** Game finished. */
export type OnOverCallback = (scores: Array<{ playerId: PlayerId; score: number }>, winnerIds: PlayerId[]) => void;

// ---------------------------------------------------------------------------
// RoomManager — orchestrates one game/room.
// Constructed per room when the host starts the game.
// ---------------------------------------------------------------------------

export interface RoomManager {
  /**
   * Start the game for the given players. Must be called once after callbacks
   * are wired and before submitMove.
   */
  startGame(
    players: { id: string; name: string }[],
    seed: number,
    turnMs: number,
  ): void;

  /**
   * Submit a move from `playerId`. Returns an error string on failure
   * (illegal move, wrong turn, wrong turnSeq) or null on success.
   */
  submitMove(playerId: PlayerId, move: Move, expectedTurnSeq: number): string | null;

  /** Mark a player's connection status. */
  setConnected(playerId: PlayerId, connected: boolean): void;

  /** Get the current game state (for reconnect resend). */
  getState(): GameState;

  /** Registered event callbacks (set by gateway after construction). */
  onState: OnStateCallback | null;
  onTurn: OnTurnCallback | null;
  onApplied: OnAppliedCallback | null;
  onOver: OnOverCallback | null;

  /** Clean up timers on server close. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// RoomManagerFactory — creates a RoomManager (with injectable clock).
// Caller must wire callbacks, then call startGame().
// Matches createRoomManager(options: { clock?: Clock }) signature.
// ---------------------------------------------------------------------------

export type RoomManagerFactory = (options: { clock?: Clock }) => RoomManager;
