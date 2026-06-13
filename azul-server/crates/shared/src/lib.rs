use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub mod protocol;
pub use protocol::*;

pub type PlayerId = String;

/// The five tile colours. Declaration order matches the TS `COLORS` array and
/// is significant: `legalMoves` / `autoMove` iterate colours in this order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Color {
    Blue,
    Yellow,
    Red,
    Black,
    White,
}

impl Color {
    /// All colours in canonical order (mirrors the TS `COLORS` const).
    pub const ALL: [Color; 5] = [
        Color::Blue,
        Color::Yellow,
        Color::Red,
        Color::Black,
        Color::White,
    ];

    /// Position in the canonical colour order (0..=4). Used for tie-breaks.
    pub fn index(self) -> usize {
        match self {
            Color::Blue => 0,
            Color::Yellow => 1,
            Color::Red => 2,
            Color::Black => 3,
            Color::White => 4,
        }
    }

    /// Lowercase wire string (`"blue"`, ...).
    pub fn as_str(self) -> &'static str {
        match self {
            Color::Blue => "blue",
            Color::Yellow => "yellow",
            Color::Red => "red",
            Color::Black => "black",
            Color::White => "white",
        }
    }
}

/// All colours in canonical order (mirrors the TS `COLORS` const).
pub const COLORS: [Color; 5] = Color::ALL;

/// Floor-line penalties by slot index (left to right).
pub const FLOOR_PENALTIES: [i32; 7] = [-1, -1, -2, -2, -2, -3, -3];

/// Tiles per colour in a full set; 5 colours => 100 tiles.
pub const TILES_PER_COLOR: usize = 20;

/// Tiles placed on each factory at the start of a round.
pub const TILES_PER_FACTORY: usize = 4;

/// Number of factory displays for a given player count (2..=4). `None` if the
/// player count is unsupported.
pub fn factory_count_by_players(players: usize) -> Option<usize> {
    match players {
        2 => Some(5),
        3 => Some(7),
        4 => Some(9),
        _ => None,
    }
}

/// Canonical wall colour pattern (row-major, 5x5). Each colour appears exactly
/// once per row and per column (diagonal layout, standard Azul board).
pub const WALL_PATTERN: [[Color; 5]; 5] = [
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

/// A tile slot on the floor line: a colour tile or the first-player marker.
/// Serializes to a bare string: a colour (`"blue"`) or `"FIRST"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FloorSlot {
    Tile(Color),
    First,
}

impl Serialize for FloorSlot {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            FloorSlot::Tile(c) => c.serialize(s),
            FloorSlot::First => s.serialize_str("FIRST"),
        }
    }
}

impl<'de> Deserialize<'de> for FloorSlot {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        match s.as_str() {
            "FIRST" => Ok(FloorSlot::First),
            "blue" => Ok(FloorSlot::Tile(Color::Blue)),
            "yellow" => Ok(FloorSlot::Tile(Color::Yellow)),
            "red" => Ok(FloorSlot::Tile(Color::Red)),
            "black" => Ok(FloorSlot::Tile(Color::Black)),
            "white" => Ok(FloorSlot::Tile(Color::White)),
            other => Err(serde::de::Error::custom(format!(
                "invalid FloorSlot: {other}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlayerBoard {
    /// 5 pattern lines of capacity 1..=5; entries are the colour placed, or None.
    /// NOTE: a fresh board's lines are capacity-sized arrays of `null`
    /// (`[[null],[null,null],...]`), NOT empty arrays. The PROTOCOL.md example
    /// is simplified; `emptyBoard` (engine) fills with null and the web client
    /// already consumes that shape — match it.
    pub pattern_lines: Vec<Vec<Option<Color>>>,
    /// 5x5 wall; None = not yet tiled, otherwise the colour placed.
    pub wall: Vec<Vec<Option<Color>>>,
    /// Tiles/marker currently on the floor line, in placement order.
    /// `FloorSlot` has a hand-written serde impl (a bare string: a colour or
    /// `"FIRST"`), so ts-rs cannot derive it — override the TS shape here.
    #[ts(type = "Array<Color | \"FIRST\">")]
    pub floor: Vec<FloorSlot>,
    pub score: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum GamePhase {
    Offer,
    Tiling,
    Finished,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlayerSlot {
    pub id: PlayerId,
    pub name: String,
    pub board: PlayerBoard,
}

/// Full authoritative game state (engine-internal; NOT sent over the wire —
/// the wire payload is the redacted `PlayerView`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameState {
    pub players: Vec<PlayerSlot>,
    pub factories: Vec<Vec<Color>>,
    pub center: Vec<Color>,
    pub center_has_first_token: bool,
    pub bag: Vec<Color>,
    pub discard: Vec<Color>,
    pub current_player_index: usize,
    /// Who starts the next round (set when the first-player marker is taken).
    pub first_player_index: usize,
    pub phase: GamePhase,
    pub round: u32,
    pub winner_ids: Option<Vec<PlayerId>>,
    /// Seed for deterministic shuffling / replays.
    pub rng_seed: u32,
    /// Monotonic move counter; +1 on each applyMove. Used for idempotency.
    pub turn_seq: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum MoveSource {
    Factory { index: usize },
    Center,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum MoveTarget {
    PatternLine { row: usize },
    Floor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Move {
    pub source: MoveSource,
    pub color: Color,
    pub target: MoveTarget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlayerViewPlayer {
    pub id: PlayerId,
    pub name: String,
    pub board: PlayerBoard,
    pub connected: bool,
}

/// Redacted public view broadcast to a player. The bag composition is hidden
/// (only its count is exposed) to prevent draw-probability cheating.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlayerView {
    pub players: Vec<PlayerViewPlayer>,
    pub factories: Vec<Vec<Color>>,
    pub center: Vec<Color>,
    pub center_has_first_token: bool,
    pub bag_count: usize,
    pub discard: Vec<Color>,
    pub current_player_id: PlayerId,
    pub first_player_id: PlayerId,
    pub phase: GamePhase,
    pub round: u32,
    #[ts(type = "number")]
    pub turn_seq: u64,
    pub you: PlayerId,
    pub winner_ids: Option<Vec<PlayerId>>,
}
