// ---------------------------------------------------------------------------
// wsGateway.ts — WebSocket transport layer.
// Validates incoming frames, routes to business logic, forwards room events
// back to the right sockets.
// ---------------------------------------------------------------------------

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { parseClientMessage } from '@azul/shared';
import type { PlayerId } from '@azul/shared';
import { toPlayerView } from '@azul/engine';
import type {
  SessionStore,
  RoomRepository,
  RoomManagerFactory,
  RoomManager,
  Clock,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(sockets: Iterable<WebSocket>, msg: Record<string, unknown>): void {
  const raw = JSON.stringify(msg);
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(raw);
    }
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Per-socket connection context set after a successful hello. */
interface ConnCtx {
  playerId: PlayerId;
  /** Room the player is currently in-game for (set on game start). */
  roomId: string | null;
  /** Whether this socket has subscribed to lobby updates. */
  lobbySubscribed: boolean;
}

export interface WsGatewayDeps {
  wss: WebSocketServer;
  sessionStore: SessionStore;
  roomRepository: RoomRepository;
  roomManagerFactory: RoomManagerFactory;
  clock: Clock;
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export function attachWsGateway(deps: WsGatewayDeps): () => void {
  const { wss, sessionStore, roomRepository, roomManagerFactory, clock } = deps;

  /** socket → connection context (undefined until hello is authenticated). */
  const ctxMap = new Map<WebSocket, ConnCtx>();
  /** playerId → socket (latest connection wins on reconnect). */
  const socketByPlayer = new Map<PlayerId, WebSocket>();
  /** roomId → RoomManager (only for rooms that are playing). */
  const managers = new Map<string, RoomManager>();
  /** Sockets subscribed to lobby updates. */
  const lobbySubscribers = new Set<WebSocket>();

  // ---------------------------------------------------------------------------
  // Lobby helpers
  // ---------------------------------------------------------------------------

  function broadcastLobby(): void {
    broadcast(lobbySubscribers, { type: 'lobby:state', rooms: roomRepository.listWaiting() });
  }

  // ---------------------------------------------------------------------------
  // Room event wiring — called when a game is started.
  // ---------------------------------------------------------------------------

  function wireRoomManager(roomId: string, manager: RoomManager): void {
    function roomSockets(): WebSocket[] {
      const room = roomRepository.get(roomId);
      if (!room) return [];
      return room.players
        .map((p) => socketByPlayer.get(p.id))
        .filter((ws): ws is WebSocket => ws !== undefined);
    }

    manager.onState = (views) => {
      for (const [playerId, view] of views) {
        const ws = socketByPlayer.get(playerId);
        if (ws) send(ws, { type: 'game:state', view });
      }
    };

    manager.onTurn = (currentPlayerId, deadline) => {
      const sockets = roomSockets();
      broadcast(sockets, { type: 'game:turn', currentPlayerId, deadline });
    };

    manager.onApplied = (move, byPlayerId, turnSeq) => {
      const sockets = roomSockets();
      broadcast(sockets, { type: 'game:applied', move, by: byPlayerId, turnSeq });
    };

    manager.onOver = (scores, winnerIds) => {
      const sockets = roomSockets();
      broadcast(sockets, { type: 'game:over', scores, winnerIds });
      // Mark room finished.
      try { roomRepository.update(roomId, { status: 'finished' }); } catch { /* already gone */ }
      broadcastLobby();
    };
  }

  // ---------------------------------------------------------------------------
  // Message handlers
  // ---------------------------------------------------------------------------

  function handleHello(
    ws: WebSocket,
    msg: { type: 'hello'; token: string; roomId?: string | undefined },
  ): void {
    const session = sessionStore.getByToken(msg.token);
    if (!session) {
      send(ws, { type: 'session:invalid' });
      ws.close();
      return;
    }

    const { playerId } = session;

    // Disconnect any previous socket for this player.
    const prev = socketByPlayer.get(playerId);
    if (prev && prev !== ws && prev.readyState === WebSocket.OPEN) {
      prev.close();
    }
    socketByPlayer.set(playerId, ws);

    const ctx: ConnCtx = { playerId, roomId: null, lobbySubscribed: false };
    ctxMap.set(ws, ctx);

    send(ws, { type: 'hello:ok', playerId });

    // Reconnect case: client supplies a roomId they were in.
    if (msg.roomId) {
      const manager = managers.get(msg.roomId);
      if (!manager) {
        // Room is gone (server restart or finished).
        send(ws, { type: 'game:aborted', reason: 'not_found' });
        return;
      }
      ctx.roomId = msg.roomId;
      // Mark player reconnected.
      manager.setConnected(playerId, true);
      // Resend current game state.
      const state = manager.getState();
      send(ws, { type: 'game:state', view: toPlayerView(state, playerId) });

      // Notify room peers.
      broadcastPlayerConnection(msg.roomId, playerId, true, ws);
    }
  }

  function handleLobbySubscribe(ws: WebSocket): void {
    const ctx = ctxMap.get(ws);
    if (!ctx) return;
    ctx.lobbySubscribed = true;
    lobbySubscribers.add(ws);
    send(ws, { type: 'lobby:state', rooms: roomRepository.listWaiting() });
  }

  function handleRoomCreate(
    ws: WebSocket,
    msg: { type: 'room:create'; name: string; maxPlayers: number; isPrivate: boolean },
  ): void {
    const ctx = ctxMap.get(ws);
    if (!ctx) return;

    const playerName = sessionStore.getByPlayerId(ctx.playerId)?.name ?? '';
    const room = roomRepository.create({
      name: msg.name,
      hostId: ctx.playerId,
      maxPlayers: msg.maxPlayers,
      players: [{ id: ctx.playerId, name: playerName }],
      status: 'waiting',
      isPrivate: msg.isPrivate,
      createdAt: new Date().toISOString(),
    });

    ctx.roomId = room.id;
    send(ws, { type: 'room:state', room });
    broadcastLobby();
  }

  function handleRoomJoin(ws: WebSocket, msg: { type: 'room:join'; roomId: string }): void {
    const ctx = ctxMap.get(ws);
    if (!ctx) return;

    const room = roomRepository.get(msg.roomId);
    if (!room) {
      send(ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'Room not found' });
      return;
    }
    if (room.status !== 'waiting') {
      send(ws, { type: 'error', code: 'ROOM_NOT_WAITING', message: 'Room is not waiting' });
      return;
    }
    if (room.players.length >= room.maxPlayers) {
      send(ws, { type: 'error', code: 'ROOM_FULL', message: 'Room is full' });
      return;
    }
    if (room.players.some((p) => p.id === ctx.playerId)) {
      send(ws, { type: 'error', code: 'ALREADY_IN_ROOM', message: 'Already in room' });
      return;
    }

    const playerName = sessionStore.getByPlayerId(ctx.playerId)?.name ?? 'Unknown';
    const updated = roomRepository.update(msg.roomId, {
      players: [...room.players, { id: ctx.playerId, name: playerName }],
    });
    ctx.roomId = msg.roomId;
    broadcastToRoom(msg.roomId, { type: 'room:state', room: updated });
    broadcastLobby();
  }

  function handleRoomLeave(ws: WebSocket, msg: { type: 'room:leave'; roomId: string }): void {
    const ctx = ctxMap.get(ws);
    if (!ctx) return;

    const room = roomRepository.get(msg.roomId);
    if (!room) return;

    const newPlayers = room.players.filter((p) => p.id !== ctx.playerId);
    if (newPlayers.length === 0) {
      roomRepository.delete(msg.roomId);
    } else {
      const newHost = room.hostId === ctx.playerId ? newPlayers[0]!.id : room.hostId;
      const updated = roomRepository.update(msg.roomId, {
        players: newPlayers,
        hostId: newHost,
      });
      broadcastToRoom(msg.roomId, { type: 'room:state', room: updated });
    }
    ctx.roomId = null;
    broadcastLobby();
  }

  function handleRoomStart(ws: WebSocket, msg: { type: 'room:start'; roomId: string }): void {
    const ctx = ctxMap.get(ws);
    if (!ctx) return;

    const room = roomRepository.get(msg.roomId);
    if (!room) {
      send(ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'Room not found' });
      return;
    }
    if (room.hostId !== ctx.playerId) {
      send(ws, { type: 'error', code: 'NOT_HOST', message: 'Only host can start' });
      return;
    }
    if (room.players.length < 2) {
      send(ws, { type: 'error', code: 'NOT_ENOUGH_PLAYERS', message: 'Need at least 2 players' });
      return;
    }
    if (room.status !== 'waiting') {
      send(ws, { type: 'error', code: 'ALREADY_STARTED', message: 'Game already started' });
      return;
    }

    const updated = roomRepository.update(msg.roomId, { status: 'playing' });

    const manager = roomManagerFactory({ clock });
    managers.set(msg.roomId, manager);
    // Wire callbacks BEFORE startGame so initial state/turn events are delivered.
    wireRoomManager(msg.roomId, manager);

    // Update all players' roomId context.
    for (const p of room.players) {
      const pws = socketByPlayer.get(p.id);
      if (pws) {
        const pctx = ctxMap.get(pws);
        if (pctx) pctx.roomId = msg.roomId;
      }
    }

    broadcastToRoom(msg.roomId, { type: 'room:state', room: updated });
    broadcastLobby();

    // Start the game — this fires onState and onTurn immediately.
    const seed = Math.floor(Math.random() * 2 ** 31);
    manager.startGame(room.players, seed, 60_000);
  }

  function handleGameMove(
    ws: WebSocket,
    msg: { type: 'game:move'; move: import('@azul/shared').Move; expectedTurnSeq: number },
  ): void {
    const ctx = ctxMap.get(ws);
    if (!ctx || !ctx.roomId) {
      send(ws, { type: 'error', code: 'NOT_IN_GAME', message: 'Not in a game' });
      return;
    }

    const manager = managers.get(ctx.roomId);
    if (!manager) {
      send(ws, { type: 'error', code: 'GAME_NOT_FOUND', message: 'No active game in this room' });
      return;
    }

    const err = manager.submitMove(ctx.playerId, msg.move, msg.expectedTurnSeq);
    if (err) {
      send(ws, { type: 'error', code: 'ILLEGAL_MOVE', message: err });
    }
  }

  function handlePing(ws: WebSocket): void {
    send(ws, { type: 'pong' });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function broadcastToRoom(roomId: string, msg: Record<string, unknown>): void {
    const room = roomRepository.get(roomId);
    if (!room) return;
    for (const p of room.players) {
      const ws = socketByPlayer.get(p.id);
      if (ws) send(ws, msg);
    }
  }

  function broadcastPlayerConnection(
    roomId: string,
    playerId: PlayerId,
    connected: boolean,
    excludeWs?: WebSocket,
  ): void {
    const room = roomRepository.get(roomId);
    if (!room) return;
    const msg = { type: 'player:connection', playerId, connected };
    for (const p of room.players) {
      const ws = socketByPlayer.get(p.id);
      if (ws && ws !== excludeWs) send(ws, msg);
    }
  }

  // ---------------------------------------------------------------------------
  // Socket lifecycle
  // ---------------------------------------------------------------------------

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    ws.on('message', (raw: import('ws').RawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: 'error', code: 'PARSE_ERROR', message: 'Invalid JSON' });
        return;
      }

      let msg: ReturnType<typeof parseClientMessage>;
      try {
        msg = parseClientMessage(parsed);
      } catch {
        send(ws, { type: 'error', code: 'INVALID_MESSAGE', message: 'Message failed schema validation' });
        return;
      }

      // hello is the only message allowed before authentication.
      const ctx = ctxMap.get(ws);
      if (!ctx && msg.type !== 'hello') {
        send(ws, { type: 'error', code: 'NOT_AUTHENTICATED', message: 'Send hello first' });
        return;
      }

      switch (msg.type) {
        case 'hello':
          handleHello(ws, msg);
          break;
        case 'lobby:subscribe':
          handleLobbySubscribe(ws);
          break;
        case 'room:create':
          handleRoomCreate(ws, msg);
          break;
        case 'room:join':
          handleRoomJoin(ws, msg);
          break;
        case 'room:leave':
          handleRoomLeave(ws, msg);
          break;
        case 'room:start':
          handleRoomStart(ws, msg);
          break;
        case 'game:move':
          handleGameMove(ws, msg);
          break;
        case 'ping':
          handlePing(ws);
          break;
        default: {
          // Exhaustiveness guard — TypeScript will catch unhandled variants.
          const _exhaustive: never = msg;
          void _exhaustive;
        }
      }
    });

    ws.on('close', () => {
      const ctx = ctxMap.get(ws);
      if (ctx) {
        // Remove from lobby subscribers.
        lobbySubscribers.delete(ws);

        // Mark player disconnected in their room's game.
        if (ctx.roomId) {
          const manager = managers.get(ctx.roomId);
          if (manager) {
            manager.setConnected(ctx.playerId, false);
          }
          broadcastPlayerConnection(ctx.roomId, ctx.playerId, false, ws);
        }

        // Only clear the socket mapping if this is still the current socket for the player.
        if (socketByPlayer.get(ctx.playerId) === ws) {
          socketByPlayer.delete(ctx.playerId);
        }

        ctxMap.delete(ws);
      }
    });

    ws.on('error', () => {
      // 'close' fires after 'error', so cleanup happens there.
    });
  });

  // Return a dispose function that cleans up all managers.
  return function dispose(): void {
    for (const manager of managers.values()) {
      manager.dispose();
    }
    managers.clear();
  };
}
