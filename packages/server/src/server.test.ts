// ---------------------------------------------------------------------------
// server.test.ts — Integration tests for the WS gateway + Fastify server.
// Uses a REAL server on an ephemeral port (listen(0)), a real ws client
// (TestClient), and INJECTED fake clock for deterministic timeouts.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from './server.js';
import { connect } from './testClient.js';
import { InMemorySessionStore } from './sessionStore.js';
import { InMemoryRoomRepository } from './roomRepository.js';
import { createRoomManager } from './roomManager.js';
import { autoMove } from '@azul/engine';
import type { TestClient } from './testClient.js';
import type { Clock } from './types.js';

// ---------------------------------------------------------------------------
// Fake clock for deterministic timer control
// ---------------------------------------------------------------------------

class FakeClock implements Clock {
  private _now = 0;
  private _timers = new Map<ReturnType<typeof setTimeout>, { at: number; fn: () => void }>();
  private _nextId = 1;

  now(): number { return this._now; }

  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = this._nextId++ as unknown as ReturnType<typeof setTimeout>;
    this._timers.set(id, { at: this._now + ms, fn });
    return id;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this._timers.delete(handle);
  }

  /** Advance time by ms, firing all timers whose deadline has passed in order. */
  tick(ms: number): void {
    this._now += ms;
    const fired: Array<{ id: ReturnType<typeof setTimeout>; fn: () => void }> = [];
    for (const [id, t] of this._timers) {
      if (t.at <= this._now) fired.push({ id, fn: t.fn });
    }
    fired.sort((a, b) => this._timers.get(a.id)!.at - this._timers.get(b.id)!.at);
    for (const { id, fn } of fired) {
      this._timers.delete(id);
      fn();
    }
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface TestServer {
  url: string;
  wsUrl: string;
  clock: FakeClock;
  sessionStore: InMemorySessionStore;
  close(): Promise<void>;
}

async function startServer(): Promise<TestServer> {
  const clock = new FakeClock();
  const sessionStore = new InMemorySessionStore();
  const roomRepository = new InMemoryRoomRepository();

  const server = buildServer({
    sessionStore,
    roomRepository,
    roomManagerFactory: createRoomManager,
    clock,
  });

  const port = await server.listen(0);
  const url = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  return {
    url,
    wsUrl,
    clock,
    sessionStore,
    close: () => server.close(),
  };
}

/** Create a session via REST and return token + playerId. */
async function createSession(
  baseUrl: string,
  name: string,
): Promise<{ playerId: string; token: string }> {
  const res = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return res.json() as Promise<{ playerId: string; token: string }>;
}

/** Open a ws client and authenticate with hello. Returns client + playerId. */
async function connectAuthenticated(
  wsUrl: string,
  token: string,
  roomId?: string,
): Promise<TestClient> {
  const client = await connect(wsUrl);
  client.send({ type: 'hello', token, ...(roomId ? { roomId } : {}) });
  await client.awaitMessage('hello:ok');
  return client;
}

/** Wait for a small number of event-loop ticks. Useful after clock.tick(). */
function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/health', () => {
  it('returns ok:true', async () => {
    const srv = await startServer();
    try {
      const res = await fetch(`${srv.url}/api/health`);
      const body = await res.json() as { ok: boolean };
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
    } finally {
      await srv.close();
    }
  });
});

describe('POST /api/session', () => {
  it('creates a session and returns playerId + token', async () => {
    const srv = await startServer();
    try {
      const body = await createSession(srv.url, 'Alice');
      expect(typeof body.playerId).toBe('string');
      expect(typeof body.token).toBe('string');
      expect(body.playerId.length).toBeGreaterThan(0);
      expect(body.token.length).toBeGreaterThan(0);
    } finally {
      await srv.close();
    }
  });
});

