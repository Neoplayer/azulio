use azul_engine::bot::{BotConfig, BotLevel, preset, search_best_move, select_move};
use azul_engine::{
    PlayerInfo, apply_move, create_game, finalize_scores, is_game_over, is_offer_phase_over,
    legal_moves, make_rng, resolve_tiling, start_next_round,
};
use azul_shared::GameState;

struct GameResult {
    winner_ids: Vec<String>,
    #[allow(dead_code)]
    scores: Vec<i32>,
}

fn run_game(configs: &[BotConfig], game_seed: u32) -> GameResult {
    let player_infos: Vec<PlayerInfo> = configs
        .iter()
        .enumerate()
        .map(|(i, _)| PlayerInfo {
            id: format!("player{i}"),
            name: format!("P{i}"),
        })
        .collect();
    let mut state: GameState = create_game(&player_infos, game_seed);
    // Each player gets an independent seeded RNG derived from the game seed.
    let mut rngs: Vec<_> = configs
        .iter()
        .enumerate()
        .map(|(i, _)| make_rng(game_seed.wrapping_mul(997).wrapping_add(i as u32 * 131)))
        .collect();

    const MAX_TURNS: u32 = 600; // safety cap against infinite loops
    let mut turns = 0;

    while turns < MAX_TURNS {
        if is_offer_phase_over(&state) {
            state = resolve_tiling(&state);
            if is_game_over(&state) {
                state = finalize_scores(&state);
                break;
            }
            state = start_next_round(&state);
            continue;
        }

        let legal = legal_moves(&state);
        if legal.is_empty() {
            break;
        }

        let pi = state.current_player_index;
        let mv = select_move(&state, pi, &configs[pi], &mut rngs[pi]);
        state = apply_move(&state, &mv);
        turns += 1;
    }

    let winner_ids = state.winner_ids.clone().unwrap_or_default();
    let scores = state.players.iter().map(|p| p.board.score).collect();
    GameResult { winner_ids, scores }
}

/// Win rate of player 0 vs player 1 over N games (0.5 for a draw).
fn win_rate(config0: BotConfig, config1: BotConfig, games: u32, base_seed: u32) -> f64 {
    let mut points0 = 0.0;

    for g in 0..games {
        let result = run_game(&[config0, config1], base_seed + g);
        let w0 = result.winner_ids.iter().any(|id| id == "player0");
        let w1 = result.winner_ids.iter().any(|id| id == "player1");
        if w0 && !w1 {
            points0 += 1.0;
        } else if w0 && w1 {
            points0 += 0.5; // tie
        }
    }

    points0 / games as f64
}

#[test]
fn hard_beats_medium() {
    let rate = win_rate(preset(BotLevel::Hard), preset(BotLevel::Medium), 30, 1000);
    assert!(
        rate > 0.60,
        "Hard win rate vs Medium = {:.1}%",
        rate * 100.0
    );
}

#[test]
fn medium_beats_easy() {
    let rate = win_rate(preset(BotLevel::Medium), preset(BotLevel::Easy), 30, 2000);
    assert!(
        rate > 0.60,
        "Medium win rate vs Easy = {:.1}%",
        rate * 100.0
    );
}

#[test]
fn hard_move_under_budget() {
    let state = create_game(
        &[
            PlayerInfo {
                id: "a".into(),
                name: "A".into(),
            },
            PlayerInfo {
                id: "b".into(),
                name: "B".into(),
            },
            PlayerInfo {
                id: "c".into(),
                name: "C".into(),
            },
            PlayerInfo {
                id: "d".into(),
                name: "D".into(),
            },
        ],
        42,
    );
    // Advance a few moves so factories are partially depleted (mid-round).
    let mut s = state;
    let mut rng = make_rng(77);
    for _ in 0..8 {
        let legal = legal_moves(&s);
        if legal.is_empty() {
            break;
        }
        let idx = (rng.next_f64() * legal.len() as f64).floor() as usize;
        s = apply_move(&s, &legal[idx]);
    }

    let start = std::time::Instant::now();
    let _ = search_best_move(
        &s,
        s.current_player_index,
        &preset(BotLevel::Hard),
        &mut make_rng(0),
    );
    let elapsed = start.elapsed();

    assert!(
        elapsed.as_millis() < 1000,
        "Hard move took {} ms",
        elapsed.as_millis()
    );
}
