// REST calls to the backend (proxied to the Fastify server in dev via Vite).

export interface SessionResponse {
  playerId: string;
  token: string;
}

export async function createSession(name: string): Promise<SessionResponse> {
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`session failed: ${res.status}`);
  return (await res.json()) as SessionResponse;
}

/** WebSocket URL derived from the current origin (works behind the Vite proxy). */
export function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}
