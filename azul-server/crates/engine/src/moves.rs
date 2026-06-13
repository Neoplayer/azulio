use azul_shared::{
    Color, FLOOR_PENALTIES, FloorSlot, GamePhase, GameState, Move, MoveSource, MoveTarget,
    PlayerBoard, WALL_PATTERN,
};

/// Floor line capacity (mirrors `FLOOR_PENALTIES.length` in TS).
const FLOOR_CAPACITY: usize = FLOOR_PENALTIES.len();

/// Column index on the wall where `color` lives in `row` (canonical pattern).
pub fn wall_column_for_color(row: usize, color: Color) -> usize {
    WALL_PATTERN[row]
        .iter()
        .position(|&c| c == color)
        .expect("every colour appears in every wall row")
}

/// True if `color` is already tiled on the wall in `row`.
fn wall_has_color_in_row(board: &PlayerBoard, row: usize, color: Color) -> bool {
    let col = wall_column_for_color(row, color);
    board.wall[row][col].is_some()
}

/// How many tiles of `color` sit in the given move source.
fn tiles_in_source(state: &GameState, source: &MoveSource, color: Color) -> usize {
    let pool: &[Color] = match source {
        MoveSource::Factory { index } => match state.factories.get(*index) {
            Some(f) => f,
            None => return 0,
        },
        MoveSource::Center => &state.center,
    };
    pool.iter().filter(|&&c| c == color).count()
}

pub fn is_legal_move(state: &GameState, mv: &Move) -> bool {
    if state.phase != GamePhase::Offer {
        return false;
    }

    if let MoveSource::Factory { index } = mv.source {
        // `index` is usize so `< 0` is impossible; only the upper bound matters.
        if index >= state.factories.len() {
            return false;
        }
    }
    if tiles_in_source(state, &mv.source, mv.color) == 0 {
        return false;
    }

    let row = match mv.target {
        MoveTarget::Floor => return true,
        MoveTarget::PatternLine { row } => row,
    };
    if row > 4 {
        return false;
    }

    let board = &state.players[state.current_player_index].board;
    let line = &board.pattern_lines[row];

    // line must have a free slot
    if line.iter().all(|c| c.is_some()) {
        return false;
    }
    // line must be empty or already hold this colour
    if line
        .iter()
        .find_map(|c| *c)
        .is_some_and(|existing| existing != mv.color)
    {
        return false;
    }
    // colour must not be tiled on the wall in this row already
    if wall_has_color_in_row(board, row, mv.color) {
        return false;
    }

    true
}

pub fn legal_moves(state: &GameState) -> Vec<Move> {
    if state.phase != GamePhase::Offer {
        return Vec::new();
    }
    let mut moves: Vec<Move> = Vec::new();

    let mut sources: Vec<MoveSource> = (0..state.factories.len())
        .map(|index| MoveSource::Factory { index })
        .collect();
    sources.push(MoveSource::Center);

    for source in &sources {
        for color in Color::ALL {
            if tiles_in_source(state, source, color) == 0 {
                continue;
            }
            for row in 0..5 {
                let m = Move {
                    source: *source,
                    color,
                    target: MoveTarget::PatternLine { row },
                };
                if is_legal_move(state, &m) {
                    moves.push(m);
                }
            }
            moves.push(Move {
                source: *source,
                color,
                target: MoveTarget::Floor,
            });
        }
    }
    moves
}

/// Push tiles onto the floor, capping at the floor capacity; excess colour
/// tiles go to discard (the FIRST marker is dropped when there is no room).
fn push_to_floor(board: &mut PlayerBoard, tiles: &[FloorSlot], discard: &mut Vec<Color>) {
    for &t in tiles {
        if board.floor.len() < FLOOR_CAPACITY {
            board.floor.push(t);
        } else if let FloorSlot::Tile(c) = t {
            discard.push(c);
        }
    }
}

