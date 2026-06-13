pub mod evaluate;
pub mod search;
pub mod select_move;

pub use azul_shared::BotLevel;
pub use evaluate::evaluate;
pub use search::search_best_move;
pub use select_move::{greedy_best_moves, select_move};

/// Configuration that drives bot behaviour at runtime (port of BotConfig).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BotConfig {
    pub level: BotLevel,
    /// Ply depth for search (0 = greedy/random, 1 = 1-ply greedy, 3+ = minimax).
    pub search_depth: u32,
    /// Probability [0,1] of picking randomly from the top-N candidates.
    pub epsilon: f64,
    /// When true, include projected end-game bonuses in the evaluation.
    pub use_endgame_bonuses: bool,
    /// When true, consider denying high-value moves from opponents.
    pub use_denial: bool,
}

/// Ready-made config for a difficulty (port of `BOT_PRESETS`).
pub fn preset(level: BotLevel) -> BotConfig {
    match level {
        BotLevel::Easy => BotConfig {
            level,
            search_depth: 0,
            epsilon: 0.4,
            use_endgame_bonuses: false,
            use_denial: false,
        },
        BotLevel::Medium => BotConfig {
            level,
            search_depth: 1,
            epsilon: 0.15,
            use_endgame_bonuses: false,
            use_denial: false,
        },
        BotLevel::Hard => BotConfig {
            level,
            search_depth: 3,
            epsilon: 0.03,
            use_endgame_bonuses: true,
            use_denial: true,
        },
    }
}
