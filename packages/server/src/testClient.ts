// ---------------------------------------------------------------------------
// testClient.ts — thin ws wrapper used by server integration tests.
// Provides connect, send, awaitMessage, and awaitAny utilities.
// ---------------------------------------------------------------------------

import WebSocket from 'ws';

export interface TestClient {
  ws: WebSocket;
  /** Send any object as a JSON frame. */
  send(obj: unknown): void;
  /**
   * Await the next message of the given type. Rejects after timeoutMs (default
   * 5000 ms). Queues messages received before the call so none are lost.
   */
  awaitMessage(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  /**
   * Await the next message of ANY type. Useful for sequential message
   * consumption without specifying a type. Rejects after timeoutMs.
   */
  awaitAny(timeoutMs?: number): Promise<Record<string, unknown>>;
  /** Close the underlying socket. */
  close(): void;
}

/**
 * Open a WebSocket connection to `url` and return a TestClient.
 * Resolves once the socket is open.
 */
export function connect(url: string): Promise<TestClient> {
  return new Promise<TestClient>((resolve, reject) => {
    const ws = new WebSocket(url);

    // Buffer of parsed messages that arrived before awaitMessage was called.
    const queue: Record<string, unknown>[] = [];

    // Typed waiters — resolve for a specific message type.
    const waiters: Array<{
      type: string;
      resolve: (msg: Record<string, unknown>) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }> = [];

    // Wildcard waiters — resolve for any next message.
    const wildcardWaiters: Array<{
      resolve: (msg: Record<string, unknown>) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }> = [];

    ws.on('message', (raw: WebSocket.RawData) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return; // ignore malformed frames in tests
      }

      const msgType = parsed['type'] as string | undefined;

      // Satisfy the first wildcard waiter if any.
      if (wildcardWaiters.length > 0) {
        const waiter = wildcardWaiters.shift()!;
        clearTimeout(waiter.timer);
        waiter.resolve(parsed);
        return;
      }

      // Satisfy a typed waiter.
      const idx = waiters.findIndex((w) => w.type === msgType);
      if (idx !== -1) {
        const waiter = waiters.splice(idx, 1)[0]!;
        clearTimeout(waiter.timer);
        waiter.resolve(parsed);
      } else {
        // Park it in the queue for future awaitMessage / awaitAny calls.
        queue.push(parsed);
      }
    });

    ws.on('open', () => {
      const client: TestClient = {
        ws,

        send(obj: unknown): void {
          ws.send(JSON.stringify(obj));
        },

        awaitMessage(type: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
          // Check the queue first for an already-received message.
          const idx = queue.findIndex((m) => m['type'] === type);
          if (idx !== -1) {
            const msg = queue.splice(idx, 1)[0]!;
            return Promise.resolve(msg);
          }

          return new Promise<Record<string, unknown>>((res, rej) => {
            const timer = setTimeout(() => {
              const wi = waiters.findIndex((w) => w.resolve === res);
              if (wi !== -1) waiters.splice(wi, 1);
              rej(new Error(`awaitMessage('${type}') timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            waiters.push({ type, resolve: res, reject: rej, timer });
          });
        },

        awaitAny(timeoutMs = 5000): Promise<Record<string, unknown>> {
          // Return the first queued message regardless of type.
          if (queue.length > 0) {
            return Promise.resolve(queue.shift()!);
          }

          return new Promise<Record<string, unknown>>((res, rej) => {
            const timer = setTimeout(() => {
              const wi = wildcardWaiters.findIndex((w) => w.resolve === res);
              if (wi !== -1) wildcardWaiters.splice(wi, 1);
              rej(new Error(`awaitAny() timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            wildcardWaiters.push({ resolve: res, reject: rej, timer });
          });
        },

        close(): void {
          ws.close();
        },
      };

      resolve(client);
    });

    ws.on('error', reject);
  });
}
