/**
 * Difficulty tiers for the built-in AI bot.
 * NOTE: A structurally identical `BotLevel` exists in @azul/shared/protocol.ts.
 * They are intentionally kept separate to avoid a shared↔engine dependency cycle.
 * The compile-time mutual-assignability guard lives in bot-types.test.ts.
 */
export type BotLevel = 'easy' | 'medium' | 'hard';

/** Configuration that drives bot behaviour at runtime. */
export interface BotConfig {
  level: BotLevel;
  /** Ply depth for search (0 = greedy/random, 1 = 1-ply greedy, 3+ = minimax). */
  searchDepth: number;
  /** Probability [0,1] of picking randomly from the top-N candidates instead of the best. */
  epsilon: number;
  /** When true, include projected end-game bonuses in the evaluation. */
  useEndgameBonuses: boolean;
  /** When true, consider denying high-value moves from opponents. */
  useDenial: boolean;
}

/** Ready-made configs keyed by difficulty. */
export const BOT_PRESETS: Record<BotLevel, BotConfig> = {
  easy: {
    level: 'easy',
    searchDepth: 0,
    epsilon: 0.4,
    useEndgameBonuses: false,
    useDenial: false,
  },
  medium: {
    level: 'medium',
    searchDepth: 1,
    epsilon: 0.15,
    useEndgameBonuses: false,
    useDenial: false,
  },
  hard: {
    level: 'hard',
    searchDepth: 3,
    epsilon: 0.03,
    useEndgameBonuses: true,
    useDenial: true,
  },
};
