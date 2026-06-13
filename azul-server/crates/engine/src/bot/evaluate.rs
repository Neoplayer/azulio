use crate::bot::BotConfig;
use crate::tiling::resolve_tiling;
use azul_shared::{COLORS, GameState};

// ---------------------------------------------------------------------------
// Tunable weight constants — adjust here to change bot evaluation priorities.
// ---------------------------------------------------------------------------

/// Weight applied to the score delta after simulating end-of-round tiling.
/// Captures adjacency points gained minus floor penalties for this player.
const W_SCORE_DELTA: f64 = 1.0;

/// Bonus per short pattern line (capacity <= 2) that is already full and will
/// tile this round — short lines complete faster and score reliably.
const W_SHORT_COMPLETE: f64 = 3.0;

/// Bonus per medium pattern line (capacity 3) that is already full.
const W_MID_COMPLETE: f64 = 2.0;

/// Bonus per long pattern line (capacity >= 4) that is already full.
const W_LONG_COMPLETE: f64 = 1.0;

/// Penalty per unfilled slot in a long (capacity >= 4) pattern line that is
/// less than half-filled — unlikely to complete this round.
const W_LONG_PARTIAL_PENALTY: f64 = -0.3;

/// Extra penalty per tile currently sitting on the floor (beyond what
/// resolve_tiling already deducts), to more aggressively avoid floor dumps.
const W_FLOOR_TILE: f64 = -0.5;

/// Projected end-game bonus weights (mirrors finalize_scores constants).
const W_ENDGAME_ROW: f64 = 2.0;
const W_ENDGAME_COL: f64 = 7.0;
const W_ENDGAME_COLOR: f64 = 10.0;

// ---------------------------------------------------------------------------

/// Heuristic evaluation of `state` from the perspective of `player_index`.
pub fn evaluate(state: &GameState, player_index: usize, config: &BotConfig) -> f64 {
    let player = &state.players[player_index];
    let board = &player.board;
    let score_before_tiling = board.score;

    // ── Feature 1: round-end score delta ────────────────────────────────────
    // Simulate tiling on a clone to get the accurate end-of-round delta,
    // including adjacency points and floor-line penalties.
    let resolved = resolve_tiling(state);
    let score_delta = (resolved.players[player_index].board.score - score_before_tiling) as f64;

    // ── Feature 2: pattern line completion value ─────────────────────────────
    // Reward lines that are already full (will tile next) and penalise long
    // lines that are only partially filled (low probability of completing).
    let mut line_value = 0.0;
    for row in 0..5 {
        let line = &board.pattern_lines[row];
        let capacity = row + 1; // row 0 -> cap 1, row 4 -> cap 5
        let filled = line.iter().filter(|c| c.is_some()).count();
        if filled == 0 {
            continue;
        }

        if filled == capacity {
            // Line will tile at end of round
            if capacity <= 2 {
                line_value += W_SHORT_COMPLETE;
            } else if capacity == 3 {
                line_value += W_MID_COMPLETE;
            } else {
                line_value += W_LONG_COMPLETE;
            }
        } else if capacity >= 4 && (filled as f64) < (capacity as f64) / 2.0 {
            // Long line, less than half filled — penalise each empty slot
            line_value += (capacity - filled) as f64 * W_LONG_PARTIAL_PENALTY;
        }
    }

    // ── Feature 3: floor tile penalty ───────────────────────────────────────
    // Apply extra weight to the raw count of floor tiles to reinforce avoidance
    // beyond what resolve_tiling already deducts from the score.
    let floor_penalty = board.floor.len() as f64 * W_FLOOR_TILE;

    let mut total = W_SCORE_DELTA * score_delta + line_value + floor_penalty;

    // ── Feature 4: projected end-game bonuses ───────────────────────────────
    // When the config opts in, reward partial progress toward end-game bonuses.
    if config.use_endgame_bonuses {
        let wall = &board.wall;

        // Complete rows already on the wall
        let rows = wall
            .iter()
            .filter(|r| r.iter().all(|c| c.is_some()))
            .count();

        // Complete columns already on the wall
        let mut cols = 0;
        for c in 0..5 {
            if wall.iter().all(|r| r[c].is_some()) {
                cols += 1;
            }
        }

        // Colors where all 5 instances are on the wall
        let mut colors = 0;
        for color in COLORS {
            let count = wall
                .iter()
                .flat_map(|r| r.iter())
                .filter(|c| **c == Some(color))
                .count();
            if count == 5 {
                colors += 1;
            }
        }

        total += W_ENDGAME_ROW * rows as f64
            + W_ENDGAME_COL * cols as f64
            + W_ENDGAME_COLOR * colors as f64;
    }

    total
}
