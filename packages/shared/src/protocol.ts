// ---------------------------------------------------------------------------
// @azul/shared — protocol.ts
// Zod schemas and inferred TypeScript types for the WebSocket wire protocol.
// All client→server and server→client messages are discriminated unions on
// the `type` field. parseClientMessage validates incoming raw data at runtime.
// ---------------------------------------------------------------------------

import { z } from 'zod';

// Inline the colour list to avoid a circular-import with index.ts
// (index.ts re-exports everything from protocol.ts, so protocol.ts must
// not import from index.ts at module evaluation time).
const COLORS = ['blue', 'yellow', 'red', 'black', 'white'] as const;

// ---------------------------------------------------------------------------
// Bot types — defined locally to avoid a shared→engine dependency cycle.
// ---------------------------------------------------------------------------

/**
 * AI difficulty level. Mirrors the same type in @azul/engine/bot/types.ts (structurally identical).
 * Kept separate to avoid a shared↔engine dependency cycle.
 * The compile-time mutual-assignability guard lives in packages/engine/src/bot/bot-types.test.ts.
 */
export type BotLevel = 'easy' | 'medium' | 'hard';
const BotLevelSchema = z.enum(['easy', 'medium', 'hard']);

// ---------------------------------------------------------------------------
// Reusable sub-schemas (shared between client and server messages)
// ---------------------------------------------------------------------------

const ColorSchema = z.enum(COLORS);

/** Move source: either a specific factory display or the centre pool. */
const MoveSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('factory'), index: z.number().int().nonnegative() }),
  z.object({ type: z.literal('center') }),
]);

/** Move target: a pattern line row (0–4) or the floor line. */
const MoveTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('patternLine'), row: z.number().int().min(0).max(4) }),
  z.object({ type: z.literal('floor') }),
]);

/** A single game move intent (mirrors the Move domain type). */
const MoveSchema = z.object({
  source: MoveSourceSchema,
  color: ColorSchema,
  target: MoveTargetSchema,
});

// ---------------------------------------------------------------------------
// Room interface (used in lobby payloads)
// ---------------------------------------------------------------------------

/**
 * A lobby room record, shared between the Room repository and the wire
 * protocol. `createdAt` is an ISO-8601 timestamp string.
 */
export interface Room {
  id: string;
  name: string;
  hostId: string;
  maxPlayers: number;
  players: { id: string; name: string; bot?: { level: BotLevel } }[];
  status: 'waiting' | 'playing' | 'finished';
  isPrivate: boolean;
  createdAt: string;
}

const RoomPlayerSchema = z.object({
  id: z.string(),
  name: z.string(),
  bot: z.object({ level: BotLevelSchema }).optional(),
});

const RoomSchema = z.object({
  id: z.string(),
  name: z.string(),
  hostId: z.string(),
  maxPlayers: z.number().int().min(2).max(4),
  players: z.array(RoomPlayerSchema),
  status: z.enum(['waiting', 'playing', 'finished']),
  isPrivate: z.boolean(),
  createdAt: z.string(),
});

// ---------------------------------------------------------------------------
// Client → Server message schemas
// ---------------------------------------------------------------------------

const HelloSchema = z.object({
  type: z.literal('hello'),
  /** Auth/reconnect token stored in localStorage. */
  token: z.string(),
  /** Present on reconnect to a specific room. */
  roomId: z.string().optional(),
});

const LobbySubscribeSchema = z.object({
  type: z.literal('lobby:subscribe'),
});

const RoomCreateSchema = z.object({
  type: z.literal('room:create'),
  name: z.string().min(1),
  /** 2–4 players per Azul rules. */
  maxPlayers: z.number().int().min(2).max(4),
  isPrivate: z.boolean(),
});

const RoomJoinSchema = z.object({
  type: z.literal('room:join'),
  roomId: z.string(),
});

const RoomLeaveSchema = z.object({
  type: z.literal('room:leave'),
  roomId: z.string(),
});

const RoomStartSchema = z.object({
  type: z.literal('room:start'),
  roomId: z.string(),
});

