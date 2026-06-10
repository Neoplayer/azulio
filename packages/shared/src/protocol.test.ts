// ---------------------------------------------------------------------------
// @azul/shared — protocol.test.ts
// Tests for zod WS schemas and parseClientMessage. Run:
//   npx vitest run packages/shared/src/protocol.test.ts
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import {
  parseClientMessage,
  ClientMessageSchema,
  ServerMessageSchema,
  type ClientMessage,
  type ServerMessage,
  type Room,
} from './protocol.js';

// ---------------------------------------------------------------------------
// parseClientMessage — valid round-trips
// ---------------------------------------------------------------------------

describe('parseClientMessage — valid messages', () => {
  it('parses a hello message', () => {
    const raw = { type: 'hello', token: 'tok-abc' };
    const msg = parseClientMessage(raw);
    expect(msg.type).toBe('hello');
    if (msg.type === 'hello') {
      expect(msg.token).toBe('tok-abc');
      expect(msg.roomId).toBeUndefined();
    }
  });

  it('parses hello with optional roomId', () => {
    const raw = { type: 'hello', token: 'tok-abc', roomId: 'room-1' };
    const msg = parseClientMessage(raw);
    expect(msg.type).toBe('hello');
    if (msg.type === 'hello') {
      expect(msg.roomId).toBe('room-1');
    }
  });

  it('parses lobby:subscribe', () => {
    const msg = parseClientMessage({ type: 'lobby:subscribe' });
    expect(msg.type).toBe('lobby:subscribe');
  });

  it('parses ping', () => {
    const msg = parseClientMessage({ type: 'ping' });
    expect(msg.type).toBe('ping');
  });

  it('parses room:create with valid maxPlayers', () => {
    const raw = { type: 'room:create', name: 'My Room', maxPlayers: 4, isPrivate: false };
    const msg = parseClientMessage(raw);
    expect(msg.type).toBe('room:create');
    if (msg.type === 'room:create') {
      expect(msg.name).toBe('My Room');
      expect(msg.maxPlayers).toBe(4);
      expect(msg.isPrivate).toBe(false);
    }
  });

  it('parses room:join', () => {
    const msg = parseClientMessage({ type: 'room:join', roomId: 'room-42' });
    expect(msg.type).toBe('room:join');
    if (msg.type === 'room:join') {
      expect(msg.roomId).toBe('room-42');
    }
  });

  it('parses room:leave', () => {
    const msg = parseClientMessage({ type: 'room:leave', roomId: 'room-42' });
    expect(msg.type).toBe('room:leave');
  });

  it('parses room:start', () => {
    const msg = parseClientMessage({ type: 'room:start', roomId: 'room-42' });
    expect(msg.type).toBe('room:start');
  });

  it('parses game:move with factory source and patternLine target', () => {
    const raw = {
      type: 'game:move',
      move: {
        source: { type: 'factory', index: 2 },
        color: 'blue',
        target: { type: 'patternLine', row: 0 },
      },
      expectedTurnSeq: 5,
    };
    const msg = parseClientMessage(raw);
    expect(msg.type).toBe('game:move');
    if (msg.type === 'game:move') {
      expect(msg.expectedTurnSeq).toBe(5);
      expect(msg.move.color).toBe('blue');
    }
  });

  it('parses game:move with center source and floor target', () => {
    const raw = {
      type: 'game:move',
      move: {
        source: { type: 'center' },
        color: 'red',
        target: { type: 'floor' },
      },
      expectedTurnSeq: 0,
    };
    const msg = parseClientMessage(raw);
    expect(msg.type).toBe('game:move');
  });

  it('round-trips a valid message through ClientMessageSchema', () => {
    const raw = { type: 'room:join', roomId: 'x' };
    const parsed = ClientMessageSchema.parse(raw);
    expect(parsed).toEqual(raw);
  });
});

// ---------------------------------------------------------------------------
// parseClientMessage — rejection cases
// ---------------------------------------------------------------------------

