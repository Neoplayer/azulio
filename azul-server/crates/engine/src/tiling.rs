use azul_shared::{Color, FLOOR_PENALTIES, FloorSlot, GameState, PlayerBoard};

use crate::moves::wall_column_for_color;

pub fn is_offer_phase_over(state: &GameState) -> bool {
    state.factories.iter().all(|f| f.is_empty()) && state.center.is_empty()
}

/// Contiguous run length through (row,col) along a direction, including the
/// cell itself.
fn run_length(
    wall: &[Vec<Option<Color>>],
    row: usize,
    col: usize,
    d_row: isize,
    d_col: isize,
) -> i32 {
    let mut count = 1;
    let mut r = row as isize + d_row;
    let mut c = col as isize + d_col;
    while (0..5).contains(&r) && (0..5).contains(&c) {
        if wall[r as usize][c as usize].is_none() {
            break;
        }
        count += 1;
        r += d_row;
        c += d_col;
    }
    count
}

/// Score for placing a tile at (row,col), per the Azul adjacency rule.
pub fn score_placement(wall: &[Vec<Option<Color>>], row: usize, col: usize) -> i32 {
    let h = run_length(wall, row, col, 0, -1) + run_length(wall, row, col, 0, 1) - 1;
    let v = run_length(wall, row, col, -1, 0) + run_length(wall, row, col, 1, 0) - 1;
    if h == 1 && v == 1 {
        return 1;
    }
    (if h > 1 { h } else { 0 }) + (if v > 1 { v } else { 0 })
}

fn floor_penalty(board: &PlayerBoard) -> i32 {
    // Sum the penalty of each occupied slot, capped at the floor's capacity
    // (`take` stops at min(floor.len(), FLOOR_PENALTIES.len())).
    FLOOR_PENALTIES.iter().take(board.floor.len()).sum()
}

