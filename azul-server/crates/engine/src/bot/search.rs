use crate::bot::BotConfig;
use crate::bot::evaluate::evaluate;
use crate::bot::select_move::greedy_best_moves;
use crate::moves::apply_move;
use crate::rng::Mulberry32;
use crate::tiling::{is_offer_phase_over, resolve_tiling};
use azul_shared::{GameState, Move};

/// Maximum candidate moves explored at each ply.
/// Moves are already ordered best-first by greedy_best_moves, so trimming here
/// loses little quality while keeping the tree manageable.
const BRANCH_CAP: usize = 12;

/// Recursive alpha-beta minimax.
///
/// Strategy (paranoid / 2-player minimax):
///   - The node owned by `bot_player_index` maximises evaluate(…, bot_player_index).
///   - Every other node minimises that same value.
///
/// This is exact for 2 players; for >2 it is a conservative "paranoid"
/// approximation — all opponents gang up against the bot. Correct and simple.
///
/// Round-boundary rule: when a move causes is_offer_phase_over to become true we
/// do NOT recurse into the next round (which requires bag draws and introduces
/// stochastic information). Instead we apply resolve_tiling to the resulting
/// state and return evaluate() of that snapshot as the leaf value. state.bag is
/// never read during search.
fn alphabeta(
    state: &GameState,
    depth: u32,
    mut alpha: f64,
    mut beta: f64,
    bot_player_index: usize,
    config: &BotConfig,
) -> f64 {
    if depth == 0 {
        return evaluate(state, bot_player_index, config);
    }

    let mut candidates = greedy_best_moves(state, state.current_player_index, config);
    candidates.truncate(BRANCH_CAP);

    if candidates.is_empty() {
        return evaluate(state, bot_player_index, config);
    }

    let maximising = state.current_player_index == bot_player_index;

    if maximising {
        let mut value = f64::NEG_INFINITY;
        for mv in &candidates {
            let next = apply_move(state, mv);
            let child = if is_offer_phase_over(&next) {
                evaluate(&resolve_tiling(&next), bot_player_index, config)
            } else {
                alphabeta(&next, depth - 1, alpha, beta, bot_player_index, config)
            };
            if child > value {
                value = child;
            }
            if value > alpha {
                alpha = value;
            }
            if alpha >= beta {
                break; // β-cutoff
            }
        }
        value
    } else {
        let mut value = f64::INFINITY;
        for mv in &candidates {
            let next = apply_move(state, mv);
            let child = if is_offer_phase_over(&next) {
                evaluate(&resolve_tiling(&next), bot_player_index, config)
            } else {
                alphabeta(&next, depth - 1, alpha, beta, bot_player_index, config)
            };
            if child < value {
                value = child;
            }
            if value < beta {
                beta = value;
            }
            if alpha >= beta {
                break; // α-cutoff
            }
        }
        value
    }
}

/// Select the best move for `player_index` using alpha-beta minimax to
/// depth `config.search_depth`.
///
/// The `rng` parameter is kept for API symmetry with `select_move` but is not
/// used — search is fully deterministic given (state, config). Panics if there
/// are no legal moves (mirrors the TS throw).
pub fn search_best_move(
    state: &GameState,
    player_index: usize,
    config: &BotConfig,
    _rng: &mut Mulberry32,
) -> Move {
    let mut candidates = greedy_best_moves(state, player_index, config);
    candidates.truncate(BRANCH_CAP);
    if candidates.is_empty() {
        panic!("search_best_move: no legal moves available");
    }
    if candidates.len() == 1 {
        return candidates[0];
    }

    let mut best_move = candidates[0];
    let mut best_value = f64::NEG_INFINITY;
    let mut alpha = f64::NEG_INFINITY;
    let beta = f64::INFINITY;

    for mv in &candidates {
        let next = apply_move(state, mv);
        let value = if is_offer_phase_over(&next) {
            evaluate(&resolve_tiling(&next), player_index, config)
        } else {
            alphabeta(
                &next,
                config.search_depth - 1,
                alpha,
                beta,
                player_index,
                config,
            )
        };
        if value > best_value {
            best_value = value;
            best_move = *mv;
        }
        if value > alpha {
            alpha = value;
        }
    }

    best_move
}