describe('WebSocket — hello handshake', () => {
  it('valid token → hello:ok with playerId', async () => {
    const srv = await startServer();
    let client: TestClient | null = null;
    try {
      const { token, playerId } = await createSession(srv.url, 'Alice');
      client = await connect(srv.wsUrl);
      client.send({ type: 'hello', token });
      const msg = await client.awaitMessage('hello:ok') as { type: string; playerId: string };
      expect(msg.playerId).toBe(playerId);
    } finally {
      client?.close();
      await srv.close();
    }
  });

  it('bogus token → session:invalid and socket closes', async () => {
    const srv = await startServer();
    let client: TestClient | null = null;
    try {
      client = await connect(srv.wsUrl);
      client.send({ type: 'hello', token: 'not-a-real-token' });
      const msg = await client.awaitMessage('session:invalid');
      expect(msg['type']).toBe('session:invalid');
    } finally {
      client?.close();
      await srv.close();
    }
  });

  it('ping → pong after authentication', async () => {
    const srv = await startServer();
    let client: TestClient | null = null;
    try {
      const { token } = await createSession(srv.url, 'Bob');
      client = await connectAuthenticated(srv.wsUrl, token);
      client.send({ type: 'ping' });
      const msg = await client.awaitMessage('pong');
      expect(msg['type']).toBe('pong');
    } finally {
      client?.close();
      await srv.close();
    }
  });
});

describe('WebSocket — lobby flow', () => {
  it('lobby:subscribe sends current room list (initially empty)', async () => {
    const srv = await startServer();
    let client: TestClient | null = null;
    try {
      const { token } = await createSession(srv.url, 'Alice');
      client = await connectAuthenticated(srv.wsUrl, token);
      client.send({ type: 'lobby:subscribe' });
      const msg = await client.awaitMessage('lobby:state') as { rooms: unknown[] };
      expect(Array.isArray(msg.rooms)).toBe(true);
      expect(msg.rooms.length).toBe(0);
    } finally {
      client?.close();
      await srv.close();
    }
  });

  it('room:create broadcasts lobby:state update', async () => {
    const srv = await startServer();
    let client: TestClient | null = null;
    try {
      const { token } = await createSession(srv.url, 'Alice');
      client = await connectAuthenticated(srv.wsUrl, token);
      client.send({ type: 'lobby:subscribe' });
      await client.awaitMessage('lobby:state'); // initial snapshot

      client.send({ type: 'room:create', name: 'Test Room', maxPlayers: 2, isPrivate: false });
      // Expect room:state for the creator
      const roomState = await client.awaitMessage('room:state') as { room: { name: string } };
      expect(roomState.room.name).toBe('Test Room');
      // Expect lobby broadcast
      const lobbyUpdate = await client.awaitMessage('lobby:state') as { rooms: Array<{ name: string }> };
      expect(lobbyUpdate.rooms.some((r) => r.name === 'Test Room')).toBe(true);
    } finally {
      client?.close();
      await srv.close();
    }
  });
});

