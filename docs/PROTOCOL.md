# Azul WebSocket Protocol Reference

All message types are defined in `azul-server/crates/shared/src/protocol.rs` (and re-exported via `lib.rs`) as serde-tagged enums, and validated at the gateway boundary in `ws_gateway.rs`.
TypeScript equivalents are generated from that source by ts-rs into `packages/web/src/generated/` — if this document and the Rust source diverge, the Rust source wins.

---

## Transport overview

| Concern | Detail |
|---|---|
| Session creation | `POST /api/session` `{name: string}` → `{playerId, token}`. Token is opaque (UUID or signed JWT). Client stores it in `localStorage`. |
| Health check | `GET /api/health` — server liveness probe. |
| WebSocket endpoint | `ws[s]://<host>/ws` — single endpoint for all real-time traffic. |
| Message encoding | JSON text frames. Every message is `{type: string, ...payload}`. |
| Authentication | First message after connect **must** be `hello` with the token. Server replies `hello:ok` or closes the connection. |
| Reconnect | Send `hello` with the same token (and optionally `roomId`). Server replays the current `game:state` + emits `player:connection {connected:true}` to peers. |
| Server restart | All in-memory state is lost. On reconnect the server sends `session:invalid` or `game:aborted`; client returns to the lobby. No zombie tokens. |

---

## Client → Server messages

All messages are JSON objects with a `type` discriminant.

### `hello`

Authenticate / reconnect.

| Field | Type | Constraints | Notes |
|---|---|---|---|
| `type` | `"hello"` | — | — |
| `token` | `string` | required | Token from `POST /api/session`. |
| `roomId` | `string` | optional | Present on reconnect to resume a specific room. |

```json
{ "type": "hello", "token": "a3f9..." }
{ "type": "hello", "token": "a3f9...", "roomId": "room-42" }
```

---

### `lobby:subscribe`

Subscribe to live lobby updates. Server will push `lobby:state` on join and on every subsequent change.

| Field | Type | Constraints | Notes |
|---|---|---|---|
| `type` | `"lobby:subscribe"` | — | No payload. |

```json
{ "type": "lobby:subscribe" }
```

---

### `room:create`

Create a new room. Server responds with `room:state`.

| Field | Type | Constraints | Notes |
|---|---|---|---|
| `type` | `"room:create"` | — | — |
| `name` | `string` | min length 1 | Display name of the room. |
| `maxPlayers` | `integer` | 2–4 | Azul supports 2, 3, or 4 players. |
| `isPrivate` | `boolean` | — | Private rooms are not listed in the public lobby. |

```json
{ "type": "room:create", "name": "Quick game", "maxPlayers": 2, "isPrivate": false }
```

---

### `room:join`

Join an existing waiting room.

| Field | Type | Constraints | Notes |
|---|---|---|---|
| `type` | `"room:join"` | — | — |
| `roomId` | `string` | required | — |

```json
{ "type": "room:join", "roomId": "room-42" }
```

---

### `room:leave`

Leave a room (before the game starts).

| Field | Type | Constraints | Notes |
|---|---|---|---|
| `type` | `"room:leave"` | — | — |
| `roomId` | `string` | required | — |

```json
{ "type": "room:leave", "roomId": "room-42" }
```

---

### `room:start`

Host starts the game. Requires ≥ 2 players in the room.

| Field | Type | Constraints | Notes |
|---|---|---|---|
| `type` | `"room:start"` | — | — |
| `roomId` | `string` | required | Sender must be the host. |

```json
{ "type": "room:start", "roomId": "room-42" }
```

---

### `game:move`

Submit a game move. Server validates against the current state; illegal or stale moves are rejected with `error`.

| Field | Type | Constraints | Notes |
|---|---|---|---|
| `type` | `"game:move"` | — | — |
| `move` | `Move` | see sub-fields | The intended move. |
| `move.source` | object | `{type:"factory", index:int≥0}` or `{type:"center"}` | Pick from a factory display or the centre pool. |
| `move.color` | `string` | one of `blue\|yellow\|red\|black\|white` | The tile colour being taken. |
| `move.target` | object | `{type:"patternLine", row:int 0–4}` or `{type:"floor"}` | Where to place the tiles. |
| `expectedTurnSeq` | `integer` | required | Client echoes the `turnSeq` from the last `game:state`. Server rejects if it doesn't match (prevents double-tap / stale-move races). |

