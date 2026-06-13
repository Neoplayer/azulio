use azul_shared::{
    COLORS, Color, GamePhase, GameState, Move, MoveSource, MoveTarget, PlayerId, PlayerView,
    PlayerViewPlayer,
};

use crate::moves::legal_moves;

fn complete_rows(wall: &[Vec<Option<Color>>]) -> i32 {
    wall.iter()
        .filter(|row| row.iter().all(|c| c.is_some()))
        .count() as i32
}

fn complete_cols(wall: &[Vec<Option<Color>>]) -> i32 {
    let mut n = 0;
    for c in 0..5 {
        if wall.iter().all(|row| row[c].is_some()) {
            n += 1;
        }
    }
    n
}

fn complete_colors(wall: &[Vec<Option<Color>>]) -> i32 {
    let mut n = 0;
    for color in COLORS {
        let mut count = 0;
        for row in wall {
            if row.contains(&Some(color)) {
                count += 1;
            }
        }
        if count == 5 {
            n += 1;
        }
    }
    n
}

/// Add end-of-game bonuses, set the winner(s) with tie-breaks, mark finished.
pub fn finalize_scores(state: &GameState) -> GameState {
    let mut next: GameState = state.clone();

    for player in &mut next.players {
        let wall = &player.board.wall;
        player.board.score +=
            complete_rows(wall) * 2 + complete_cols(wall) * 7 + complete_colors(wall) * 10;
    }

    let max_score = next
        .players
        .iter()
        .map(|p| p.board.score)
        .max()
        .expect("at least one player");
    let top_scorers: Vec<&_> = next
        .players
        .iter()
        .filter(|p| p.board.score == max_score)
        .collect();

    let winners: Vec<PlayerId> = if top_scorers.len() == 1 {
        vec![top_scorers[0].id.clone()]
    } else {
        let max_rows = top_scorers
            .iter()
            .map(|p| complete_rows(&p.board.wall))
            .max()
            .expect("non-empty top scorers");
        top_scorers
            .iter()
            .filter(|p| complete_rows(&p.board.wall) == max_rows)
            .map(|p| p.id.clone())
            .collect()
    };

    next.winner_ids = Some(winners);
    next.phase = GamePhase::Finished;
    next
}

/// Floor cost (tiles that would end on the floor) for a candidate move.
fn floor_cost(state: &GameState, mv: &Move) -> i32 {
    let pool: &[Color] = match mv.source {
        MoveSource::Factory { index } => &state.factories[index],
        MoveSource::Center => &state.center,
    };
    let taken = pool.iter().filter(|&&c| c == mv.color).count() as i32;
    let marker_cost = if matches!(mv.source, MoveSource::Center) && state.center_has_first_token {
        1
    } else {
        0
    };

    match mv.target {
        MoveTarget::Floor => taken + marker_cost,
        MoveTarget::PatternLine { row } => {
            let line = &state.players[state.current_player_index]
                .board
                .pattern_lines[row];
            let free_slots = line.iter().filter(|c| c.is_none()).count() as i32;
            (taken - free_slots).max(0) + marker_cost
        }
    }
}

fn source_rank(state: &GameState, mv: &Move) -> i32 {
    match mv.source {
        MoveSource::Factory { index } => index as i32,
        MoveSource::Center => state.factories.len() as i32,
    }
}

fn target_rank(mv: &Move) -> i32 {
    match mv.target {
        MoveTarget::PatternLine { row } => row as i32,
        MoveTarget::Floor => 5,
    }
}

/// Lexicographic ranking key: [floor cost, source index, colour order, target row].
type RankKey = [i32; 4];

fn rank_key(state: &GameState, mv: &Move) -> RankKey {
    [
        floor_cost(state, mv),
        source_rank(state, mv),
        mv.color.index() as i32,
        target_rank(mv),
    ]
}

/// Deterministic timeout move: minimise floor cost, then break ties by
/// source index, colour order, and target row (floor last).
pub fn auto_move(state: &GameState) -> Move {
    let candidates = legal_moves(state);
    assert!(
        !candidates.is_empty(),
        "autoMove called with no legal moves"
    );
    let mut best = candidates[0];
    let mut best_key = rank_key(state, &best);
    for m in &candidates[1..] {
        let key = rank_key(state, m);
        if key < best_key {
            best = *m;
            best_key = key;
        }
    }
    best
}

