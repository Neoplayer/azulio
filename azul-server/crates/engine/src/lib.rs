pub mod bot;
pub mod finalize;
pub mod moves;
pub mod next_round;
pub mod rng;
pub mod tiling;

pub use finalize::{auto_move, finalize_scores, to_player_view};
pub use moves::{apply_move, is_legal_move, legal_moves, wall_column_for_color};
pub use next_round::{is_game_over, start_next_round};
pub use rng::{Mulberry32, make_rng, shuffle};
pub use tiling::{is_offer_phase_over, resolve_tiling, score_placement};

use azul_shared::{
    COLORS, Color, GamePhase, GameState, PlayerBoard, PlayerSlot, TILES_PER_COLOR,
    TILES_PER_FACTORY, factory_count_by_players,
};

/// Player identity passed to `create_game`.
#[derive(Debug, Clone)]
pub struct PlayerInfo {
    pub id: String,
    pub name: String,
}

fn make_full_bag() -> Vec<Color> {
    let mut bag = Vec::with_capacity(COLORS.len() * TILES_PER_COLOR);
    for color in COLORS {
        for _ in 0..TILES_PER_COLOR {
            bag.push(color);
        }
    }
    bag
}

fn empty_board() -> PlayerBoard {
    let mut pattern_lines: Vec<Vec<Option<Color>>> = Vec::with_capacity(5);
    for cap in 1..=5 {
        pattern_lines.push(vec![None; cap]);
    }
    let wall = vec![vec![None; 5]; 5];
    PlayerBoard {
        pattern_lines,
        wall,
        floor: Vec::new(),
        score: 0,
    }
}

/// Create a fresh game for the given players, seeded for reproducibility.
/// Panics if the player count is not 2..=4 (mirrors the TS `throw`).
pub fn create_game(player_infos: &[PlayerInfo], seed: u32) -> GameState {
    let factory_count = factory_count_by_players(player_infos.len()).unwrap_or_else(|| {
        panic!(
            "Unsupported player count: {} (expected 2-4)",
            player_infos.len()
        )
    });

    let mut rng = make_rng(seed);
    let mut bag = shuffle(&make_full_bag(), &mut rng);

    let mut factories: Vec<Vec<Color>> = Vec::with_capacity(factory_count);
    for _ in 0..factory_count {
        let factory: Vec<Color> = bag.drain(0..TILES_PER_FACTORY).collect();
        factories.push(factory);
    }

    let players: Vec<PlayerSlot> = player_infos
        .iter()
        .map(|p| PlayerSlot {
            id: p.id.clone(),
            name: p.name.clone(),
            board: empty_board(),
        })
        .collect();

    GameState {
        players,
        factories,
        center: Vec::new(),
        center_has_first_token: true,
        bag,
        discard: Vec::new(),
        current_player_index: 0,
        first_player_index: 0,
        phase: GamePhase::Offer,
        round: 1,
        winner_ids: None,
        rng_seed: seed,
        turn_seq: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use azul_shared::FloorSlot;

    fn players2() -> Vec<PlayerInfo> {
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

    fn info(id: &str, name: &str) -> PlayerInfo {
        PlayerInfo {
            id: id.into(),
            name: name.into(),
        }
    }

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
            n += p
                .board
                .floor
                .iter()
                .filter(|s| !matches!(s, FloorSlot::First))
                .count();
        }
        n
    }

    #[test]
    fn creates_five_factories_of_four_for_two_players() {
        let state = create_game(&players2(), 123);
        assert_eq!(state.factories.len(), 5);
        for f in &state.factories {
            assert_eq!(f.len(), 4);
        }
    }

    #[test]
    fn creates_seven_and_nine_factories_for_three_and_four_players() {
        let s3 = create_game(&[info("a", "A"), info("b", "B"), info("c", "C")], 1);
        let s4 = create_game(
            &[
                info("a", "A"),
                info("b", "B"),
                info("c", "C"),
                info("d", "D"),
            ],
            1,
        );
        assert_eq!(s3.factories.len(), 7);
        assert_eq!(s4.factories.len(), 9);
    }

    #[test]
    fn conserves_exactly_one_hundred_tiles() {
        let state = create_game(&players2(), 7);
        assert_eq!(COLORS.len() * TILES_PER_COLOR, 100);
        assert_eq!(total_tiles(&state), 100);
    }

    #[test]
    fn puts_first_marker_in_center_and_leaves_center_empty() {
        let state = create_game(&players2(), 7);
        assert!(state.center_has_first_token);
        assert_eq!(state.center, Vec::<Color>::new());
    }

    #[test]
    fn starts_each_player_with_empty_board() {
        let state = create_game(&players2(), 7);
        assert_eq!(state.players.len(), 2);
        for p in &state.players {
            let caps: Vec<usize> = p.board.pattern_lines.iter().map(|l| l.len()).collect();
            assert_eq!(caps, vec![1, 2, 3, 4, 5]);
            assert!(
                p.board
                    .pattern_lines
                    .iter()
                    .all(|l| l.iter().all(|c| c.is_none()))
            );
            assert_eq!(p.board.wall.len(), 5);
            assert!(
                p.board
                    .wall
                    .iter()
                    .all(|row| row.len() == 5 && row.iter().all(|c| c.is_none()))
            );
            assert_eq!(p.board.floor, Vec::<FloorSlot>::new());
            assert_eq!(p.board.score, 0);
        }
    }

    #[test]
    fn starts_in_offer_phase_round_one_player_zero_turn_seq_zero() {
        let state = create_game(&players2(), 7);
        assert_eq!(state.phase, GamePhase::Offer);
        assert_eq!(state.round, 1);
        assert_eq!(state.current_player_index, 0);
        assert_eq!(state.turn_seq, 0);
        assert_eq!(state.winner_ids, None);
    }

    #[test]
    fn is_deterministic_for_a_given_seed() {
        let a = create_game(&players2(), 42);
        let b = create_game(&players2(), 42);
        assert_eq!(a.factories, b.factories);
        assert_eq!(a.bag, b.bag);
    }

    #[test]
    #[should_panic]
    fn panics_on_unsupported_player_count() {
        let _ = create_game(&[info("solo", "Solo")], 1);
    }
}
