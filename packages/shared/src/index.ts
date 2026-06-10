// ---------------------------------------------------------------------------
// @azul/shared — domain types shared by engine, server and web.
// Single source of truth for the game model and the wire protocol.
// ---------------------------------------------------------------------------

export * from './protocol.js';

export const COLORS = ['blue', 'yellow', 'red', 'black', 'white'] as const;
export type Color = (typeof COLORS)[number];

export type PlayerId = string;

/** Floor-line penalties by slot index (left to right). */
export const FLOOR_PENALTIES = [-1, -1, -2, -2, -2, -3, -3] as const;

/** Tiles per colour in a full set; 5 colours => 100 tiles. */
export const TILES_PER_COLOR = 20;

/** Tiles placed on each factory at the start of a round. */
export const TILES_PER_FACTORY = 4;

/** Number of factory displays by player count (index by player count). */
export const FACTORY_COUNT_BY_PLAYERS: Record<number, number> = {
  2: 5,
  3: 7,
  4: 9,
};

/**
 * Canonical wall colour pattern (row-major, 5x5). Each colour appears exactly
 * once per row and per column (diagonal layout, standard Azul board).
 */
export const WALL_PATTERN: readonly (readonly Color[])[] = [
  ['blue', 'yellow', 'red', 'black', 'white'],
  ['white', 'blue', 'yellow', 'red', 'black'],
  ['black', 'white', 'blue', 'yellow', 'red'],
  ['red', 'black', 'white', 'blue', 'yellow'],
  ['yellow', 'red', 'black', 'white', 'blue'],
];

/** A tile slot on the floor line: either a colour tile or the first-player marker. */
export type FloorSlot = Color | 'FIRST';

export interface PlayerBoard {
  /** 5 pattern lines of capacity 1..5; entries are the colour placed, or null. */
  patternLines: (Color | null)[][];
  /** 5x5 wall; null = not yet tiled, otherwise the colour placed. */
  wall: (Color | null)[][];
  /** Tiles/marker currently on the floor line, in placement order. */
  floor: FloorSlot[];
  score: number;
}

export type GamePhase = 'offer' | 'tiling' | 'finished';

export interface PlayerSlot {
  id: PlayerId;
  name: string;
  board: PlayerBoard;
}

export interface GameState {
  players: PlayerSlot[];
  factories: Color[][];
  center: Color[];
  centerHasFirstToken: boolean;
  bag: Color[];
  discard: Color[];
  currentPlayerIndex: number;
  /** Who starts the next round (set when the first-player marker is taken). */
  firstPlayerIndex: number;
  phase: GamePhase;
  round: number;
  winnerIds: PlayerId[] | null;
  /** Seed for deterministic shuffling / replays. */
  rngSeed: number;
  /** Monotonic move counter; +1 on each applyMove. Used for idempotency. */
  turnSeq: number;
}

export type MoveSource =
  | { type: 'factory'; index: number }
  | { type: 'center' };

export type MoveTarget =
  | { type: 'patternLine'; row: number }
  | { type: 'floor' };

export interface Move {
  source: MoveSource;
  color: Color;
  target: MoveTarget;
}

/**
 * Redacted public view broadcast to a player. The bag composition is hidden
 * (only its count is exposed) to prevent draw-probability cheating.
 */
export interface PlayerView {
  players: (PlayerSlot & { connected: boolean })[];
  factories: Color[][];
  center: Color[];
  centerHasFirstToken: boolean;
  bagCount: number;
  discard: Color[];
  currentPlayerId: PlayerId;
  firstPlayerId: PlayerId;
  phase: GamePhase;
  round: number;
  turnSeq: number;
  you: PlayerId;
  winnerIds: PlayerId[] | null;
}