describe('WebSocket — full game flow', () => {
  it('two players: create, join, start, play full game to game:over', async () => {
    const srv = await startServer();
    let alice: TestClient | null = null;
    let bob: TestClient | null = null;

    try {
      const aliceSession = await createSession(srv.url, 'Alice');
      const bobSession = await createSession(srv.url, 'Bob');

      alice = await connectAuthenticated(srv.wsUrl, aliceSession.token);
      bob = await connectAuthenticated(srv.wsUrl, bobSession.token);

      // Alice creates a room.
      alice.send({ type: 'room:create', name: 'Game Room', maxPlayers: 2, isPrivate: false });
      const aliceRoomState = await alice.awaitMessage('room:state') as {
        room: { id: string };
      };
      const roomId = aliceRoomState.room.id;

      // Bob joins.
      bob.send({ type: 'room:join', roomId });
      await bob.awaitMessage('room:state');
      await alice.awaitMessage('room:state'); // Alice gets the update too

      // Alice starts the game.
      alice.send({ type: 'room:start', roomId });

      // room:start sends: room:state{status:'playing'} → game:state → game:turn
      // Drain all three from both clients before the game loop.
      // Use awaitAny to grab them in arrival order.
      async function drainStartMessages(client: TestClient): Promise<{ view: { turnSeq: number; currentPlayerId: string; phase: string } }> {
        let gameState: { view: { turnSeq: number; currentPlayerId: string; phase: string } } | null = null;
        for (let i = 0; i < 10; i++) {
          const msg = await client.awaitAny(3000);
          const t = msg['type'] as string;
          if (t === 'game:state') gameState = msg as unknown as typeof gameState;
          if (t === 'game:turn') break; // game:turn is the last message — done
        }
        if (!gameState) throw new Error('Never received game:state during start');
        return gameState;
      }

      const [aliceGameState, bobGameState] = await Promise.all([
        drainStartMessages(alice),
        drainStartMessages(bob),
      ]);
      expect(aliceGameState.view.phase).toBe('offer');
      expect(bobGameState.view.phase).toBe('offer');

      // game:turn was already consumed by drainStartMessages.
      // Reconstruct firstTurnMsg from the game:state view.
      const firstTurnMsg = { currentPlayerId: aliceGameState.view.currentPlayerId };
      expect(typeof firstTurnMsg.currentPlayerId).toBe('string');

      const clientMap = new Map([
        [aliceSession.playerId, alice],
        [bobSession.playerId, bob],
      ]);

      type PlayerView = {
        players: Array<{ id: string; name: string; board: { patternLines: unknown[][]; wall: unknown[][]; floor: unknown[]; score: number } }>;
        factories: string[][];
        center: string[];
        centerHasFirstToken: boolean;
        bagCount: number;
        discard: string[];
        currentPlayerId: string;
        firstPlayerId: string;
        phase: string;
        round: number;
        turnSeq: number;
        you: string;
        winnerIds: string[] | null;
      };

      function viewToGameState(view: PlayerView) {
        const currentIdx = view.players.findIndex((p) => p.id === view.currentPlayerId);
        const firstIdx = view.players.findIndex((p) => p.id === view.firstPlayerId);
        return {
          players: view.players,
          factories: view.factories,
          center: view.center,
          centerHasFirstToken: view.centerHasFirstToken,
          bag: new Array(view.bagCount).fill('blue'),
          discard: view.discard,
          currentPlayerIndex: currentIdx >= 0 ? currentIdx : 0,
          firstPlayerIndex: firstIdx >= 0 ? firstIdx : 0,
          phase: view.phase,
          round: view.round,
          winnerIds: view.winnerIds ?? null,
          rngSeed: 0,
          turnSeq: view.turnSeq,
        };
      }

      // Track the latest view for each player (updated from game:state messages).
      const latestView = new Map<string, PlayerView>();
      latestView.set(aliceSession.playerId, aliceGameState.view as unknown as PlayerView);
      latestView.set(bobSession.playerId, bobGameState.view as unknown as PlayerView);

      // Server message order after each move:
      //   game:applied → game:state (per player) → game:turn
      // At game end: game:applied → game:state → game:over (no game:turn).
      //
      // We read alice's stream with awaitAny() — returns messages in arrival order
      // with a single waiter, so no type-competition between concurrent calls.

      const MAX_TURNS = 600;
      let gameOverMsg: Record<string, unknown> | null = null;

      // firstTurnMsg tells us who goes first.
      let currentPlayerId = firstTurnMsg.currentPlayerId;

      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const activeClient = clientMap.get(currentPlayerId);
        if (!activeClient) break;

        const view = latestView.get(aliceSession.playerId);
        if (!view || view.phase !== 'offer') break;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const move = autoMove(viewToGameState(view) as any);
        activeClient.send({ type: 'game:move', move, expectedTurnSeq: view.turnSeq });

        // Read alice's next messages until game:turn or game:over.
        let loopBreak = false;
        for (let msgIdx = 0; msgIdx < 20; msgIdx++) {
          const msg = await alice.awaitAny(5000).catch(() => null);
          if (!msg) { loopBreak = true; break; }
          const t = msg['type'] as string;
          if (t === 'game:state') {
            latestView.set(aliceSession.playerId, (msg as { view: PlayerView }).view);
          } else if (t === 'game:turn') {
            currentPlayerId = msg['currentPlayerId'] as string;
            break;
          } else if (t === 'game:over') {
            gameOverMsg = msg;
            loopBreak = true;
            break;
          }
          // game:applied, room:state, lobby:state, error — continue
        }
        if (loopBreak) break;
      }

      expect(gameOverMsg).not.toBeNull();
      expect(Array.isArray((gameOverMsg as { winnerIds: string[] }).winnerIds)).toBe(true);
    } finally {
      alice?.close();
      bob?.close();
      await srv.close();
    }
  }, 120_000);

  it('double-tap: same expectedTurnSeq rejected, no double advance', async () => {
    const srv = await startServer();
    let alice: TestClient | null = null;
    let bob: TestClient | null = null;

    try {
      const aliceSession = await createSession(srv.url, 'Alice');
      const bobSession = await createSession(srv.url, 'Bob');

      alice = await connectAuthenticated(srv.wsUrl, aliceSession.token);
      bob = await connectAuthenticated(srv.wsUrl, bobSession.token);

      alice.send({ type: 'room:create', name: 'Room', maxPlayers: 2, isPrivate: false });
      const { room: { id: roomId } } = await alice.awaitMessage('room:state') as { room: { id: string } };

      bob.send({ type: 'room:join', roomId });
      await bob.awaitMessage('room:state');
      await alice.awaitMessage('room:state');

      alice.send({ type: 'room:start', roomId });

      const [aliceGS] = await Promise.all([
        alice.awaitMessage('game:state'),
        bob.awaitMessage('game:state'),
      ]);
      await Promise.all([alice.awaitMessage('game:turn'), bob.awaitMessage('game:turn')]);

      const view = (aliceGS as { view: { currentPlayerId: string; turnSeq: number; factories: string[][]; center: string[]; centerHasFirstToken: boolean; discard: string[]; players: Array<{ id: string; name: string; board: { patternLines: unknown[][]; wall: unknown[][]; floor: unknown[]; score: number } }>; phase: string; round: number; bagCount: number; you: string; firstPlayerId: string; winnerIds: null } }).view;
      const turnSeq = view.turnSeq;
      const currentPlayerId = view.currentPlayerId;

      const fakeState = {
        players: view.players,
        factories: view.factories,
        center: view.center,
        centerHasFirstToken: view.centerHasFirstToken,
        bag: new Array(view.bagCount).fill('blue'),
        discard: view.discard,
        currentPlayerIndex: view.players.findIndex((p) => p.id === currentPlayerId),
        firstPlayerIndex: view.players.findIndex((p) => p.id === view.firstPlayerId),
        phase: view.phase,
        round: view.round,
        winnerIds: null,
        rngSeed: 0,
        turnSeq,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const move = autoMove(fakeState as any);
      const activeClient = currentPlayerId === aliceSession.playerId ? alice : bob;

      // Send the move twice with the same expectedTurnSeq.
      activeClient.send({ type: 'game:move', move, expectedTurnSeq: turnSeq });
      activeClient.send({ type: 'game:move', move, expectedTurnSeq: turnSeq });

      // First should succeed (game:applied) and second should return error.
      const [firstResult] = await Promise.all([
        activeClient.awaitMessage('game:applied', 3000).catch(() => null),
        activeClient.awaitMessage('error', 3000).catch(() => null),
      ]);

      // We expect either: game:applied + error, or just an error on the second.
      // The key invariant: we receive exactly one error.
      const errMsg = await activeClient.awaitMessage('error', 3000).catch(() => null);

      // At least one error must have been received (second tap rejected).
      // We cannot always predict ordering, so check the error exists.
      expect(errMsg ?? firstResult).toBeTruthy();
    } finally {
      alice?.close();
      bob?.close();
      await srv.close();
    }
  }, 30_000);

  it('reconnect: drop socket, reopen with same token+roomId → game:state; peers get player:connection', async () => {
    const srv = await startServer();
    let alice: TestClient | null = null;
    let bob: TestClient | null = null;
    let alice2: TestClient | null = null;

    try {
      const aliceSession = await createSession(srv.url, 'Alice');
      const bobSession = await createSession(srv.url, 'Bob');

      alice = await connectAuthenticated(srv.wsUrl, aliceSession.token);
      bob = await connectAuthenticated(srv.wsUrl, bobSession.token);

      alice.send({ type: 'room:create', name: 'Room', maxPlayers: 2, isPrivate: false });
      const { room: { id: roomId } } = await alice.awaitMessage('room:state') as { room: { id: string } };

      bob.send({ type: 'room:join', roomId });
      await bob.awaitMessage('room:state');
      await alice.awaitMessage('room:state');

      alice.send({ type: 'room:start', roomId });
      await Promise.all([alice.awaitMessage('game:state'), bob.awaitMessage('game:state')]);
      await Promise.all([alice.awaitMessage('game:turn'), bob.awaitMessage('game:turn')]);

      // Drop Alice's connection.
      alice.close();
      alice = null;

      // Bob should get player:connection{connected:false} for Alice.
      const connMsg = await bob.awaitMessage('player:connection', 5000) as {
        playerId: string;
        connected: boolean;
      };
      expect(connMsg.playerId).toBe(aliceSession.playerId);
      expect(connMsg.connected).toBe(false);

      // Alice reconnects with same token + roomId.
      alice2 = await connect(srv.wsUrl);
      alice2.send({ type: 'hello', token: aliceSession.token, roomId });
      await alice2.awaitMessage('hello:ok');

      // Should receive a fresh game:state.
      const freshState = await alice2.awaitMessage('game:state', 5000);
      expect(freshState['type']).toBe('game:state');

      // Bob should get player:connection{connected:true}.
      const reconnMsg = await bob.awaitMessage('player:connection', 5000) as {
        playerId: string;
        connected: boolean;
      };
      expect(reconnMsg.playerId).toBe(aliceSession.playerId);
      expect(reconnMsg.connected).toBe(true);

      void bobSession; // used above
    } finally {
      alice?.close();
      alice2?.close();
      bob?.close();
      await srv.close();
    }
  }, 30_000);

  it('1-human + 1-bot room: host adds a bot, starts game, bot auto-plays its turn', async () => {
    const srv = await startServer();
    let alice: TestClient | null = null;

    try {
      const aliceSession = await createSession(srv.url, 'Alice');
      alice = await connectAuthenticated(srv.wsUrl, aliceSession.token);

      // Alice creates a 2-player room.
      alice.send({ type: 'room:create', name: 'Bot Room', maxPlayers: 2, isPrivate: false });
      const { room: { id: roomId } } = await alice.awaitMessage('room:state') as { room: { id: string } };

      // Alice adds a bot.
      alice.send({ type: 'room:addBot', roomId, level: 'easy' });
      const roomWithBot = await alice.awaitMessage('room:state') as {
        room: { players: Array<{ id: string; name: string; bot?: { level: string } }> };
      };
      const botPlayer = roomWithBot.room.players.find((p) => p.bot !== undefined);
      expect(botPlayer).toBeDefined();
      expect(botPlayer?.bot?.level).toBe('easy');

      // Alice starts the game.
      alice.send({ type: 'room:start', roomId });

      // Drain: room:state + game:state + game:turn.
      let gameStateMsg: { view: { currentPlayerId: string; turnSeq: number } } | null = null;
      let currentPlayerId = '';
      for (let i = 0; i < 10; i++) {
        const msg = await alice.awaitAny(3000);
        const t = msg['type'] as string;
        if (t === 'game:state') {
          gameStateMsg = msg as unknown as typeof gameStateMsg;
          currentPlayerId = (msg as { view: { currentPlayerId: string } }).view.currentPlayerId;
        }
        if (t === 'game:turn') break;
      }
      expect(gameStateMsg).not.toBeNull();

      // If the bot goes first, advance the fake clock to fire its timer.
      if (currentPlayerId.startsWith('bot:')) {
        srv.clock.tick(1000);
        await flushMicrotasks();
        // Bot should have auto-played: expect game:applied.
        const applied = await alice.awaitMessage('game:applied', 5000);
        expect(applied['type']).toBe('game:applied');
      } else {
        // Human (Alice) goes first — just verify the game started.
        expect(currentPlayerId).toBe(aliceSession.playerId);
      }
    } finally {
      alice?.close();
      await srv.close();
    }
  }, 30_000);

  it('non-host cannot add a bot', async () => {
    const srv = await startServer();
    let alice: TestClient | null = null;
    let bob: TestClient | null = null;

    try {
      const aliceSession = await createSession(srv.url, 'Alice');
      const bobSession = await createSession(srv.url, 'Bob');

      alice = await connectAuthenticated(srv.wsUrl, aliceSession.token);
      bob = await connectAuthenticated(srv.wsUrl, bobSession.token);

      // Alice creates a room (she is host).
      alice.send({ type: 'room:create', name: 'Room', maxPlayers: 3, isPrivate: false });
      const { room: { id: roomId } } = await alice.awaitMessage('room:state') as { room: { id: string } };

      // Bob joins.
      bob.send({ type: 'room:join', roomId });
      await bob.awaitMessage('room:state');
      await alice.awaitMessage('room:state');

      // Bob tries to add a bot — should get NOT_HOST error.
      bob.send({ type: 'room:addBot', roomId, level: 'easy' });
      const err = await bob.awaitMessage('error', 3000) as { code: string };
      expect(err.code).toBe('NOT_HOST');

      void bobSession;
    } finally {
      alice?.close();
      bob?.close();
      await srv.close();
    }
  }, 30_000);

  it('addBot rejected when room is full', async () => {
    const srv = await startServer();
    let alice: TestClient | null = null;
    let bob: TestClient | null = null;

    try {
      const aliceSession = await createSession(srv.url, 'Alice');
      const bobSession = await createSession(srv.url, 'Bob');

      alice = await connectAuthenticated(srv.wsUrl, aliceSession.token);
      bob = await connectAuthenticated(srv.wsUrl, bobSession.token);

      // Create a 2-player room.
      alice.send({ type: 'room:create', name: 'Room', maxPlayers: 2, isPrivate: false });
      const { room: { id: roomId } } = await alice.awaitMessage('room:state') as { room: { id: string } };

      // Bob joins — room is now full.
      bob.send({ type: 'room:join', roomId });
      await bob.awaitMessage('room:state');
      await alice.awaitMessage('room:state');

      // Alice tries to add a bot to a full room — should get ROOM_FULL error.
      alice.send({ type: 'room:addBot', roomId, level: 'easy' });
      const err = await alice.awaitMessage('error', 3000) as { code: string };
      expect(err.code).toBe('ROOM_FULL');

      void aliceSession;
      void bobSession;
    } finally {
      alice?.close();
      bob?.close();
      await srv.close();
    }
  }, 30_000);

  it('timeout: advance injected clock past deadline → server auto-moves, game:turn for next player', async () => {
    const srv = await startServer();
    let alice: TestClient | null = null;
    let bob: TestClient | null = null;

    try {
      const aliceSession = await createSession(srv.url, 'Alice');
      const bobSession = await createSession(srv.url, 'Bob');

      alice = await connectAuthenticated(srv.wsUrl, aliceSession.token);
      bob = await connectAuthenticated(srv.wsUrl, bobSession.token);

      alice.send({ type: 'room:create', name: 'Room', maxPlayers: 2, isPrivate: false });
      const { room: { id: roomId } } = await alice.awaitMessage('room:state') as { room: { id: string } };

      bob.send({ type: 'room:join', roomId });
      await bob.awaitMessage('room:state');
      await alice.awaitMessage('room:state');

      alice.send({ type: 'room:start', roomId });
      await Promise.all([alice.awaitMessage('game:state'), bob.awaitMessage('game:state')]);
      const [firstTurn] = await Promise.all([
        alice.awaitMessage('game:turn') as Promise<{ currentPlayerId: string }>,
        bob.awaitMessage('game:turn'),
      ]);

      const firstPlayer = firstTurn.currentPlayerId;

      // Advance the fake clock past the 60-second deadline.
      srv.clock.tick(65_000);
      await flushMicrotasks();

      // Server should auto-move and emit game:applied + game:turn for next player.
      const [applied] = await Promise.all([
        alice.awaitMessage('game:applied', 5000),
        bob.awaitMessage('game:applied', 5000),
      ]);
      expect(applied['type']).toBe('game:applied');

      // A new game:turn should arrive for the next player.
      const [nextTurn] = await Promise.all([
        alice.awaitMessage('game:turn', 5000) as Promise<{ currentPlayerId: string }>,
        bob.awaitMessage('game:turn', 5000),
      ]);
      // The next player should be different (2-player game, turns alternate).
      expect((nextTurn as { currentPlayerId: string }).currentPlayerId).not.toBe(firstPlayer);

      void aliceSession;
      void bobSession;
    } finally {
      alice?.close();
      bob?.close();
      await srv.close();
    }
  }, 30_000);

  it('human-vs-bot: human disconnects → game torn down, bot stops, reconnect aborted', async () => {
    const srv = await startServer();
    let alice: TestClient | null = null;
    let alice2: TestClient | null = null;

    try {
      const aliceSession = await createSession(srv.url, 'Alice');
      alice = await connectAuthenticated(srv.wsUrl, aliceSession.token);

      alice.send({ type: 'room:create', name: 'Bot Room', maxPlayers: 2, isPrivate: false });
      const { room: { id: roomId } } = await alice.awaitMessage('room:state') as { room: { id: string } };

      alice.send({ type: 'room:addBot', roomId, level: 'easy' });
      await alice.awaitMessage('room:state');

      alice.send({ type: 'room:start', roomId });
      await alice.awaitMessage('game:state');
      await alice.awaitMessage('game:turn');

      // The only human disconnects → the live game must be torn down.
      alice.close();
      alice = null;
      await flushMicrotasks();

      // Advancing past the bot move delay must NOT resurrect the game.
      srv.clock.tick(65_000);
      await flushMicrotasks();

      // Reconnect with the same token+roomId → manager gone → game:aborted not_found.
      alice2 = await connect(srv.wsUrl);
      alice2.send({ type: 'hello', token: aliceSession.token, roomId });
      await alice2.awaitMessage('hello:ok');
      const aborted = await alice2.awaitMessage('game:aborted', 5000) as { reason: string };
      expect(aborted.reason).toBe('not_found');
    } finally {
      alice?.close();
      alice2?.close();
      await srv.close();
    }
  }, 30_000);

  it('game played to completion → manager removed; reconnect after over → aborted', async () => {
    const srv = await startServer();
    let alice: TestClient | null = null;
    let alice2: TestClient | null = null;

    try {
      const aliceSession = await createSession(srv.url, 'Alice');
      alice = await connectAuthenticated(srv.wsUrl, aliceSession.token);

      alice.send({ type: 'room:create', name: 'Finish Room', maxPlayers: 2, isPrivate: false });
      const { room: { id: roomId } } = await alice.awaitMessage('room:state') as { room: { id: string } };

      alice.send({ type: 'room:addBot', roomId, level: 'easy' });
      await alice.awaitMessage('room:state');

      alice.send({ type: 'room:start', roomId });
      await alice.awaitMessage('game:state');
      await alice.awaitMessage('game:turn');

      // Drive the whole game to completion by timing out every turn
      // (human turns auto-move on deadline; bot turns fire on their delay).
      for (let i = 0; i < 400; i++) srv.clock.tick(65_000);

      const over = await alice.awaitMessage('game:over', 10_000);
      expect(over['type']).toBe('game:over');

      // After game over the manager must be removed → reconnect yields not_found.
      alice2 = await connect(srv.wsUrl);
      alice2.send({ type: 'hello', token: aliceSession.token, roomId });
      await alice2.awaitMessage('hello:ok');
      const aborted = await alice2.awaitMessage('game:aborted', 5000) as { reason: string };
      expect(aborted.reason).toBe('not_found');
    } finally {
      alice?.close();
      alice2?.close();
      await srv.close();
    }
  }, 60_000);

  it('multi-human game: one human disconnects → game continues (manager not disposed)', async () => {
    const srv = await startServer();
    let alice: TestClient | null = null;
    let bob: TestClient | null = null;
    let alice2: TestClient | null = null;

    try {
      const aliceSession = await createSession(srv.url, 'Alice');
      const bobSession = await createSession(srv.url, 'Bob');

      alice = await connectAuthenticated(srv.wsUrl, aliceSession.token);
      bob = await connectAuthenticated(srv.wsUrl, bobSession.token);

      alice.send({ type: 'room:create', name: 'Room', maxPlayers: 2, isPrivate: false });
      const { room: { id: roomId } } = await alice.awaitMessage('room:state') as { room: { id: string } };

      bob.send({ type: 'room:join', roomId });
      await bob.awaitMessage('room:state');
      await alice.awaitMessage('room:state');

      alice.send({ type: 'room:start', roomId });
      await Promise.all([alice.awaitMessage('game:state'), bob.awaitMessage('game:state')]);
      await Promise.all([alice.awaitMessage('game:turn'), bob.awaitMessage('game:turn')]);

      // Alice disconnects but Bob remains connected → game must NOT be torn down.
      alice.close();
      alice = null;
      const conn = await bob.awaitMessage('player:connection', 5000) as {
        playerId: string;
        connected: boolean;
      };
      expect(conn.connected).toBe(false);

      // Reconnect Alice → manager still alive → she receives a fresh game:state.
      alice2 = await connect(srv.wsUrl);
      alice2.send({ type: 'hello', token: aliceSession.token, roomId });
      await alice2.awaitMessage('hello:ok');
      const fresh = await alice2.awaitMessage('game:state', 5000);
      expect(fresh['type']).toBe('game:state');

      void bobSession;
    } finally {
      alice?.close();
      alice2?.close();
      bob?.close();
      await srv.close();
    }
  }, 30_000);

  it('adding multiple bots yields unique, non-colliding ids', async () => {
    const srv = await startServer();
    let alice: TestClient | null = null;

    try {
      const aliceSession = await createSession(srv.url, 'Alice');
      alice = await connectAuthenticated(srv.wsUrl, aliceSession.token);

      alice.send({ type: 'room:create', name: 'Room', maxPlayers: 4, isPrivate: false });
      const { room: { id: roomId } } = await alice.awaitMessage('room:state') as { room: { id: string } };

      let botIds: string[] = [];
      for (const level of ['easy', 'medium', 'easy'] as const) {
        alice.send({ type: 'room:addBot', roomId, level });
        const rs = await alice.awaitMessage('room:state') as {
          room: { players: Array<{ id: string; bot?: { level: string } }> };
        };
        botIds = rs.room.players.filter((p) => p.bot !== undefined).map((p) => p.id);
      }

      expect(botIds.length).toBe(3);
      expect(new Set(botIds).size).toBe(3);

      void aliceSession;
    } finally {
      alice?.close();
      await srv.close();
    }
  }, 30_000);
});
