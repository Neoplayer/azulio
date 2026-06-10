// ---------------------------------------------------------------------------
// @azul/server — sessionStore.test.ts
// Run: npx vitest run packages/server/src/sessionStore.test.ts
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from 'vitest';
import { createSessionStore } from './sessionStore.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic id factory for reproducible tests. */
function makeCounter(prefix: string) {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

describe('createSession', () => {
  it('returns a playerId and token', () => {
    const store = createSessionStore();
    const result = store.createSession('Alice');
    expect(result.playerId).toBeTruthy();
    expect(result.token).toBeTruthy();
  });

  it('returns distinct ids and tokens for different calls', () => {
    const store = createSessionStore();
    const a = store.createSession('Alice');
    const b = store.createSession('Bob');
    expect(a.playerId).not.toBe(b.playerId);
    expect(a.token).not.toBe(b.token);
  });

  it('uses the injected id factory for deterministic ids in tests', () => {
    const idFactory = makeCounter('id');
    const tokenFactory = makeCounter('tok');
    const store = createSessionStore({ idFactory, tokenFactory });
    const r1 = store.createSession('Alice');
    const r2 = store.createSession('Bob');
    // idFactory and tokenFactory are independent counters
    expect(r1.playerId).toBe('id-1');
    expect(r1.token).toBe('tok-1');
    expect(r2.playerId).toBe('id-2');
    expect(r2.token).toBe('tok-2');
  });
});

// ---------------------------------------------------------------------------
// getByToken
// ---------------------------------------------------------------------------

describe('getByToken', () => {
  it('returns the session after createSession', () => {
    const store = createSessionStore();
    const { playerId, token } = store.createSession('Alice');
    const session = store.getByToken(token);
    expect(session).not.toBeNull();
    expect(session!.playerId).toBe(playerId);
    expect(session!.name).toBe('Alice');
    expect(session!.token).toBe(token);
  });

  it('returns null for an unknown token', () => {
    const store = createSessionStore();
    expect(store.getByToken('no-such-token')).toBeNull();
  });

  it('does not expose roomId initially', () => {
    const store = createSessionStore();
    const { token } = store.createSession('Alice');
    const session = store.getByToken(token);
    expect(session!.roomId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getByPlayerId
// ---------------------------------------------------------------------------

describe('getByPlayerId', () => {
  it('returns the session by playerId', () => {
    const store = createSessionStore();
    const { playerId, token } = store.createSession('Charlie');
    const session = store.getByPlayerId(playerId);
    expect(session).not.toBeNull();
    expect(session!.token).toBe(token);
  });

  it('returns null for unknown playerId', () => {
    const store = createSessionStore();
    expect(store.getByPlayerId('ghost')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// bindRoom / unbindRoom
// ---------------------------------------------------------------------------

describe('bindRoom', () => {
  it('sets roomId on the session', () => {
    const store = createSessionStore();
    const { token } = store.createSession('Alice');
    store.bindRoom(token, 'room-1');
    const session = store.getByToken(token);
    expect(session!.roomId).toBe('room-1');
  });

  it('overwrites a previous roomId', () => {
    const store = createSessionStore();
    const { token } = store.createSession('Alice');
    store.bindRoom(token, 'room-1');
    store.bindRoom(token, 'room-2');
    expect(store.getByToken(token)!.roomId).toBe('room-2');
  });

  it('throws for an unknown token', () => {
    const store = createSessionStore();
    expect(() => store.bindRoom('no-such', 'room-1')).toThrow();
  });
});

describe('unbindRoom', () => {
  it('clears roomId from the session', () => {
    const store = createSessionStore();
    const { token } = store.createSession('Alice');
    store.bindRoom(token, 'room-1');
    store.unbindRoom(token);
    expect(store.getByToken(token)!.roomId).toBeUndefined();
  });

  it('is a no-op for a session with no roomId', () => {
    const store = createSessionStore();
    const { token } = store.createSession('Alice');
    expect(() => store.unbindRoom(token)).not.toThrow();
    expect(store.getByToken(token)!.roomId).toBeUndefined();
  });

  it('throws for an unknown token', () => {
    const store = createSessionStore();
    expect(() => store.unbindRoom('ghost')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Isolation: stores are independent
// ---------------------------------------------------------------------------

describe('store isolation', () => {
  it('two stores do not share state', () => {
    const a = createSessionStore();
    const b = createSessionStore();
    const { token } = a.createSession('Alice');
    expect(b.getByToken(token)).toBeNull();
  });
});