/// Wall-tiling phase: for every player, tile completed pattern lines, score
/// them, apply floor penalties, clear floors, return the first-player marker to
/// the center. Pure: returns a new state.
pub fn resolve_tiling(state: &GameState) -> GameState {
    let mut next: GameState = state.clone();

    for player in &mut next.players {
        let board = &mut player.board;

        for row in 0..5 {
            let line = &board.pattern_lines[row];
            let is_full = line.iter().all(|c| c.is_some());
            if !is_full {
                continue;
            }

            let color = line[0].expect("full line has a colour in slot 0");
            let col = wall_column_for_color(row, color);
            board.wall[row][col] = Some(color);
            board.score += score_placement(&board.wall, row, col);

            // one tile to the wall, the rest of the line to discard
            let len = board.pattern_lines[row].len();
            for _ in 1..len {
                next.discard.push(color);
            }
            board.pattern_lines[row] = vec![None; len];
        }

        // floor penalties (applied every round, including the last)
        board.score = (board.score + floor_penalty(board)).max(0);

        // discard floor colour tiles, return the marker to the center
        for slot in &board.floor {
            match slot {
                FloorSlot::First => next.center_has_first_token = true,
                FloorSlot::Tile(c) => next.discard.push(*c),
            }
        }
        board.floor = Vec::new();
    }

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

    /// Deterministic tiling base: wipe randomness-dependent fields.
    fn base() -> GameState {
        let mut s = create_game(&players2(), 1);
        s.factories = vec![vec![], vec![], vec![], vec![], vec![]];
        s.center = vec![];
        s.center_has_first_token = false;
        s.bag = vec![];
        s.discard = vec![];
        s
    }

    fn full_line(color: Color, capacity: usize) -> Vec<Option<Color>> {
        vec![Some(color); capacity]
    }

    // --- isOfferPhaseOver ---

    #[test]
    fn offer_phase_over_false_while_tiles_remain() {
        let mut s = base();
        s.factories[0] = vec![Color::Blue];
        assert!(!is_offer_phase_over(&s));
        s.factories[0] = vec![];
        s.center = vec![Color::Red];
        assert!(!is_offer_phase_over(&s));
    }

    #[test]
    fn offer_phase_over_true_when_empty_marker_does_not_matter() {
        let mut s = base();
        s.center_has_first_token = true;
        assert!(is_offer_phase_over(&s));
    }

    // --- resolveTiling — wall placement ---

    #[test]
    fn moves_one_tile_from_full_line_and_discards_rest() {
        let mut s = base();
        // row 2 capacity 3, full of blue -> wall[2][col blue]=blue, 2 to discard
        s.players[0].board.pattern_lines[2] = full_line(Color::Blue, 3);
        let next = resolve_tiling(&s);
        // WALL_PATTERN[2] = black,white,blue,yellow,red -> blue is column 2
        assert_eq!(next.players[0].board.wall[2][2], Some(Color::Blue));
        assert!(
            next.players[0].board.pattern_lines[2]
                .iter()
                .all(|c| c.is_none())
        );
        assert_eq!(
            next.discard.iter().filter(|&&c| c == Color::Blue).count(),
            2
        );
    }

    #[test]
    fn leaves_partial_pattern_lines_untouched() {
        let mut s = base();
        s.players[0].board.pattern_lines[3] = vec![Some(Color::Red), Some(Color::Red), None, None]; // 2/4 -> stays
        let next = resolve_tiling(&s);
        assert_eq!(
            next.players[0].board.pattern_lines[3],
            vec![Some(Color::Red), Some(Color::Red), None, None]
        );
        assert!(next.players[0].board.wall[3].iter().all(|c| c.is_none()));
    }

    // --- resolveTiling — scoring algorithm ---

    #[test]
    fn scores_isolated_tile_as_one() {
        let mut s = base();
        s.players[0].board.pattern_lines[0] = full_line(Color::Blue, 1);
        let next = resolve_tiling(&s);
        assert_eq!(next.players[0].board.score, 1);
    }

    #[test]
    fn scores_horizontal_run_by_length_only() {
        let mut s = base();
        // pre-place white at wall[2][1]; place blue at wall[2][2] -> h run of 2
        s.players[0].board.wall[2][1] = Some(Color::White);
        s.players[0].board.pattern_lines[2] = full_line(Color::Blue, 3);
        let next = resolve_tiling(&s);
        assert_eq!(next.players[0].board.score, 2);
    }

    #[test]
    fn scores_vertical_run_by_length_only() {
        let mut s = base();
        // column 2: pre-place rows 1 and 3, then place row 2 -> v run of 3
        s.players[0].board.wall[1][2] = Some(Color::Yellow);
        s.players[0].board.wall[3][2] = Some(Color::White);
        s.players[0].board.pattern_lines[2] = full_line(Color::Blue, 3);
        let next = resolve_tiling(&s);
        assert_eq!(next.players[0].board.score, 3);
    }

    #[test]
    fn scores_both_axes_with_h_and_v_neighbours() {
        let mut s = base();
        s.players[0].board.wall[2][1] = Some(Color::White); // horizontal neighbour
        s.players[0].board.wall[1][2] = Some(Color::Yellow); // vertical neighbour
        s.players[0].board.pattern_lines[2] = full_line(Color::Blue, 3);
        let next = resolve_tiling(&s);
        // h = 2 (cols 1,2), v = 2 (rows 1,2) -> 4
        assert_eq!(next.players[0].board.score, 4);
    }

    // --- resolveTiling — floor penalties & marker ---

    #[test]
    fn subtracts_floor_penalties_never_below_zero() {
        let mut s = base();
        s.players[0].board.score = 1;
        s.players[0].board.floor = vec![
            FloorSlot::Tile(Color::Blue),
            FloorSlot::Tile(Color::Red),
            FloorSlot::Tile(Color::White),
        ]; // -1 -1 -2 = -4
        let next = resolve_tiling(&s);
        assert_eq!(next.players[0].board.score, 0);
        assert_eq!(next.players[0].board.floor, Vec::<FloorSlot>::new());
    }

    #[test]
    fn penalises_first_marker_and_returns_it_to_center() {
        let mut s = base();
        s.players[0].board.score = 5;
        s.players[0].board.floor = vec![FloorSlot::First, FloorSlot::Tile(Color::Blue)]; // -1 -1 = -2
        s.first_player_index = 0;
        let next = resolve_tiling(&s);
        assert_eq!(next.players[0].board.score, 3);
        assert_eq!(next.players[0].board.floor, Vec::<FloorSlot>::new());
        assert!(next.center_has_first_token);
    }
}
