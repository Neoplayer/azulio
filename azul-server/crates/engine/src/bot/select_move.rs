use crate::bot::BotConfig;
use crate::bot::evaluate::evaluate;
use crate::bot::search::search_best_move;
use crate::moves::{apply_move, legal_moves};
use crate::rng::Mulberry32;
use azul_shared::{BotLevel, GameState, Move, MoveSource, MoveTarget};

/// Number of top candidates to sample from when epsilon noise fires.
const EPSILON_TOP_N: usize = 3;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Floor cost (tiles that would land on the floor) for a candidate move.
fn floor_cost_for_move(state: &GameState, mv: &Move, player_index: usize) -> usize {
    let pool: &[azul_shared::Color] = match mv.source {
        MoveSource::Factory { index } => &state.factories[index],
        MoveSource::Center => &state.center,
    };
    let taken = pool.iter().filter(|c| **c == mv.color).count();
    let marker_cost = if matches!(mv.source, MoveSource::Center) && state.center_has_first_token {
        1
    } else {
        0
    };

    match mv.target {
        MoveTarget::Floor => taken + marker_cost,
        MoveTarget::PatternLine { row } => {
            let line = &state.players[player_index].board.pattern_lines[row];
            let free_slots = line.iter().filter(|c| c.is_none()).count();
            taken.saturating_sub(free_slots) + marker_cost
        }
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Returns all legal moves sorted best-first by greedy 1-ply evaluation.
/// Exported so the minimax search can reuse the list without re-computing
/// scores.
pub fn greedy_best_moves(state: &GameState, player_index: usize, config: &BotConfig) -> Vec<Move> {
    let moves = legal_moves(state);
    if moves.is_empty() {
        return Vec::new();
    }

    let mut scored: Vec<(Move, f64)> = moves
        .into_iter()
        .map(|mv| {
            let score = evaluate(&apply_move(state, &mv), player_index, config);
            (mv, score)
        })
        .collect();

    // Sort descending by score. Stable sort preserves the original legal_moves
    // order on ties, matching V8's stable Array.prototype.sort.
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    scored.into_iter().map(|(mv, _)| mv).collect()
}

/// Select a move for the bot at `player_index`.
///
/// `state` phase must be `offer`. Panics if there are no legal moves (mirrors
/// the TS throw); the caller only invokes this in the `offer` phase.
pub fn select_move(
    state: &GameState,
    player_index: usize,
    config: &BotConfig,
    rng: &mut Mulberry32,
) -> Move {
    let moves = legal_moves(state);
    if moves.is_empty() {
        panic!("select_move: no legal moves available");
    }

    // ── Easy: random, but prefer moves that don't spill to the floor ─────────
    if config.level == BotLevel::Easy {
        let no_floor: Vec<Move> = moves
            .iter()
            .copied()
            .filter(|m| floor_cost_for_move(state, m, player_index) == 0)
            .collect();
        let pool = if !no_floor.is_empty() {
            &no_floor
        } else {
            &moves
        };
        let idx = (rng.next_f64() * pool.len() as f64).floor() as usize;
        return pool[idx];
    }

    // ── Medium / Hard: greedy ordering for epsilon noise ────────────────────
    let ranked = greedy_best_moves(state, player_index, config);

    // Epsilon noise: with probability epsilon pick uniformly from top-N
    // candidates so the bot occasionally plays sub-optimal moves (makes it less
    // exploitable). NB: the TS `&&` short-circuits — the epsilon roll is only
    // drawn when there is more than one top candidate; preserve that draw order.
    let top_n: Vec<Move> = ranked.iter().copied().take(EPSILON_TOP_N).collect();
    if top_n.len() > 1 && rng.next_f64() < config.epsilon {
        let idx = (rng.next_f64() * top_n.len() as f64).floor() as usize;
        return top_n[idx];
    }

    // Hard bot (search_depth > 1): use alpha-beta minimax for the best move.
    if config.search_depth > 1 {
        return search_best_move(state, player_index, config, rng);
    }

    // Medium bot: greedy best.
    ranked[0]
}

// ---------------------------------------------------------------------------
// Tests — port of packages/engine/src/bot/bot.test.ts
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bot::preset;
    use crate::moves::is_legal_move;
    use crate::{PlayerInfo, create_game, make_rng};
    use azul_shared::{Color, GamePhase, MoveTarget};

    fn players_2() -> Vec<PlayerInfo> {
        vec![
            PlayerInfo {
                id: "p1".into(),
                name: "Alice".into(),
            },
            PlayerInfo {
                id: "p2".into(),
                name: "Bob".into(),
            },
        ]
    }

    fn fresh_game(seed: u32) -> GameState {
        create_game(&players_2(), seed)
    }

    /// Drive the game forward by `n` moves using auto_move-style random picks.
    fn advance_game(state: &GameState, moves: usize, seed: u32) -> GameState {
        let mut rng = make_rng(seed);
        let mut s = state.clone();
        for _ in 0..moves {
            let legal = legal_moves(&s);
            if legal.is_empty() {
                break;
            }
            let idx = (rng.next_f64() * legal.len() as f64).floor() as usize;
            s = apply_move(&s, &legal[idx]);
        }
        s
    }

    const LEVELS: [BotLevel; 3] = [BotLevel::Easy, BotLevel::Medium, BotLevel::Hard];

    // ── 1. Determinism — same (state, seed) must always yield the same move ──

    #[test]
    fn determinism_same_seed_same_move() {
        for level in LEVELS {
            let state = advance_game(&fresh_game(1), 3, 99);
            let config = preset(level);

            let mut rng1 = make_rng(7777);
            let mut rng2 = make_rng(7777);

            let move1 = select_move(&state, 0, &config, &mut rng1);
            let move2 = select_move(&state, 0, &config, &mut rng2);

            assert_eq!(move1, move2, "level {level:?}");
        }
    }

    #[test]
    fn select_move_returns_a_legal_move() {
        for level in LEVELS {
            let state = advance_game(&fresh_game(7), 2, 99);
            let legal = legal_moves(&state);
            if legal.is_empty() {
                continue;
            }
            let config = preset(level);
            let mut rng = make_rng(42);
            let chosen = select_move(&state, 0, &config, &mut rng);
            assert!(
                legal.contains(&chosen),
                "level {level:?}: chosen move not in legal set"
            );
        }
    }

    // Epsilon noise (medium/hard only): forcing epsilon=1 always samples top-N.
    #[test]
    fn forced_epsilon_one_picks_from_topn() {
        for level in [BotLevel::Medium, BotLevel::Hard] {
            let forced_config = BotConfig {
                epsilon: 1.0,
                ..preset(level)
            };
            let state = advance_game(&fresh_game(7), 2, 99);
            let legal = legal_moves(&state);
            if legal.len() < 2 {
                continue;
            }

            let ranked = greedy_best_moves(&state, 0, &forced_config);
            let top_n: Vec<Move> = ranked.iter().copied().take(3).collect();
            let mut rng = make_rng(42);
            let chosen = select_move(&state, 0, &forced_config, &mut rng);
            assert!(
                top_n.contains(&chosen),
                "level {level:?}: chosen not in topN under forced epsilon"
            );
        }
    }

    // ── 2. Legality — select_move must always return a legal move ───────────

    #[test]
    fn select_move_always_legal_across_states() {
        for level in LEVELS {
            let config = preset(level);
            for game_seed in 0..5u32 {
                let mut state = fresh_game(game_seed);
                for turn in 0..12u32 {
                    if legal_moves(&state).is_empty() {
                        break;
                    }
                    let mut rng = make_rng(turn * 100 + game_seed);
                    let mv = select_move(&state, state.current_player_index, &config, &mut rng);
                    assert!(is_legal_move(&state, &mv), "level {level:?}");
                    state = apply_move(&state, &mv);
                }
            }
        }
    }

    // ── 3. evaluate — sanity checks ─────────────────────────────────────────

    #[test]
    fn pattern_beats_floor_best_of_each() {
        let state = fresh_game(5);
        let legal = legal_moves(&state);

        let floor_moves: Vec<Move> = legal
            .iter()
            .copied()
            .filter(|m| matches!(m.target, MoveTarget::Floor))
            .collect();
        let pattern_moves: Vec<Move> = legal
            .iter()
            .copied()
            .filter(|m| matches!(m.target, MoveTarget::PatternLine { .. }))
            .collect();

        if floor_moves.is_empty() || pattern_moves.is_empty() {
            return; // skip if degenerate
        }

        let config = preset(BotLevel::Medium);
        let pi = state.current_player_index;

        let best_pattern = pattern_moves
            .iter()
            .map(|m| evaluate(&apply_move(&state, m), pi, &config))
            .fold(f64::NEG_INFINITY, f64::max);
        let best_floor = floor_moves
            .iter()
            .map(|m| evaluate(&apply_move(&state, m), pi, &config))
            .fold(f64::NEG_INFINITY, f64::max);

        assert!(best_pattern >= best_floor);
    }

    #[test]
    fn floor_state_evaluates_lower_than_pattern_state() {
        let state = fresh_game(3);
        let legal = legal_moves(&state);
        let floor_moves: Vec<Move> = legal
            .iter()
            .copied()
            .filter(|m| matches!(m.target, MoveTarget::Floor))
            .collect();
        let pattern_moves: Vec<Move> = legal
            .iter()
            .copied()
            .filter(|m| matches!(m.target, MoveTarget::PatternLine { .. }))
            .collect();
        if floor_moves.is_empty() || pattern_moves.is_empty() {
            return;
        }

        let config = preset(BotLevel::Medium);
        let pi = state.current_player_index;

        let floor_state = apply_move(&state, &floor_moves[0]);
        let pattern_state = apply_move(&state, &pattern_moves[0]);

        let score_floor = evaluate(&floor_state, pi, &config);
        let score_pattern = evaluate(&pattern_state, pi, &config);

        assert!(score_pattern > score_floor);
    }

    #[test]
    fn endgame_bonuses_increase_eval_for_complete_row() {
        let mut state = fresh_game(2);
        // Fill a complete row for player 0 — W_ENDGAME_ROW = 2 should add 2 pts.
        state.players[0].board.wall[0] = vec![
            Some(Color::Blue),
            Some(Color::Yellow),
            Some(Color::Red),
            Some(Color::Black),
            Some(Color::White),
        ];

        let config_off = preset(BotLevel::Medium); // use_endgame_bonuses = false
        let config_on = preset(BotLevel::Hard); // use_endgame_bonuses = true

        let score_off = evaluate(&state, 0, &config_off);
        let score_on = evaluate(&state, 0, &config_on);

        assert!(score_on > score_off);
    }

    // ── 4. greedy_best_moves — basic contract checks ────────────────────────

    #[test]
    fn greedy_returns_all_legal_sorted_best_first() {
        let state = fresh_game(10);
        let config = preset(BotLevel::Medium);
        let ranked = greedy_best_moves(&state, 0, &config);
        let legal = legal_moves(&state);

        assert_eq!(ranked.len(), legal.len());

        // Verify the list is non-increasing in score.
        for i in 1..ranked.len() {
            let score_a = evaluate(&apply_move(&state, &ranked[i - 1]), 0, &config);
            let score_b = evaluate(&apply_move(&state, &ranked[i]), 0, &config);
            assert!(score_a >= score_b);
        }
    }

    #[test]
    fn greedy_returns_empty_when_no_legal_moves() {
        let mut finished_state = fresh_game(1);
        finished_state.phase = GamePhase::Finished;
        let ranked = greedy_best_moves(&finished_state, 0, &preset(BotLevel::Medium));
        assert_eq!(ranked, Vec::<Move>::new());
    }

    // ── 5. floor_cost_for_move — player_index threading ─────────────────────

    #[test]
    fn easy_bot_uses_supplied_player_index() {
        // Advance to a state where player 1 is the current player. select_move
        // must read player 1's pattern lines, not player 0's.
        let state = fresh_game(3);
        let mut s = state;
        for _ in 0..20 {
            let legal = legal_moves(&s);
            if legal.is_empty() {
                break;
            }
            if s.current_player_index == 1 {
                break;
            }
            s = apply_move(&s, &legal[0]);
        }
        let pi = s.current_player_index;
        let config = preset(BotLevel::Easy);
        let mut rng = make_rng(99);
        let chosen = select_move(&s, pi, &config, &mut rng);
        assert!(is_legal_move(&s, &chosen));
    }

    // ── 6. preset (BOT_PRESETS) shape validation ────────────────────────────

    #[test]
    fn presets_epsilon_ordering() {
        assert!(preset(BotLevel::Easy).epsilon > preset(BotLevel::Medium).epsilon);
        assert!(preset(BotLevel::Medium).epsilon > preset(BotLevel::Hard).epsilon);
    }

    #[test]
    fn presets_search_depth_ordering() {
        assert!(preset(BotLevel::Hard).search_depth > preset(BotLevel::Medium).search_depth);
        assert!(preset(BotLevel::Hard).search_depth > preset(BotLevel::Easy).search_depth);
    }

    #[test]
    fn presets_endgame_bonus_flags() {
        assert!(preset(BotLevel::Hard).use_endgame_bonuses);
        assert!(!preset(BotLevel::Medium).use_endgame_bonuses);
        assert!(!preset(BotLevel::Easy).use_endgame_bonuses);
    }
}