/// Apply a move, returning the next state. Panics on an illegal move (TS throw).
pub fn apply_move(state: &GameState, mv: &Move) -> GameState {
    if !is_legal_move(state, mv) {
        panic!("Illegal move: {mv:?}");
    }

    let mut next: GameState = state.clone();
    let player_index = next.current_player_index;

    // 1. Collect taken tiles and route leftovers.
    let taken: usize;
    match mv.source {
        MoveSource::Factory { index } => {
            let factory = std::mem::take(&mut next.factories[index]);
            taken = factory.iter().filter(|&&c| c == mv.color).count();
            let leftovers: Vec<Color> = factory.into_iter().filter(|&c| c != mv.color).collect();
            next.center.extend(leftovers);
        }
        MoveSource::Center => {
            taken = next.center.iter().filter(|&&c| c == mv.color).count();
            next.center.retain(|&c| c != mv.color);
            if next.center_has_first_token {
                next.center_has_first_token = false;
                next.first_player_index = player_index;
                let board = &mut next.players[player_index].board;
                push_to_floor(board, &[FloorSlot::First], &mut next.discard);
            }
        }
    }

    // 2. Place taken tiles.
    match mv.target {
        MoveTarget::Floor => {
            let tiles = vec![FloorSlot::Tile(mv.color); taken];
            let board = &mut next.players[player_index].board;
            push_to_floor(board, &tiles, &mut next.discard);
        }
        MoveTarget::PatternLine { row } => {
            let board = &mut next.players[player_index].board;
            let line = &mut board.pattern_lines[row];
            let mut placed = 0usize;
            for slot in line.iter_mut() {
                if placed >= taken {
                    break;
                }
                if slot.is_none() {
                    *slot = Some(mv.color);
                    placed += 1;
                }
            }
            let overflow = taken - placed;
            if overflow > 0 {
                let tiles = vec![FloorSlot::Tile(mv.color); overflow];
                push_to_floor(board, &tiles, &mut next.discard);
            }
        }
    }

    // 3. Advance turn.
    next.current_player_index = (next.current_player_index + 1) % next.players.len();
    next.turn_seq += 1;
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

    /// Deterministic, hand-crafted offer-phase state (mirrors handState() in TS).
    fn hand_state() -> GameState {
        let mut base = create_game(&players2(), 1);
        base.factories = vec![
            vec![Color::Blue, Color::Blue, Color::Red, Color::White],
            vec![Color::Yellow, Color::Yellow, Color::Yellow, Color::Black],
        ];
        base.center = vec![];
        base.center_has_first_token = true;
        base.bag = vec![];
        base.discard = vec![];
        base
    }

    // --- isLegalMove / legalMoves ---

    #[test]
    fn rejects_color_not_present_in_source() {
        let s = hand_state();
        let mv = Move {
            source: MoveSource::Factory { index: 0 },
            color: Color::Yellow, // factory 0 has no yellow
            target: MoveTarget::PatternLine { row: 0 },
        };
        assert!(!is_legal_move(&s, &mv));
    }

    #[test]
    fn rejects_pattern_line_holding_different_color() {
        let mut s = hand_state();
        s.players[0].board.pattern_lines[1] = vec![Some(Color::Red), None];
        let mv = Move {
            source: MoveSource::Factory { index: 0 },
            color: Color::Blue,
            target: MoveTarget::PatternLine { row: 1 },
        };
        assert!(!is_legal_move(&s, &mv));
    }

    #[test]
    fn rejects_color_already_tiled_on_wall_in_row() {
        let mut s = hand_state();
        s.players[0].board.wall[0][0] = Some(Color::Blue);
        let mv = Move {
            source: MoveSource::Factory { index: 0 },
            color: Color::Blue,
            target: MoveTarget::PatternLine { row: 0 },
        };
        assert!(!is_legal_move(&s, &mv));
    }

    #[test]
    fn rejects_full_pattern_line() {
        let mut s = hand_state();
        s.players[0].board.pattern_lines[0] = vec![Some(Color::Blue)];
        let mv = Move {
            source: MoveSource::Factory { index: 0 },
            color: Color::Blue,
            target: MoveTarget::PatternLine { row: 0 },
        };
        assert!(!is_legal_move(&s, &mv));
    }

    #[test]
    fn allows_dumping_present_color_on_floor() {
        let s = hand_state();
        let mv = Move {
            source: MoveSource::Factory { index: 0 },
            color: Color::Blue,
            target: MoveTarget::Floor,
        };
        assert!(is_legal_move(&s, &mv));
    }

    #[test]
    fn enumerates_only_legal_moves() {
        let s = hand_state();
        let moves = legal_moves(&s);
        assert!(!moves.is_empty());
        assert!(moves.iter().all(|m| is_legal_move(&s, m)));
    }

    // --- applyMove — from factory ---

    #[test]
    fn takes_all_of_color_sends_rest_to_center_empties_factory() {
        let s = hand_state();
        let next = apply_move(
            &s,
            &Move {
                source: MoveSource::Factory { index: 0 },
                color: Color::Blue,
                target: MoveTarget::PatternLine { row: 1 },
            },
        );
        assert_eq!(next.factories[0], Vec::<Color>::new());
        let mut center = next.center.clone();
        center.sort_by_key(|c| c.index());
        assert_eq!(center, vec![Color::Red, Color::White]);
        assert_eq!(
            next.players[0].board.pattern_lines[1],
            vec![Some(Color::Blue), Some(Color::Blue)]
        );
    }

    #[test]
    fn overflows_excess_tiles_onto_floor() {
        let s = hand_state();
        let next = apply_move(
            &s,
            &Move {
                source: MoveSource::Factory { index: 0 },
                color: Color::Blue,
                target: MoveTarget::PatternLine { row: 0 }, // capacity 1, two blues taken
            },
        );
        assert_eq!(
            next.players[0].board.pattern_lines[0],
            vec![Some(Color::Blue)]
        );
        assert_eq!(
            next.players[0].board.floor,
            vec![FloorSlot::Tile(Color::Blue)]
        );
    }

    #[test]
    fn does_not_mutate_input_increments_turn_seq_advances_player() {
        let s = hand_state();
        let before = s.clone();
        let next = apply_move(
            &s,
            &Move {
                source: MoveSource::Factory { index: 0 },
                color: Color::Blue,
                target: MoveTarget::Floor,
            },
        );
        assert_eq!(s, before); // immutable
        assert_eq!(next.turn_seq, s.turn_seq + 1);
        assert_eq!(next.current_player_index, 1);
    }

    #[test]
    #[should_panic]
    fn panics_on_illegal_move() {
        let s = hand_state();
        let _ = apply_move(
            &s,
            &Move {
                source: MoveSource::Factory { index: 0 },
                color: Color::Yellow,
                target: MoveTarget::PatternLine { row: 0 },
            },
        );
    }

    #[test]
    fn illegal_move_leaves_state_untouched() {
        // Mirrors the TS assertion that a throwing applyMove does not mutate.
        // We assert via catch_unwind that the input is unchanged.
        let s = hand_state();
        let before = s.clone();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            apply_move(
                &s,
                &Move {
                    source: MoveSource::Factory { index: 0 },
                    color: Color::Yellow,
                    target: MoveTarget::PatternLine { row: 0 },
                },
            )
        }));
        assert!(result.is_err());
        assert_eq!(s, before);
    }

    // --- applyMove — from center ---

    #[test]
    fn gives_first_marker_to_first_taker_and_clears_token() {
        let mut s = hand_state();
        s.factories = vec![
            vec![Color::Blue, Color::Red, Color::Red, Color::White],
            vec![],
        ];
        s.center = vec![Color::Yellow, Color::Yellow];
        s.center_has_first_token = true;
        let next = apply_move(
            &s,
            &Move {
                source: MoveSource::Center,
                color: Color::Yellow,
                target: MoveTarget::PatternLine { row: 1 },
            },
        );
        assert!(!next.center_has_first_token);
        assert!(next.players[0].board.floor.contains(&FloorSlot::First));
        assert_eq!(
            next.players[0].board.pattern_lines[1],
            vec![Some(Color::Yellow), Some(Color::Yellow)]
        );
        assert_eq!(next.first_player_index, 0);
    }

    #[test]
    fn does_not_grant_marker_again_once_taken() {
        let mut s = hand_state();
        s.factories = vec![vec![], vec![]];
        s.center = vec![Color::Yellow, Color::Yellow, Color::Red];
        s.center_has_first_token = true;
        let s = apply_move(
            &s,
            &Move {
                source: MoveSource::Center,
                color: Color::Yellow,
                target: MoveTarget::Floor,
            },
        );
        // player 1 now takes red from center; no marker left
        let next = apply_move(
            &s,
            &Move {
                source: MoveSource::Center,
                color: Color::Red,
                target: MoveTarget::Floor,
            },
        );
        assert!(!next.players[1].board.floor.contains(&FloorSlot::First));
    }
}
