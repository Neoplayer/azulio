use azul_shared::{Color, GamePhase, GameState, TILES_PER_FACTORY, factory_count_by_players};

use crate::rng::{Mulberry32, make_rng, shuffle};

pub fn is_game_over(state: &GameState) -> bool {
    state.players.iter().any(|p| {
        p.board
            .wall
            .iter()
            .any(|row| row.iter().all(|cell| cell.is_some()))
    })
}

/// Draw one tile, refilling the bag from the discard (reshuffled) when empty.
/// Returns `None` when both bag and discard are exhausted.
fn draw_tile(
    bag: &mut Vec<Color>,
    discard: &mut Vec<Color>,
    rng: &mut Mulberry32,
) -> Option<Color> {
    if bag.is_empty() {
        if discard.is_empty() {
            return None;
        }
        let reshuffled = shuffle(discard, rng);
        bag.extend(reshuffled);
        discard.clear();
    }
    bag.pop()
}

/// Start the next round: refill factories from the bag (reshuffling the discard
/// when needed; partial fill if tiles run out), reset the center with the
/// first-player marker, and hand the turn to the round's first player.
pub fn start_next_round(state: &GameState) -> GameState {
    let mut next: GameState = state.clone();
    // Matches the TS `next.rngSeed + next.round * 1000`; wrapping keeps it inside
    // u32 exactly as the seed type implies.
    let seed = next.rng_seed.wrapping_add(next.round.wrapping_mul(1000));
    let mut rng = make_rng(seed);
    let factory_count = factory_count_by_players(next.players.len()).expect("valid player count");

    let mut factories: Vec<Vec<Color>> = Vec::with_capacity(factory_count);
    for _ in 0..factory_count {
        let mut factory: Vec<Color> = Vec::new();
        for _ in 0..TILES_PER_FACTORY {
            match draw_tile(&mut next.bag, &mut next.discard, &mut rng) {
                Some(tile) => factory.push(tile),
                None => break,
            }
        }
        factories.push(factory);
    }

    next.factories = factories;
    next.center = Vec::new();
    next.center_has_first_token = true;
    next.current_player_index = next.first_player_index;
    next.round += 1;
    next.phase = GamePhase::Offer;
    next
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PlayerInfo, create_game};

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

    /// State just after tiling, ready for startNextRound.
    fn post_tiling() -> GameState {
        let mut s = create_game(&players2(), 1);
        s.factories = vec![vec![], vec![], vec![], vec![], vec![]];
        s.center = vec![];
        s.center_has_first_token = true; // marker returned during tiling
        s.bag = vec![];
        s.discard = vec![];
        s.round = 1;
        s.first_player_index = 1;
        s.current_player_index = 0;
        s.phase = GamePhase::Tiling;
        s
    }

    // --- startNextRound ---

    #[test]
    fn fills_every_factory_with_four_when_bag_has_enough() {
        let mut s = post_tiling();
        s.bag = vec![Color::Blue; 40];
        let next = start_next_round(&s);
        assert_eq!(next.factories.len(), 5);
        assert!(next.factories.iter().all(|f| f.len() == 4));
    }

    #[test]
    fn sets_offer_phase_first_player_and_increments_round() {
        let mut s = post_tiling();
        s.bag = vec![Color::Blue; 40];
        let next = start_next_round(&s);
        assert_eq!(next.phase, GamePhase::Offer);
        assert_eq!(next.current_player_index, 1); // = first_player_index
        assert_eq!(next.round, 2);
        assert_eq!(next.center, Vec::<Color>::new());
        assert!(next.center_has_first_token);
    }

    #[test]
    fn reshuffles_discard_into_bag_when_bag_runs_out() {
        let mut s = post_tiling();
        s.bag = vec![Color::Blue; 3]; // not enough for 5x4=20
        s.discard = vec![Color::Red; 30];
        let next = start_next_round(&s);
        let on_factories: usize = next.factories.iter().map(|f| f.len()).sum();
        assert_eq!(on_factories, 20); // 3 + 30 >= 20, so all factories full
    }

    #[test]
    fn fills_partially_when_bag_and_discard_exhausted() {
        let mut s = post_tiling();
        s.bag = vec![Color::Blue; 6]; // only 6 tiles total available
        s.discard = vec![];
        let next = start_next_round(&s);
        let on_factories: usize = next.factories.iter().map(|f| f.len()).sum();
        assert_eq!(on_factories, 6);
        assert_eq!(next.bag.len(), 0);
        assert_eq!(next.discard.len(), 0);
    }

    // --- isGameOver ---

    #[test]
    fn game_over_false_when_no_row_complete() {
        let mut s = post_tiling();
        s.players[0].board.wall[0] = vec![
            Some(Color::Blue),
            Some(Color::Yellow),
            Some(Color::Red),
            Some(Color::Black),
            None,
        ];
        assert!(!is_game_over(&s));
    }

    #[test]
    fn game_over_true_with_complete_row() {
        let mut s = post_tiling();
        s.players[1].board.wall[3] = vec![
            Some(Color::Red),
            Some(Color::Black),
            Some(Color::White),
            Some(Color::Blue),
            Some(Color::Yellow),
        ];
        assert!(is_game_over(&s));
    }
}
