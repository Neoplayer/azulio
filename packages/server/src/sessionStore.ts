// ---------------------------------------------------------------------------
// @azul/server — sessionStore.ts
// In-memory session store for guest login / reconnect.
// ---------------------------------------------------------------------------

import type { PlayerId } from '@azul/shared';
import type { Session, SessionStore } from './types.js';

export type { Session, SessionStore };

export interface SessionStoreOptions {
  /** Injectable factory for player ids; defaults to crypto.randomUUID(). */
  idFactory?: () => string;
  /** Injectable factory for tokens; defaults to crypto.randomUUID(). */
  tokenFactory?: () => string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class InMemorySessionStoreImpl implements SessionStore {
  private readonly byToken = new Map<string, Session & { roomId?: string }>();
  private readonly playerIndex = new Map<PlayerId, string>();

  private readonly idFactory: () => string;
  private readonly tokenFactory: () => string;

  constructor(options: SessionStoreOptions = {}) {
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.tokenFactory = options.tokenFactory ?? (() => crypto.randomUUID());
  }

  createSession(name: string): { playerId: PlayerId; token: string } {
    const playerId = this.idFactory();
    const token = this.tokenFactory();
    const session: Session & { roomId?: string } = { playerId, name, token };
    this.byToken.set(token, session);
    this.playerIndex.set(playerId, token);
    return { playerId, token };
  }

  getByToken(token: string): (Session & { roomId?: string }) | null {
    return this.byToken.get(token) ?? null;
  }

  getByPlayerId(playerId: PlayerId): (Session & { roomId?: string }) | null {
    const token = this.playerIndex.get(playerId);
    if (token === undefined) return null;
    return this.byToken.get(token) ?? null;
  }

  bindRoom(token: string, roomId: string): void {
    const session = this.byToken.get(token);
    if (session === undefined) {
      throw new Error(`bindRoom: unknown token "${token}"`);
    }
    session.roomId = roomId;
  }

  unbindRoom(token: string): void {
    const session = this.byToken.get(token);
    if (session === undefined) {
      throw new Error(`unbindRoom: unknown token "${token}"`);
    }
    delete session.roomId;
  }
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

/** Class export for use in main.ts: `new InMemorySessionStore()`. */
export class InMemorySessionStore extends InMemorySessionStoreImpl {}

/**
 * Factory function for use in tests — allows injecting deterministic
 * id/token factories without `new`.
 */
export function createSessionStore(options: SessionStoreOptions = {}): SessionStore {
  return new InMemorySessionStoreImpl(options);
}
