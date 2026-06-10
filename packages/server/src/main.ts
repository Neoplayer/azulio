// ---------------------------------------------------------------------------
// main.ts — Entry point: wire real deps and start the server.
// ---------------------------------------------------------------------------

import { buildServer } from './server.js';
import { InMemorySessionStore } from './sessionStore.js';
import { InMemoryRoomRepository } from './roomRepository.js';
import { createRoomManager } from './roomManager.js';

const port = parseInt(process.env['PORT'] ?? '8080', 10);

const server = buildServer({
  sessionStore: new InMemorySessionStore(),
  roomRepository: new InMemoryRoomRepository(),
  roomManagerFactory: createRoomManager,
});

server.listen(port, '0.0.0.0').then((boundPort) => {
  console.log(`Azul server listening on port ${boundPort}`);
}).catch((err: unknown) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