/// Build the redacted public view for `player_id`. The bag composition is
/// hidden (only `bag_count` is exposed). Every player defaults to connected;
/// the server overrides the flag per socket.
pub fn to_player_view(state: &GameState, player_id: &str) -> PlayerView {
    PlayerView {
        players: state
            .players
            .iter()
            .map(|p| PlayerViewPlayer {
                id: p.id.clone(),
                name: p.name.clone(),
                board: p.board.clone(),
                connected: true,
            })
            .collect(),
        factories: state.factories.clone(),
        center: state.center.clone(),
        center_has_first_token: state.center_has_first_token,
        bag_count: state.bag.len(),
        discard: state.discard.clone(),
        current_player_id: state.players[state.current_player_index].id.clone(),
        first_player_id: state.players[state.first_player_index].id.clone(),
        phase: state.phase,
        round: state.round,
        turn_seq: state.turn_seq,
        you: player_id.to_string(),
        winner_ids: state.winner_ids.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PlayerInfo, create_game, is_legal_move};

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

    const FULL_ROW: [Color; 5] = [
        Color::Blue,
        Color::Yellow,
        Color::Red,
        Color::Black,
        Color::White,
    ];

    fn base() -> GameState {
        let mut s = create_game(&players2(), 1);
        s.factories = vec![vec![], vec![], vec![], vec![], vec![]];
        s.center = vec![];
        s.center_has_first_token = false;
        s.bag = vec![];
        s.discard = vec![];
        s
    }

    fn row_to_options(row: [Color; 5]) -> Vec<Option<Color>> {
        row.iter().map(|&c| Some(c)).collect()
    }

    // --- finalizeScores — bonuses ---

    #[test]
    fn adds_two_for_each_complete_row() {
        let mut s = base();
        s.players[0].board.wall[0] = row_to_options(FULL_ROW);
        s.players[0].board.score = 0;
        let next = finalize_scores(&s);
        assert_eq!(next.players[0].board.score, 2);
    }

    #[test]
    fn adds_column_and_color_bonuses_for_full_wall() {
        let mut s = base();
        // canonical wall pattern -> 5 rows(+10), 5 cols(+35), 5 colours(+50)
        let pattern: [[Color; 5]; 5] = [
            [
                Color::Blue,
                Color::Yellow,
                Color::Red,
                Color::Black,
                Color::White,
            ],
            [
                Color::White,
                Color::Blue,
                Color::Yellow,
                Color::Red,
                Color::Black,
            ],
            [
                Color::Black,
                Color::White,
                Color::Blue,
                Color::Yellow,
                Color::Red,
            ],
            [
                Color::Red,
                Color::Black,
                Color::White,
                Color::Blue,
                Color::Yellow,
            ],
            [
                Color::Yellow,
                Color::Red,
                Color::Black,
                Color::White,
                Color::Blue,
            ],
        ];
        for (r, row) in pattern.iter().enumerate() {
            s.players[0].board.wall[r] = row_to_options(*row);
        }
        s.players[0].board.score = 0;
        let next = finalize_scores(&s);
        assert_eq!(next.players[0].board.score, 5 * 2 + 5 * 7 + 5 * 10);
    }

    #[test]
    fn sets_finished_and_picks_highest_score_winner() {
        let mut s = base();
        s.players[0].board.score = 20;
        s.players[1].board.score = 15;
        let next = finalize_scores(&s);
        assert_eq!(next.phase, GamePhase::Finished);
        assert_eq!(next.winner_ids, Some(vec!["p1".to_string()]));
    }

    #[test]
    fn breaks_ties_by_complete_rows_then_shared_win() {
        let mut s = base();
        s.players[0].board.score = 10;
        s.players[1].board.score = 10;
        s.players[0].board.wall[0] = row_to_options(FULL_ROW); // p1 has one more complete row
        let next = finalize_scores(&s);
        // p1 gets +2 for the row -> 12 vs 10, clear winner
        assert_eq!(next.winner_ids, Some(vec!["p1".to_string()]));

        let mut s2 = base();
        s2.players[0].board.score = 10;
        s2.players[1].board.score = 10;
        let tie = finalize_scores(&s2);
        let mut ids = tie.winner_ids.clone().unwrap();
        ids.sort();
        assert_eq!(ids, vec!["p1".to_string(), "p2".to_string()]);
    }

    // --- autoMove ---

    #[test]
    fn auto_move_returns_a_legal_move() {
        let mut s = base();
        s.factories = vec![
            vec![Color::Blue, Color::Blue, Color::Red, Color::White],
            vec![],
            vec![],
            vec![],
            vec![],
        ];
        let mv = auto_move(&s);
        assert!(is_legal_move(&s, &mv));
    }

    #[test]
    fn auto_move_is_deterministic() {
        let mut s = base();
        s.factories = vec![
            vec![Color::Blue, Color::Red, Color::Red, Color::White],
            vec![Color::Yellow, Color::Yellow, Color::Black, Color::Black],
            vec![],
            vec![],
            vec![],
        ];
        assert_eq!(auto_move(&s), auto_move(&s));
    }

    #[test]
    fn auto_move_prefers_no_floor() {
        let mut s = base();
        // a single blue fits cleanly into pattern row 0 (capacity 1) -> 0 floor cost
        s.factories = vec![
            vec![Color::Blue, Color::Red, Color::White, Color::Black],
            vec![],
            vec![],
            vec![],
            vec![],
        ];
        let mv = auto_move(&s);
        assert!(matches!(mv.target, MoveTarget::PatternLine { .. }));
    }

    // --- toPlayerView ---

    #[test]
    fn hides_bag_composition_exposing_only_count() {
        let mut s = base();
        s.bag = vec![Color::Blue; 17];
        let view = to_player_view(&s, "p1");
        assert_eq!(view.bag_count, 17);
        // The PlayerView struct simply has no `bag` field — nothing to assert
        // beyond the exposed count.
    }

    #[test]
    fn marks_receiving_player_and_maps_ids() {
        let mut s = base();
        s.current_player_index = 1;
        s.first_player_index = 0;
        let view = to_player_view(&s, "p2");
        assert_eq!(view.you, "p2");
        assert_eq!(view.current_player_id, "p2");
        assert_eq!(view.first_player_id, "p1");
        assert!(view.players.iter().all(|p| p.connected));
    }
}