```json
{
  "type": "game:move",
  "move": {
    "source": { "type": "factory", "index": 2 },
    "color": "blue",
    "target": { "type": "patternLine", "row": 0 }
  },
  "expectedTurnSeq": 7
}
```

```json
{
  "type": "game:move",
  "move": {
    "source": { "type": "center" },
    "color": "red",
    "target": { "type": "floor" }
  },
  "expectedTurnSeq": 8
}
```

---

### `ping`

Keepalive. Server replies with `pong`.

| Field | Type | Constraints | Notes |
|---|---|---|---|
| `type` | `"ping"` | — | No payload. |

```json
{ "type": "ping" }
```

---

## Server → Client messages

### `hello:ok`

Authentication accepted.

| Field | Type | Notes |
|---|---|---|
| `type` | `"hello:ok"` | — |
| `playerId` | `string` | The stable player ID for this session. |

```json
{ "type": "hello:ok", "playerId": "p-abc123" }
```

---

### `lobby:state`

Snapshot or incremental update of the public room list. Sent immediately on `lobby:subscribe` and on every change.

| Field | Type | Notes |
|---|---|---|
| `type` | `"lobby:state"` | — |
| `rooms` | `Room[]` | Only `waiting` rooms (non-private) are included. See Room shape below. |

**Room shape:**

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Stable room identifier. |
| `name` | `string` | Display name. |
| `hostId` | `string` | PlayerId of the creator. |
| `maxPlayers` | `integer 2–4` | — |
| `players` | `{id,name}[]` | Currently joined players. |
| `status` | `"waiting"\|"playing"\|"finished"` | — |
| `isPrivate` | `boolean` | — |
| `createdAt` | `string` | ISO-8601 timestamp. |

```json
{
  "type": "lobby:state",
  "rooms": [
    {
      "id": "room-42", "name": "Quick game", "hostId": "p-abc123",
      "maxPlayers": 2, "players": [{ "id": "p-abc123", "name": "Alice" }],
      "status": "waiting", "isPrivate": false, "createdAt": "2026-06-10T00:00:00.000Z"
    }
  ]
}
```

---

### `room:state`

Current state of a single room. Sent on join, leave, and start.

| Field | Type | Notes |
|---|---|---|
| `type` | `"room:state"` | — |
| `room` | `Room` | See Room shape above. |

```json
{
  "type": "room:state",
  "room": {
    "id": "room-42", "name": "Quick game", "hostId": "p-abc123",
    "maxPlayers": 2, "players": [
      { "id": "p-abc123", "name": "Alice" },
      { "id": "p-def456", "name": "Bob" }
    ],
    "status": "waiting", "isPrivate": false, "createdAt": "2026-06-10T00:00:00.000Z"
  }
}
```

---

### `game:state`

The current game state, redacted for the receiving player. Sent after `room:start`, after every applied move, and on reconnect.

| Field | Type | Notes |
|---|---|---|
| `type` | `"game:state"` | — |
| `view` | `PlayerView` | See PlayerView shape below. |

**PlayerView shape** (built by `to_player_view(state, player_id)` in `azul-engine`):

| Field | Type | Notes |
|---|---|---|
| `players` | `{id, name, board, connected}[]` | All players' boards are visible. |
| `factories` | `Color[][]` | Current tiles on each factory display. |
| `center` | `Color[]` | Tiles in the centre pool. |
| `centerHasFirstToken` | `boolean` | Whether the first-player marker is still in the centre. |
| `bagCount` | `number` | **Bag size only — composition is hidden** (see note below). |
| `discard` | `Color[]` | Public discard pile. |
| `currentPlayerId` | `string` | Whose turn it is. |
| `firstPlayerId` | `string` | Who starts the next round. |
| `phase` | `"offer"\|"tiling"\|"finished"` | Current game phase. |
| `round` | `number` | Current round number. |
| `turnSeq` | `number` | Monotonic move counter. Echo in `expectedTurnSeq` on next `game:move`. |
| `you` | `string` | PlayerId of the message recipient. |
| `winnerIds` | `string[]\|null` | Populated when `phase === "finished"`. |

