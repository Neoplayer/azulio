// Wire protocol types for the Azul web client.
//
// The type re-exports below come from `./generated/*`, which is produced from
// the Rust `azul-shared` crate by ts-rs (run `cargo test -p azul-shared`, or
// just `cargo test`, in ../../azul-server). Those files are the single source
// of truth for the client<->server protocol — never edit them by hand, and add
// new protocol types in azul-shared, then regenerate. Import wire types from
// this module (`./wire`) rather than reaching into `./generated` directly.

export type { BotLevel } from './generated/BotLevel';
export type { Color } from './generated/Color';
export type { GamePhase } from './generated/GamePhase';
export type { Move } from './generated/Move';
export type { MoveSource } from './generated/MoveSource';
export type { MoveTarget } from './generated/MoveTarget';
export type { PlayerBoard } from './generated/PlayerBoard';
export type { PlayerView } from './generated/PlayerView';
export type { PlayerViewPlayer } from './generated/PlayerViewPlayer';
export type { Room } from './generated/Room';
export type { RoomPlayer } from './generated/RoomPlayer';
export type { RoomPlayerBot } from './generated/RoomPlayerBot';
export type { RoomStatus } from './generated/RoomStatus';
export type { ScoreEntry } from './generated/ScoreEntry';
export type { ClientMessage } from './generated/ClientMessage';
export type { ServerMessage } from './generated/ServerMessage';

// Floor-line penalties by slot index (left to right). This is fixed Azul rule
// data, not a wire type, so it is not generated — it mirrors the
// `azul_shared::FLOOR_PENALTIES` constant and must stay in sync with it.
export const FLOOR_PENALTIES = [-1, -1, -2, -2, -2, -3, -3] as const;
