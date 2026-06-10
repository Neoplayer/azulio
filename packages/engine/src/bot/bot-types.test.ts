/**
 * Compile-time guard: ensures BotLevel in @azul/shared and the engine remain
 * mutually assignable (structurally identical unions).
 *
 * If either union is changed without updating the other, tsc will error here.
 * Do NOT add a shared→engine import (package dependency cycle).
 */
import { describe, it, expect } from 'vitest';
import type { BotLevel as SharedBotLevel } from '@azul/shared';
import type { BotLevel as EngineBotLevel } from './types.js';

// Compile-time mutual-assignability check.
// These lines fail to typecheck if either union gains or loses a member.
const _a: SharedBotLevel = 'easy' as EngineBotLevel;
const _b: EngineBotLevel = 'easy' as SharedBotLevel;
void _a;
void _b;

describe('BotLevel type alignment (shared ↔ engine)', () => {
  it('shared and engine BotLevel unions are mutually assignable at compile time', () => {
    // The real assertion is the TypeScript above; this keeps vitest happy.
    expect(true).toBe(true);
  });
});
