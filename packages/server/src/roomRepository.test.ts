// ---------------------------------------------------------------------------
// @azul/server — roomRepository.test.ts
// Run: npx vitest run packages/server/src/roomRepository.test.ts
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { createInMemoryRoomRepository } from './roomRepository.js';
import type { Room } from '@azul/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCounter(prefix: string) {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function makeRoom(overrides: Partial<Room> = {}): Omit<Room, 'id'> {
  return {
    name: 'Test Room',
    hostId: 'p1',
    maxPlayers: 2,
    players: [{ id: 'p1', name: 'Alice' }],
    status: 'waiting',
    isPrivate: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// create + get round-trip
// ---------------------------------------------------------------------------

describe('create + get', () => {
  it('create returns a Room with a generated id', () => {
    const repo = createInMemoryRoomRepository();
    const room = repo.create(makeRoom());
    expect(room.id).toBeTruthy();
    expect(room.name).toBe('Test Room');
  });

  it('get returns the created room by id', () => {
    const repo = createInMemoryRoomRepository();
    const created = repo.create(makeRoom());
    const found = repo.get(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
  });

  it('get returns null for an unknown id', () => {
    const repo = createInMemoryRoomRepository();
    expect(repo.get('no-such-id')).toBeNull();
  });

  it('uses an injected id factory for deterministic ids in tests', () => {
    const idFactory = makeCounter('room');
    const repo = createInMemoryRoomRepository({ idFactory });
    const r1 = repo.create(makeRoom());
    const r2 = repo.create(makeRoom());
    expect(r1.id).toBe('room-1');
    expect(r2.id).toBe('room-2');
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('list', () => {
  it('returns empty array when no rooms', () => {
    const repo = createInMemoryRoomRepository();
    expect(repo.list()).toEqual([]);
  });

  it('returns all created rooms', () => {
    const repo = createInMemoryRoomRepository();
    const r1 = repo.create(makeRoom({ name: 'Room A' }));
    const r2 = repo.create(makeRoom({ name: 'Room B' }));
    const all = repo.list();
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.id)).toContain(r1.id);
    expect(all.map((r) => r.id)).toContain(r2.id);
  });

  it('does not include deleted rooms', () => {
    const repo = createInMemoryRoomRepository();
    const r1 = repo.create(makeRoom());
    const r2 = repo.create(makeRoom());
    repo.delete(r1.id);
    const all = repo.list();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(r2.id);
  });
});

// ---------------------------------------------------------------------------
// listWaiting
// ---------------------------------------------------------------------------

describe('listWaiting', () => {
  it('returns only rooms with status === waiting', () => {
    const repo = createInMemoryRoomRepository();
    const waiting = repo.create(makeRoom({ status: 'waiting' }));
    const playing = repo.create(makeRoom({ status: 'playing' }));
    const finished = repo.create(makeRoom({ status: 'finished' }));

    const result = repo.listWaiting();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(waiting.id);
    expect(result.map((r) => r.id)).not.toContain(playing.id);
    expect(result.map((r) => r.id)).not.toContain(finished.id);
  });

  it('returns empty when all rooms are playing or finished', () => {
    const repo = createInMemoryRoomRepository();
    repo.create(makeRoom({ status: 'playing' }));
    repo.create(makeRoom({ status: 'finished' }));
    expect(repo.listWaiting()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe('update', () => {
  it('merges a partial patch and returns the updated room', () => {
    const repo = createInMemoryRoomRepository();
    const room = repo.create(makeRoom());
    const updated = repo.update(room.id, { status: 'playing' });
    expect(updated.status).toBe('playing');
    expect(updated.name).toBe(room.name);
    expect(updated.id).toBe(room.id);
  });

  it('update is reflected in subsequent get', () => {
    const repo = createInMemoryRoomRepository();
    const room = repo.create(makeRoom());
    repo.update(room.id, { maxPlayers: 4 });
    expect(repo.get(room.id)!.maxPlayers).toBe(4);
  });

  it('can update players list', () => {
    const repo = createInMemoryRoomRepository();
    const room = repo.create(makeRoom());
    const newPlayers = [
      { id: 'p1', name: 'Alice' },
      { id: 'p2', name: 'Bob' },
    ];
    const updated = repo.update(room.id, { players: newPlayers });
    expect(updated.players).toHaveLength(2);
  });

  it('throws for an unknown id', () => {
    const repo = createInMemoryRoomRepository();
    expect(() => repo.update('ghost', { status: 'playing' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe('delete', () => {
  it('removes the room from the store', () => {
    const repo = createInMemoryRoomRepository();
    const room = repo.create(makeRoom());
    repo.delete(room.id);
    expect(repo.get(room.id)).toBeNull();
  });

  it('is a no-op for an unknown id (does not throw)', () => {
    const repo = createInMemoryRoomRepository();
    expect(() => repo.delete('ghost')).not.toThrow();
  });

  it('does not affect other rooms', () => {
    const repo = createInMemoryRoomRepository();
    const r1 = repo.create(makeRoom({ name: 'A' }));
    const r2 = repo.create(makeRoom({ name: 'B' }));
    repo.delete(r1.id);
    expect(repo.get(r2.id)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Store isolation
// ---------------------------------------------------------------------------

describe('store isolation', () => {
  it('two repo instances do not share state', () => {
    const a = createInMemoryRoomRepository();
    const b = createInMemoryRoomRepository();
    const room = a.create(makeRoom());
    expect(b.get(room.id)).toBeNull();
  });
});
