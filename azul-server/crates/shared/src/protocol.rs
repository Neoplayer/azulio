use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{Move, MoveTarget, PlayerView};

/// AI difficulty level. In the TS codebase this is duplicated in both
/// shared/protocol.ts and engine/bot/types.ts to avoid a shared<->engine
/// dependency cycle. In Rust, `azul-engine` depends on `azul-shared`, so the
/// engine bot reuses THIS type — there is no duplicate and the mutual
/// assignability guard test is obsolete.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum BotLevel {
    Easy,
    Medium,
    Hard,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum RoomStatus {
    Waiting,
    Playing,
    Finished,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RoomPlayerBot {
    pub level: BotLevel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RoomPlayer {
    pub id: String,
    pub name: String,
    /// Present for AI players; absent for humans (`bot?` in TS -> omit when None).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    // The wire omits `bot` for humans (skip_serializing_if); mirror that as an
    // optional TS field since ts-rs ignores the serde attr above.
    #[ts(optional)]
    pub bot: Option<RoomPlayerBot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Room {
    pub id: String,
    pub name: String,
    pub host_id: String,
    pub max_players: u32,
    pub players: Vec<RoomPlayer>,
    pub status: RoomStatus,
    pub is_private: bool,
    /// ISO-8601 timestamp string.
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ScoreEntry {
    #[serde(rename = "playerId")]
    pub player_id: String,
    pub score: i32,
}

/// Every valid client->server message. Internally tagged on `type`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type")]
#[ts(export)]
pub enum ClientMessage {
    #[serde(rename = "hello")]
    Hello {
        token: String,
        #[serde(rename = "roomId", skip_serializing_if = "Option::is_none", default)]
        // ts-rs can't parse the combined serde attr above (it ignores it), so
        // restate the rename + optionality for codegen explicitly.
        #[ts(optional, rename = "roomId")]
        room_id: Option<String>,
    },
    #[serde(rename = "lobby:subscribe")]
    LobbySubscribe,
    #[serde(rename = "room:create")]
    RoomCreate {
        name: String,
        #[serde(rename = "maxPlayers")]
        max_players: u32,
        #[serde(rename = "isPrivate")]
        is_private: bool,
    },
    #[serde(rename = "room:join")]
    RoomJoin {
        #[serde(rename = "roomId")]
        room_id: String,
    },
    #[serde(rename = "room:leave")]
    RoomLeave {
        #[serde(rename = "roomId")]
        room_id: String,
    },
    #[serde(rename = "room:start")]
    RoomStart {
        #[serde(rename = "roomId")]
        room_id: String,
    },
    #[serde(rename = "game:move")]
    GameMove {
        #[serde(rename = "move")]
        mv: Move,
        #[serde(rename = "expectedTurnSeq")]
        #[ts(type = "number")]
        expected_turn_seq: i64,
    },
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "room:addBot")]
    RoomAddBot {
        #[serde(rename = "roomId")]
        room_id: String,
        level: BotLevel,
    },
}

impl ClientMessage {
    /// Range/length constraints that serde alone does not enforce (these were
    /// zod refinements in the TS schema). Returns Err with a message on failure.
    pub fn validate(&self) -> Result<(), String> {
        match self {
            ClientMessage::RoomCreate {
                name, max_players, ..
            } => {
                if name.is_empty() {
                    return Err("name must be non-empty".into());
                }
                if !(2..=4).contains(max_players) {
                    return Err("maxPlayers must be between 2 and 4".into());
                }
            }
            ClientMessage::GameMove { mv, .. } => {
                if let MoveTarget::PatternLine { row } = mv.target
                    && row > 4
                {
                    return Err("patternLine row must be between 0 and 4".into());
                }
            }
            _ => {}
        }
        Ok(())
    }
}

/// Parse and validate a raw WebSocket text frame as a `ClientMessage`.
/// Mirrors `parseClientMessage` (JSON.parse + zod). Returns Err on any
/// malformed frame (bad `type`, missing field, out-of-range value).
pub fn parse_client_message(raw: &str) -> Result<ClientMessage, String> {
    let msg: ClientMessage = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    msg.validate()?;
    Ok(msg)
}

/// Every valid server->client message. Internally tagged on `type`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type")]
#[ts(export)]
pub enum ServerMessage {
    #[serde(rename = "hello:ok")]
    HelloOk {
        #[serde(rename = "playerId")]
        player_id: String,
    },
    #[serde(rename = "lobby:state")]
    LobbyState { rooms: Vec<Room> },
    #[serde(rename = "room:state")]
    RoomState { room: Room },
    #[serde(rename = "game:state")]
    GameState { view: PlayerView },
    #[serde(rename = "game:turn")]
    GameTurn {
        #[serde(rename = "currentPlayerId")]
        current_player_id: String,
        /// Unix-ms deadline timestamp (server clock).
        #[ts(type = "number")]
        deadline: i64,
    },
    #[serde(rename = "game:applied")]
    GameApplied {
        #[serde(rename = "move")]
        mv: Move,
        by: String,
        #[serde(rename = "turnSeq")]
        #[ts(type = "number")]
        turn_seq: u64,
    },
    #[serde(rename = "game:over")]
    GameOver {
        scores: Vec<ScoreEntry>,
        #[serde(rename = "winnerIds")]
        winner_ids: Vec<String>,
    },
    #[serde(rename = "game:aborted")]
    GameAborted { reason: String },
    #[serde(rename = "player:connection")]
    PlayerConnection {
        #[serde(rename = "playerId")]
        player_id: String,
        connected: bool,
    },
    #[serde(rename = "session:invalid")]
    SessionInvalid,
    #[serde(rename = "pong")]
    Pong,
    #[serde(rename = "error")]
    Error { code: String, message: String },
}

impl ServerMessage {
    /// Serialize to a JSON text frame for the socket.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("ServerMessage serialization cannot fail")
    }
}