const GameMoveSchema = z.object({
  type: z.literal('game:move'),
  move: MoveSchema,
  /**
   * Client echoes the current turnSeq. Server rejects the move if this
   * doesn't match, preventing double-tap / stale-move races.
   */
  expectedTurnSeq: z.number().int(),
});

const PingSchema = z.object({
  type: z.literal('ping'),
});

const RoomAddBotSchema = z.object({
  type: z.literal('room:addBot'),
  roomId: z.string(),
  level: BotLevelSchema,
});

/**
 * Discriminated union of every valid client→server message.
 * The `type` field is the discriminant.
 */
export const ClientMessageSchema = z.discriminatedUnion('type', [
  HelloSchema,
  LobbySubscribeSchema,
  RoomCreateSchema,
  RoomJoinSchema,
  RoomLeaveSchema,
  RoomStartSchema,
  GameMoveSchema,
  PingSchema,
  RoomAddBotSchema,
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---------------------------------------------------------------------------
// Server → Client message schemas
// ---------------------------------------------------------------------------

// PlayerView is a complex nested type from index.ts. For the wire-protocol
// schema we use z.unknown() as a pass-through because the engine already
// constructs and validates this shape; the schema is a structural placeholder
// that lets other workers type the payload correctly via the exported
// PlayerView interface from index.ts.
const PlayerViewSchema = z.unknown();

const HelloOkSchema = z.object({
  type: z.literal('hello:ok'),
  playerId: z.string(),
});

const LobbyStateSchema = z.object({
  type: z.literal('lobby:state'),
  rooms: z.array(RoomSchema),
});

const RoomStateSchema = z.object({
  type: z.literal('room:state'),
  room: RoomSchema,
});

const GameStateSchema = z.object({
  type: z.literal('game:state'),
  /** Redacted PlayerView — built by engine.toPlayerView(). */
  view: PlayerViewSchema,
});

const GameTurnSchema = z.object({
  type: z.literal('game:turn'),
  currentPlayerId: z.string(),
  /** Unix-ms deadline timestamp (server clock). */
  deadline: z.number(),
});

const GameAppliedSchema = z.object({
  type: z.literal('game:applied'),
  move: MoveSchema,
  /** PlayerId that made the move. */
  by: z.string(),
  turnSeq: z.number().int(),
});

const GameOverSchema = z.object({
  type: z.literal('game:over'),
  scores: z.array(z.object({ playerId: z.string(), score: z.number() })),
  winnerIds: z.array(z.string()),
});

const GameAbortedSchema = z.object({
  type: z.literal('game:aborted'),
  reason: z.string(),
});

const PlayerConnectionSchema = z.object({
  type: z.literal('player:connection'),
  playerId: z.string(),
  connected: z.boolean(),
});

const SessionInvalidSchema = z.object({
  type: z.literal('session:invalid'),
});

const PongSchema = z.object({
  type: z.literal('pong'),
});

const ErrorSchema = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
});

/**
 * Discriminated union of every valid server→client message.
 * The `type` field is the discriminant.
 */
export const ServerMessageSchema = z.discriminatedUnion('type', [
  HelloOkSchema,
  LobbyStateSchema,
  RoomStateSchema,
  GameStateSchema,
  GameTurnSchema,
  GameAppliedSchema,
  GameOverSchema,
  GameAbortedSchema,
  PlayerConnectionSchema,
  SessionInvalidSchema,
  PongSchema,
  ErrorSchema,
]);

export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// ---------------------------------------------------------------------------
// parseClientMessage — public entry point used by the WS gateway
// ---------------------------------------------------------------------------

/**
 * Parse and validate a raw (unknown) WebSocket message as a ClientMessage.
 * Throws a ZodError with descriptive path/message info on any validation
 * failure (invalid type, missing fields, out-of-range values, etc.).
 *
 * @param raw  Anything — typically `JSON.parse(ws.data)` output.
 * @returns    A fully-typed ClientMessage discriminated union value.
 */
export function parseClientMessage(raw: unknown): ClientMessage {
  return ClientMessageSchema.parse(raw);
}