describe('parseClientMessage — invalid messages are rejected', () => {
  it('rejects unknown type', () => {
    expect(() => parseClientMessage({ type: 'unknown:event' })).toThrow();
  });

  it('rejects message with no type field', () => {
    expect(() => parseClientMessage({ roomId: 'x' })).toThrow();
  });

  it('rejects game:move with missing expectedTurnSeq', () => {
    const raw = {
      type: 'game:move',
      move: {
        source: { type: 'factory', index: 0 },
        color: 'blue',
        target: { type: 'floor' },
      },
    };
    expect(() => parseClientMessage(raw)).toThrow();
  });

  it('rejects game:move with non-number expectedTurnSeq', () => {
    const raw = {
      type: 'game:move',
      move: {
        source: { type: 'center' },
        color: 'blue',
        target: { type: 'floor' },
      },
      expectedTurnSeq: 'five',
    };
    expect(() => parseClientMessage(raw)).toThrow();
  });

  it('rejects game:move with invalid color', () => {
    const raw = {
      type: 'game:move',
      move: {
        source: { type: 'center' },
        color: 'purple',
        target: { type: 'floor' },
      },
      expectedTurnSeq: 1,
    };
    expect(() => parseClientMessage(raw)).toThrow();
  });

  it('rejects game:move with patternLine row = 5 (out of bounds)', () => {
    const raw = {
      type: 'game:move',
      move: {
        source: { type: 'factory', index: 0 },
        color: 'yellow',
        target: { type: 'patternLine', row: 5 },
      },
      expectedTurnSeq: 2,
    };
    expect(() => parseClientMessage(raw)).toThrow();
  });

  it('rejects game:move with negative row', () => {
    const raw = {
      type: 'game:move',
      move: {
        source: { type: 'factory', index: 0 },
        color: 'black',
        target: { type: 'patternLine', row: -1 },
      },
      expectedTurnSeq: 2,
    };
    expect(() => parseClientMessage(raw)).toThrow();
  });

  it('rejects room:create with maxPlayers = 1', () => {
    expect(() =>
      parseClientMessage({ type: 'room:create', name: 'x', maxPlayers: 1, isPrivate: false }),
    ).toThrow();
  });

  it('rejects room:create with maxPlayers = 5', () => {
    expect(() =>
      parseClientMessage({ type: 'room:create', name: 'x', maxPlayers: 5, isPrivate: false }),
    ).toThrow();
  });

  it('rejects null input', () => {
    expect(() => parseClientMessage(null)).toThrow();
  });

  it('rejects non-object input', () => {
    expect(() => parseClientMessage('hello')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ServerMessageSchema — smoke test (parsed server messages are typed)
// ---------------------------------------------------------------------------

describe('ServerMessageSchema — valid server messages parse correctly', () => {
  it('parses hello:ok', () => {
    const msg = ServerMessageSchema.parse({ type: 'hello:ok', playerId: 'p1' });
    expect(msg.type).toBe('hello:ok');
  });

  it('parses pong', () => {
    const msg = ServerMessageSchema.parse({ type: 'pong' });
    expect(msg.type).toBe('pong');
  });

  it('parses session:invalid', () => {
    const msg = ServerMessageSchema.parse({ type: 'session:invalid' });
    expect(msg.type).toBe('session:invalid');
  });

  it('parses game:aborted', () => {
    const msg = ServerMessageSchema.parse({ type: 'game:aborted', reason: 'server restart' });
    expect(msg.type).toBe('game:aborted');
    if (msg.type === 'game:aborted') {
      expect(msg.reason).toBe('server restart');
    }
  });

  it('parses error', () => {
    const msg = ServerMessageSchema.parse({ type: 'error', code: 'ILLEGAL_MOVE', message: 'bad move' });
    expect(msg.type).toBe('error');
    if (msg.type === 'error') {
      expect(msg.code).toBe('ILLEGAL_MOVE');
    }
  });

  it('parses game:turn', () => {
    const msg = ServerMessageSchema.parse({
      type: 'game:turn',
      currentPlayerId: 'p1',
      deadline: 1700000000000,
    });
    expect(msg.type).toBe('game:turn');
  });

  it('parses player:connection', () => {
    const msg = ServerMessageSchema.parse({
      type: 'player:connection',
      playerId: 'p2',
      connected: false,
    });
    expect(msg.type).toBe('player:connection');
    if (msg.type === 'player:connection') {
      expect(msg.connected).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Type-level checks — ensure exported union types exist and are usable
// ---------------------------------------------------------------------------

describe('type exports', () => {
  it('ClientMessage is a discriminated union (type-level smoke test)', () => {
    // This is mainly a TS compile-time check; just assert the parser works.
    const msg: ClientMessage = parseClientMessage({ type: 'ping' });
    expect(msg.type).toBe('ping');
  });

  it('Room interface shape is exported', () => {
    // Construct a Room-shaped object and assert presence of expected fields.
    const room: Room = {
      id: 'r1',
      name: 'Test Room',
      hostId: 'p1',
      maxPlayers: 2,
      players: [{ id: 'p1', name: 'Alice' }],
      status: 'waiting',
      isPrivate: false,
      createdAt: new Date().toISOString(),
    };
    expect(room.status).toBe('waiting');
  });
});