```json
{
  "type": "game:state",
  "view": {
    "players": [
      { "id": "p-abc123", "name": "Alice", "board": { "patternLines": [[],[],[],[],[]], "wall": [[null,null,null,null,null],[null,null,null,null,null],[null,null,null,null,null],[null,null,null,null,null],[null,null,null,null,null]], "floor": [], "score": 0 }, "connected": true },
      { "id": "p-def456", "name": "Bob",   "board": { "patternLines": [[],[],[],[],[]], "wall": [[null,null,null,null,null],[null,null,null,null,null],[null,null,null,null,null],[null,null,null,null,null],[null,null,null,null,null]], "floor": [], "score": 0 }, "connected": true }
    ],
    "factories": [["blue","red","yellow","black"],["white","blue","red","yellow"]],
    "center": [], "centerHasFirstToken": true,
    "bagCount": 92, "discard": [],
    "currentPlayerId": "p-abc123", "firstPlayerId": "p-abc123",
    "phase": "offer", "round": 1, "turnSeq": 0,
    "you": "p-abc123", "winnerIds": null
  }
}
```

---

### `game:turn`

Announces whose turn it is and the move deadline. Sent at the start of each turn.

| Field | Type | Notes |
|---|---|---|
| `type` | `"game:turn"` | — |
| `currentPlayerId` | `string` | — |
| `deadline` | `number` | Unix timestamp in milliseconds (server clock). Client uses this for the countdown display only — the server enforces it. |

```json
{ "type": "game:turn", "currentPlayerId": "p-abc123", "deadline": 1749513660000 }
```

---

### `game:applied`

A move was successfully applied. Sent to all players in the room (for animations / move log).

| Field | Type | Notes |
|---|---|---|
| `type` | `"game:applied"` | — |
| `move` | `Move` | The move that was applied (same shape as in `game:move`). |
| `by` | `string` | PlayerId who made the move (may be the server, for auto-moves). |
| `turnSeq` | `integer` | The new `turnSeq` after applying the move. |

```json
{
  "type": "game:applied",
  "move": {
    "source": { "type": "factory", "index": 0 },
    "color": "blue",
    "target": { "type": "patternLine", "row": 1 }
  },
  "by": "p-abc123",
  "turnSeq": 1
}
```

---

### `game:over`

The game has finished. Sent after `game:state` in the `finished` phase.

| Field | Type | Notes |
|---|---|---|
| `type` | `"game:over"` | — |
| `scores` | `{playerId, score}[]` | Final scores including all bonuses. |
| `winnerIds` | `string[]` | One or more winners (array allows ties). |

```json
{
  "type": "game:over",
  "scores": [
    { "playerId": "p-abc123", "score": 54 },
    { "playerId": "p-def456", "score": 47 }
  ],
  "winnerIds": ["p-abc123"]
}
```

---

### `game:aborted`

The game was terminated abnormally (e.g. server restart). Client should return to the lobby.

| Field | Type | Notes |
|---|---|---|
| `type` | `"game:aborted"` | — |
| `reason` | `string` | Human-readable reason. |

```json
{ "type": "game:aborted", "reason": "server restarted" }
```

---

### `player:connection`

A player's connection status changed. Sent to all other players in the room.

| Field | Type | Notes |
|---|---|---|
| `type` | `"player:connection"` | — |
| `playerId` | `string` | — |
| `connected` | `boolean` | `false` = disconnected, `true` = reconnected. |

```json
{ "type": "player:connection", "playerId": "p-def456", "connected": false }
```

---

### `session:invalid`

The token is no longer recognised (server restarted, session expired). Client should re-authenticate via `POST /api/session`.

| Field | Type | Notes |
|---|---|---|
| `type` | `"session:invalid"` | No payload. |

```json
{ "type": "session:invalid" }
```

---

### `pong`

Reply to a client `ping`. Used to detect half-open sockets.

