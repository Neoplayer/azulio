// ---------------------------------------------------------------------------
// server.ts — Fastify + ws server factory.
// buildServer(deps?) returns { fastify, listen(port), close() }.
// All dependencies are injectable so integration tests can substitute fakes.
// ---------------------------------------------------------------------------

import Fastify from 'fastify';
import { WebSocketServer } from 'ws';
import { attachWsGateway } from './wsGateway.js';
import { realClock } from './types.js';
import type {
  SessionStore,
  RoomRepository,
  RoomManagerFactory,
  Clock,
} from './types.js';

export interface ServerDeps {
  sessionStore: SessionStore;
  roomRepository: RoomRepository;
  roomManagerFactory: RoomManagerFactory;
  clock?: Clock;
}

export interface AzulServer {
  /** The underlying Fastify instance (for plugin registration / test injection). */
  fastify: ReturnType<typeof Fastify>;
  /** Start listening. Pass 0 for an ephemeral port. Returns the bound port. */
  listen(port: number, host?: string): Promise<number>;
  /** Graceful shutdown: close ws server, stop Fastify. */
  close(): Promise<void>;
}

export function buildServer(deps: ServerDeps): AzulServer {
  const { sessionStore, roomRepository, roomManagerFactory } = deps;
  const clock: Clock = deps.clock ?? realClock;

  const fastify = Fastify({ logger: false });

  // ---------------------------------------------------------------------------
  // REST endpoints
  // ---------------------------------------------------------------------------

  fastify.get('/api/health', async (_req, reply) => {
    return reply.send({ ok: true });
  });

  fastify.post<{ Body: { name: string } }>('/api/session', {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', minLength: 1 } },
      },
    },
  }, async (req, reply) => {
    const { name } = req.body;
    const session = sessionStore.createSession(name);
    return reply.send({ playerId: session.playerId, token: session.token });
  });

  // ---------------------------------------------------------------------------
  // WebSocket server (attached to the same http server as Fastify)
  // ---------------------------------------------------------------------------

  let disposeGateway: (() => void) | null = null;
  let wss: WebSocketServer | null = null;

  async function listen(port: number, host = '127.0.0.1'): Promise<number> {
    await fastify.listen({ port, host });

    // Attach the ws server to Fastify's underlying http server.
    const httpServer = fastify.server;
    wss = new WebSocketServer({ server: httpServer, path: '/ws' });

    disposeGateway = attachWsGateway({
      wss,
      sessionStore,
      roomRepository,
      roomManagerFactory,
      clock,
    });

    // Extract the actual bound port (important when port=0 was requested).
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('Unexpected server address format');
    }
    return addr.port;
  }

  async function close(): Promise<void> {
    disposeGateway?.();

    await new Promise<void>((resolve, reject) => {
      if (!wss) return resolve();
      wss.close((err) => (err ? reject(err) : resolve()));
    });

    await fastify.close();
  }

  return { fastify, listen, close };
}
