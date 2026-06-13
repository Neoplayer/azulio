use azul_engine::{
    PlayerInfo, apply_move, auto_move, create_game, finalize_scores, is_game_over,
    is_offer_phase_over, resolve_tiling, start_next_round,
};
use azul_shared::{FloorSlot, GamePhase, GameState};

fn total_tiles(state: &GameState) -> usize {
    let mut n = state.bag.len() + state.discard.len() + state.center.len();
    for f in &state.factories {
        n += f.len();
    }
    for p in &state.players {
        for line in &p.board.pattern_lines {
            n += line.iter().filter(|c| c.is_some()).count();
        }
        for row in &p.board.wall {
            n += row.iter().filter(|c| c.is_some()).count();
        }
        // floor: count only colour tiles; the FIRST marker is not a real tile
        n += p
            .board
            .floor
            .iter()
            .filter(|s| !matches!(s, FloorSlot::First))
            .count();
    }
    n
}

/// Play a full deterministic game to completion using auto_move.
fn play_full_game(seed: u32, player_count: usize) -> (GameState, usize) {
    let infos: Vec<PlayerInfo> = (0..player_count)
        .map(|i| PlayerInfo {
            id: format!("p{i}"),
            name: format!("P{i}"),
        })
        .collect();
    let mut state = create_game(&infos, seed);
    let mut rounds = 0usize;
    const MAX_ROUNDS: usize = 200;

    while state.phase != GamePhase::Finished && rounds < MAX_ROUNDS {
        // offer phase
        while !is_offer_phase_over(&state) {
            let mv = auto_move(&state);
            state = apply_move(&state, &mv);
            assert_eq!(total_tiles(&state), 100);
            for p in &state.players {
                assert!(p.board.score >= 0);
            }
        }
        // tiling phase
        state = resolve_tiling(&state);
        assert_eq!(total_tiles(&state), 100);
        for p in &state.players {
            assert!(p.board.score >= 0);
        }

        if is_game_over(&state) {
            state = finalize_scores(&state);
        } else {
            state = start_next_round(&state);
        }
        rounds += 1;
    }
    (state, rounds)
}

#[test]
fn conserves_tiles_and_terminates_with_a_winner() {
    for (seed, players) in [(1u32, 2usize), (42, 3), (7, 4), (99, 2)] {
        let (state, rounds) = play_full_game(seed, players);
        assert_eq!(state.phase, GamePhase::Finished, "seed {seed}, {players}p");
        assert!(rounds < 200, "seed {seed}, {players}p");
        assert_eq!(total_tiles(&state), 100, "seed {seed}, {players}p");

        let winners = state.winner_ids.as_ref().expect("winners set");
        assert!(!winners.is_empty(), "seed {seed}, {players}p");

        // every winner has the maximum score
        let max_score = state.players.iter().map(|p| p.board.score).max().unwrap();
        for id in winners {
            let p = state.players.iter().find(|p| &p.id == id).unwrap();
            assert_eq!(p.board.score, max_score, "seed {seed}, {players}p");
        }
    }
}