// ---------------------------------------------------------------------------
// Tests — port of packages/engine/src/bot/search.test.ts
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bot::{BotLevel, preset};
    use crate::moves::{is_legal_move, legal_moves};
    use crate::{PlayerInfo, create_game, make_rng};

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

    /// Simulate greedy play for all players until the offer phase ends, then
    /// return the resolve_tiling score for the given player.
    fn simulate_round_end_score(state: &GameState, player_index: usize) -> i32 {
        let mut s = state.clone();
        let config = preset(BotLevel::Medium); // greedy follow-up
        while !is_offer_phase_over(&s) {
            let legal = legal_moves(&s);
            if legal.is_empty() {
                break;
            }
            let best = greedy_best_moves(&s, s.current_player_index, &config)[0];
            s = apply_move(&s, &best);
        }
        let resolved = resolve_tiling(&s);
        resolved.players[player_index].board.score
    }

    // ── 1. Determinism ──────────────────────────────────────────────────────

    #[test]
    fn search_same_inputs_same_move() {
        for seed in 0..5u32 {
            let state = advance_game(&fresh_game(seed), 3, 99);
            if legal_moves(&state).is_empty() {
                continue;
            }
            let config = preset(BotLevel::Hard);
            let m1 = search_best_move(&state, 0, &config, &mut make_rng(seed));
            let m2 = search_best_move(&state, 0, &config, &mut make_rng(seed));
            assert_eq!(m1, m2);
        }
    }

    #[test]
    fn search_is_rng_independent() {
        let state = advance_game(&fresh_game(1), 4, 99);
        if legal_moves(&state).is_empty() {
            return;
        }
        let config = preset(BotLevel::Hard);
        let m1 = search_best_move(&state, 0, &config, &mut make_rng(1));
        let m2 = search_best_move(&state, 0, &config, &mut make_rng(9999));
        assert_eq!(m1, m2);
    }

    // ── 2. Legality ─────────────────────────────────────────────────────────

    #[test]
    fn search_always_legal_across_states() {
        for game_seed in 0..8u32 {
            let mut state = fresh_game(game_seed);
            for turn in 0..10u32 {
                if legal_moves(&state).is_empty() {
                    break;
                }
                let config = preset(BotLevel::Hard);
                let mv = search_best_move(
                    &state,
                    state.current_player_index,
                    &config,
                    &mut make_rng(turn),
                );
                assert!(is_legal_move(&state, &mv));
                state = apply_move(&state, &mv);
            }
        }
    }

    // ── 3. Depth-1 equivalence: search at depth=1 == greedy top pick ────────

    #[test]
    fn search_depth1_equals_greedy() {
        let depth1_config = BotConfig {
            search_depth: 1,
            ..preset(BotLevel::Hard)
        };
        for seed in 0..10u32 {
            let state = advance_game(&fresh_game(seed), 2, 99);
            if legal_moves(&state).is_empty() {
                continue;
            }
            let search_move = search_best_move(&state, 0, &depth1_config, &mut make_rng(seed));
            let greedy_move = greedy_best_moves(&state, 0, &depth1_config)[0];
            assert_eq!(search_move, greedy_move);
        }
    }

    // ── 4. Tactical advantage ───────────────────────────────────────────────

    #[test]
    fn search_explores_greedy_candidate_depth2() {
        let depth1_config = BotConfig {
            search_depth: 1,
            ..preset(BotLevel::Hard)
        };
        let depth2_config = BotConfig {
            search_depth: 2,
            ..preset(BotLevel::Hard)
        };

        for seed in 0..15u32 {
            let state = advance_game(&fresh_game(seed), 3, 99);
            if legal_moves(&state).len() < 2 {
                continue;
            }

            let greedy_move = greedy_best_moves(&state, 0, &depth1_config)[0];
            let greedy_value = evaluate(&apply_move(&state, &greedy_move), 0, &depth1_config);

            let search_move = search_best_move(&state, 0, &depth2_config, &mut make_rng(seed));
            let search_immediate_value =
                evaluate(&apply_move(&state, &search_move), 0, &depth2_config);

            assert!(is_legal_move(&state, &search_move));
            // Loose sanity bound: search may sacrifice immediate score for
            // lookahead, but not unboundedly so on these states.
            assert!(search_immediate_value >= greedy_value - 20.0);
        }
    }

    #[test]
    fn search_at_least_as_good_as_greedy_on_round_end() {
        let config = preset(BotLevel::Hard);
        let mut difference_found = false;
        let mut search_wins = 0;
        let mut greedy_wins = 0;

        for seed in 0..40u32 {
            let state = advance_game(&fresh_game(seed), 3, 99);
            if legal_moves(&state).len() < 2 {
                continue;
            }

            let greedy_move = greedy_best_moves(&state, 0, &config)[0];
            let search_move = search_best_move(&state, 0, &config, &mut make_rng(seed));

            if search_move == greedy_move {
                continue;
            }

            difference_found = true;
            let search_score = simulate_round_end_score(&apply_move(&state, &search_move), 0);
            let greedy_score = simulate_round_end_score(&apply_move(&state, &greedy_move), 0);

            if search_score >= greedy_score {
                search_wins += 1;
            } else {
                greedy_wins += 1;
            }
        }

        if difference_found {
            assert!(
                search_wins >= greedy_wins,
                "search_wins={search_wins} greedy_wins={greedy_wins}"
            );
        }
    }
}