| Field | Type | Notes |
|---|---|---|
| `type` | `"pong"` | No payload. |

```json
{ "type": "pong" }
```

---

### `error`

A client message was rejected or an operation failed.

| Field | Type | Notes |
|---|---|---|
| `type` | `"error"` | — |
| `code` | `string` | Machine-readable error code (e.g. `ILLEGAL_MOVE`, `STALE_TURN_SEQ`, `NOT_HOST`, `ROOM_FULL`). |
| `message` | `string` | Human-readable description. |

```json
{ "type": "error", "code": "STALE_TURN_SEQ", "message": "expectedTurnSeq 5 does not match current 6" }
```

---

## Typical session flow

```
Client                                  Server
  |                                       |
  | POST /api/session {name}              |
  |-------------------------------------->|
  |            {playerId, token}          |
  |<--------------------------------------|
  |                                       |
  | WS connect                            |
  |-------------------------------------->|
  | {type:"hello", token}                 |
  |-------------------------------------->|
  |            {type:"hello:ok",playerId} |
  |<--------------------------------------|
  |                                       |
  | {type:"lobby:subscribe"}              |
  |-------------------------------------->|
  |            {type:"lobby:state",rooms} |
  |<--------------------------------------|
  |                                       |
  | {type:"room:create", name, maxPlayers, isPrivate}
  |-------------------------------------->|
  |            {type:"room:state", room}  |
  |<--------------------------------------|
  |       (second player joins)           |
  |            {type:"room:state", room}  |  ← broadcast
  |<--------------------------------------|
  |                                       |
  | {type:"room:start", roomId}           |  ← host only
  |-------------------------------------->|
  |            {type:"game:state", view}  |  ← broadcast to all
  |<--------------------------------------|
  |            {type:"game:turn",         |
  |             currentPlayerId,deadline} |  ← broadcast
  |<--------------------------------------|
  |                                       |
  | {type:"game:move", move,              |
  |  expectedTurnSeq:0}                   |
  |-------------------------------------->|
  |            {type:"game:applied",...}  |  ← broadcast
  |<--------------------------------------|
  |            {type:"game:state", view}  |  ← broadcast (updated state)
  |<--------------------------------------|
  |            {type:"game:turn",...}     |  ← broadcast (next player)
  |<--------------------------------------|
  |           ... (more turns) ...        |
  |                                       |
  |            {type:"game:state",        |
  |             view.phase="finished"}    |
  |<--------------------------------------|
  |            {type:"game:over",         |
  |             scores, winnerIds}        |  ← broadcast
  |<--------------------------------------|
```

### Turn timer and auto-move

- On each `game:turn` the server starts a 60 s countdown (configurable).
- If the timer fires and `turnSeq` has not advanced, the server calls `engine.autoMove(state)` and applies it on behalf of the player. This prevents the game from stalling when a player is AFK or disconnected.
- `game:applied` is broadcast with `by = <timedOutPlayerId>` so clients can distinguish auto-moves.
- If a real `game:move` arrives after the auto-move has already been applied (race), the server rejects it with `error {code:"STALE_TURN_SEQ"}` because `expectedTurnSeq` will no longer match.

### Reconnect flow

```
(player disconnects mid-game)
  Server broadcasts {type:"player:connection", playerId, connected:false} to peers.
  Disconnected player's turns are handled by auto-move if the timer expires.

(player reconnects)
  Client sends {type:"hello", token, roomId}
  Server sends  {type:"hello:ok", playerId}
                {type:"game:state", view}   ← full current state replay
  Server broadcasts {type:"player:connection", playerId, connected:true} to peers.
```

### Server restart

All in-memory sessions and rooms are lost. Reconnecting clients receive `session:invalid` (token unknown) or `game:aborted` (game record gone), then return to the entry/login screen.

---

## Note on bag composition hiding

`game:state` exposes only `bagCount` (the number of tiles remaining in the bag), not the bag's contents. This is intentional: knowing the exact tiles left in the bag would let a client calculate precise draw probabilities for each factory refill, giving an unfair information advantage. The discard pile (`discard: Color[]`) is fully public, as it is in the physical board game.
