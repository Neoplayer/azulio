// ---------------------------------------------------------------------------
// @azul/server — roomRepository.ts
// In-memory implementation of the RoomRepository interface.
// ---------------------------------------------------------------------------

import type { Room } from '@azul/shared';
import type { RoomRepository } from './types.js';

export type { RoomRepository };

export interface RoomRepositoryOptions {
  /** Injectable id factory for deterministic ids in tests. */
  idFactory?: () => string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class InMemoryRoomRepositoryImpl implements RoomRepository {
  private readonly rooms = new Map<string, Room>();
  private readonly idFactory: () => string;

  constructor(options: RoomRepositoryOptions = {}) {
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  create(room: Omit<Room, 'id'>): Room {
    const id = this.idFactory();
    const full: Room = { ...room, id };
    this.rooms.set(id, full);
    return full;
  }

  get(id: string): Room | null {
    return this.rooms.get(id) ?? null;
  }

  list(): Room[] {
    return Array.from(this.rooms.values());
  }

  listWaiting(): Room[] {
    return Array.from(this.rooms.values()).filter((r) => r.status === 'waiting');
  }

  update(id: string, patch: Partial<Room>): Room {
    const existing = this.rooms.get(id);
    if (existing === undefined) {
      throw new Error(`RoomRepository.update: room "${id}" not found`);
    }
    const updated: Room = { ...existing, ...patch, id };
    this.rooms.set(id, updated);
    return updated;
  }

  delete(id: string): void {
    this.rooms.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

/** Class export for use in main.ts: `new InMemoryRoomRepository()`. */
export class InMemoryRoomRepository extends InMemoryRoomRepositoryImpl {}

/**
 * Factory function for use in tests — allows injecting deterministic
 * id factories without `new`.
 */
export function createInMemoryRoomRepository(
  options: RoomRepositoryOptions = {},
): RoomRepository {
  return new InMemoryRoomRepositoryImpl(options);
}
