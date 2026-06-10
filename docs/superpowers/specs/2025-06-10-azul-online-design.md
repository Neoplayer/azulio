# Azul Online — Design Specification

**Version:** 1.0.0  
**Date:** 2025-06-10  
**Status:** Ready for implementation planning

---

## 1. Overview

Online multiplayer browser game based on the classic board game **Azul**. Two players compete in real-time via WebSocket connection. The game runs entirely in the browser (mobile-first) without registration — just a nickname.

### 1.1 Requirements Summary

| Requirement | Decision |
|------------|----------|
| Auth | No registration, nickname only |
| Game modes | Online PvP real-time only |
| Players | 1 vs 1 (2 players) |
| Visual style | Minimalism + glassmorphism |
| Timers | Turn timer (30–60 seconds) |
| Backend | Node.js + Express + Socket.io |
| Frontend | React + Vite + Tailwind CSS |
| Extra features | Core game only (no chat, no leaderboard) |
| Rules | Full classic Azul rules |

### 1.2 Key Non-Functional Requirements

- **Mobile-first:** portrait orientation, touch-optimized
- **Real-time:** sub-100ms latency for game state updates
- **Resilient:** reconnect within 60 seconds or forfeit
- **Authoritative server:** all game logic runs server-side, client is thin
- **No database:** in-memory storage, one-process deployment

---

## 2. Architecture

### 2.1 High-Level Design

```
┌──────────────────────────────────────────────────────────────┐
│                    CLIENT (React + Vite + Tailwind)          │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────┐  │
│  │  LoginPage  │  │  LobbyPage  │  │  GamePage            │  │
│  │  (nickname) │  │  (rooms)    │  │  (board + factories) │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬───────────┘  │
│         │                │                     │              │
│         └────────────────┴──── Socket.io ──────┘              │
│                       Client Library                          │
└──────────────────────────────────────────────────────────────┘
                               │
                               ▼ WebSocket
┌──────────────────────────────────────────────────────────────┐
│                    SERVER (Node.js + Socket.io)              │
│  ┌────────────┐  ┌──────────────┐  ┌─────────────────────┐   │
│  │ HTTP API   │  │ Socket.io    │  │ Game Engine         │   │
│  │ (health    │  │ Handlers     │  │ (AzulGame class)    │   │
│  │  rooms)    │  │ (events)     │  │ - authoritative     │   │
│  └────────────┘  └──────┬───────┘  │ - deterministic     │   │
│                         │          └─────────────────────┘   │
│                         ▼                                    │
│              ┌──────────────────┐  ┌──────────────────┐      │
│              │ In-Memory Stores │  │ Timer Manager    │      │
│              │ - RoomStore      │  │ - per-room timers│      │
│              │ - PlayerStore    │  │ - auto-forfeit   │      │
│              └──────────────────┘  └──────────────────┘      │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 Key Principles

1. **Authoritative Server:** `AzulGame` class runs ONLY on the server. Client sends intent ("I want to take red from factory 3"), server validates and applies.
2. **Thin Client:** Client renders game state, captures user input, sends events. No game logic on client.
3. **Single Socket:** One WebSocket connection per player. Game state broadcast to both players.
4. **In-Memory Only:** No database. All state in JavaScript `Map`s. Server restart = all games lost.
5. **Stateless HTTP API:** Only for health check and room listing. All game actions via WebSocket.

---

## 3. Data Model

### 3.1 Core Types

```typescript
// Tile colors in Azul
const TILE_COLORS = ['blue', 'yellow', 'red', 'black', 'white'] as const;
type TileColor = typeof TILE_COLORS[number];

// First player marker
const FIRST_PLAYER_MARKER = 'first' as const;
type SpecialTile = typeof FIRST_PLAYER_MARKER;

type Tile = TileColor | SpecialTile;

// Player in the system (not tied to a room)
interface Player {
  socketId: string;        // Socket.io connection ID
  nickname: string;        // Display name (max 20 chars)
  roomId: string | null;   // Current room, null if in lobby
  isReady: boolean;
  connected: boolean;      // false if disconnected during game
}

type RoomStatus = 'waiting' | 'playing' | 'finished';

interface Room {
  id: string;              // 6-digit alphanumeric code
  hostId: string;          // socketId of creator
  players: [Player, Player?];  // Tuple: always 2 slots, second may be undefined
  status: RoomStatus;
  game: AzulGame | null;   // null until status === 'playing'
  createdAt: number;       // Date.now() timestamp
  timerDeadline: number | null;  // Timestamp when turn expires
}
```

### 3.2 Game State

```typescript
// Internal server state (not sent to client directly)
interface GameInternalState {
  bag: Tile[];                    // Remaining tiles in bag
  discarded: Tile[];              // Discarded tiles (will be reshuffled)
  factories: Tile[][];            // 5 factories, each has 0-4 tiles
  center: Tile[];                 // Center pool (may include first-player marker)
  
  // Per-player boards
  patternLines: Tile[][][];       // [playerIndex][row][tiles]
  walls: boolean[][][];           // [playerIndex][row][col] — true if tile placed
  floorLines: Tile[][];           // [playerIndex][tiles on floor]
  scores: number[];               // [playerIndex]
  
  currentPlayerIndex: number;     // 0 or 1
  phase: 'drafting' | 'wallTiling' | 'gameOver';
  roundNumber: number;            // 1-5+ (until someone completes a row)
  firstPlayerForNextRound: number;
}

// What we send to clients (filtered/hidden info removed)
interface GameStateView {
  yourPlayerIndex: number;        // 0 or 1 (so client knows which board is theirs)
  currentPlayerIndex: number;     // Whose turn it is
  factories: Tile[][];
  center: Tile[];
  patternLines: Tile[][][];       // Both players' pattern lines
  walls: boolean[][][];           // Both players' walls (placement only, no colors needed for display)
  wallColors: TileColor[][][];    // [player][row][col] = color if placed
  floorLines: Tile[][];
  scores: number[];
  bagCount: number;               // How many tiles remain in bag
  timerDeadline: number | null;   // Unix timestamp (ms)
  phase: 'drafting' | 'wallTiling' | 'gameOver';
  roundNumber: number;
}
```

---

## 4. Game Flow / Room Lifecycle

### 4.1 State Machine

```
[LOBBY]
  │ create room
  ▼
[ROOM_WAITING] ────────► player 2 joins
  │                          │
  │ both ready              │
  ▼                          │
[PLAYING] ◄──────────────────┘
  │ game ends
  ▼
[GAME_OVER]
  │ play again / leave
  ▼
[ROOM_WAITING] or [destroyed]
```

### 4.2 Detailed Flow

#### Phase 1: Lobby
1. Player opens page, enters nickname
2. Server creates `Player` entry, assigns socketId
3. Player sees:
   - List of active rooms (roomId, host nickname, status, player count)
   - Button "Создать комнату"
   - Input to join by roomId

#### Phase 2: Room Waiting
1. Host clicks "Создать" → server creates `Room`, assigns 6-char roomId
2. Server emits `roomCreated` to host
3. Host shares roomId (manual copy or QR)
4. Player 2 enters roomId → server emits `playerJoined` to both
5. Both players see each other's nicknames + "Ready" toggle
6. When BOTH ready → server transitions to `PLAYING`

#### Phase 3: Playing (Drafting)
1. Server creates new `AzulGame`:
   - Fill bag: 20 of each color (100 total)
   - Shuffle bag
   - Draw 4 tiles for each of 5 factories
   - Center starts with first-player marker only
   - currentPlayer = firstPlayerForNextRound (initially 0)
2. Server emits `gameStarted` with initial state
3. Turn timer starts (default 45 seconds)
4. Current player sends `takeFromFactory` or `takeFromCenter`
5. Server validates move, updates state, emits `gameState` to both
6. When all factories empty AND center empty → proceed to Wall Tiling

#### Phase 4: Wall Tiling
1. Server evaluates each player's pattern lines:
   - Full line (row k has k tiles) → place one tile on wall, rest to floor
   - Not full → tiles stay for next round
2. Score each placed tile: 1 + horizontal neighbors + vertical neighbors
3. Subtract floor penalties: [-1, -1, -2, -2, -3, -3, ...]
4. Check endgame condition (any horizontal row complete)
5. If endgame → final scoring + emit `gameOver`
6. Otherwise → new round (refill factories, keep remaining pattern line tiles)

#### Phase 5: Game Over
1. Final scoring:
   - +2 per complete horizontal line
   - +7 per complete vertical line
   - +10 per complete color set (all 5 of one color)
2. Server emits `gameOver` with final scores
3. Both players see results screen with:
   - Final scores
   - Breakdown (row bonuses, column bonuses, color bonuses)
   - Button "Реванш" (both must click) → back to ROOM_WAITING
   - Button "В лобби" → destroy room, back to lobby

---

## 5. Complete Azul Rules Implementation

### 5.1 Setup

- Bag: 100 tiles total (20 of each color: blue, yellow, red, black, white)
- Factories: always 5 discs
- Each factory gets exactly 4 tiles from bag at round start
- First player marker starts in center

### 5.2 Drafting Phase

**Valid moves:**
1. **From Factory:** Choose factory index (0-4) and color. Take ALL tiles of that color from factory. Remaining tiles move to center. Factory becomes empty.
2. **From Center:** Choose color. Take ALL tiles of that color from center. If first-player marker is in center, the player MUST also take it (and goes first next round). Other tiles remain in center.

**Placement:** Taken tiles go to a chosen pattern line row (0-4). Row k holds exactly k tiles (row 0 = 1 tile, row 4 = 5 tiles).
- Tiles can only go on a row if: (a) row has space, AND (b) row's color matches OR row is empty, AND (c) wall doesn't already have that color in that row
- Excess tiles go to floor line

**End of Drafting:** When all factories empty AND center empty.

### 5.3 Wall Tiling Phase

For each player, for each row k:
- If pattern line row k is FULL (has k+1 tiles):
  - Place one tile of that color on wall at position matching the color's column
  - Remaining tiles in that row are discarded
  - Score: 1 point + count of horizontally adjacent placed tiles + count of vertically adjacent placed tiles
- If row is NOT full: tiles stay for next round

**Floor line penalties** (applied after wall tiling):
| Floor position | 0 | 1 | 2 | 3 | 4 | 5 | 6+ |
|---------------|---|---|---|---|---|---|----|
| Penalty       | -1| -1| -2| -2| -3| -3| -3 |

**Endgame trigger:** After wall tiling, if any player has a complete horizontal row on their wall.

### 5.4 Final Scoring

After endgame trigger:
- +2 points for each complete horizontal line
- +7 points for each complete vertical line
- +10 points for each complete color (all 5 placed on wall)

### 5.5 Wall Layout

The wall is a 5×5 grid. Each row has a fixed color pattern:

```
Row 0: [blue, yellow, red, black, white]
Row 1: [white, blue, yellow, red, black]
Row 2: [black, white, blue, yellow, red]
Row 3: [red, black, white, blue, yellow]
Row 4: [yellow, red, black, white, blue]
```

A tile of a specific color can ONLY be placed in its designated column within each row. This is why the wall scoring works — adjacent tiles are guaranteed to be different colors.

---

## 6. Socket.io Protocol

### 6.1 Client → Server Events

| Event | Payload | Auth Required | Description |
|-------|---------|---------------|-------------|
| `createRoom` | `{ nickname: string }` | No | Create a new room, become host |
| `joinRoom` | `{ roomId: string, nickname: string }` | No | Join existing room by ID |
| `setReady` | `{ ready: boolean }` | Yes (in room) | Toggle ready status |
| `leaveRoom` | `{}` | Yes (in room) | Leave current room |
| `takeFromFactory` | `{ factoryIndex: number, color: TileColor }` | Yes (in game, your turn) | Take tiles from factory |
| `takeFromCenter` | `{ color: TileColor }` | Yes (in game, your turn) | Take tiles from center |
| `reconnect` | `{ roomId: string, nickname: string }` | No | Reconnect to interrupted game |
| `requestRematch` | `{}` | Yes (game over) | Request another game |

### 6.2 Server → Client Events

| Event | Payload | When |
|-------|---------|------|
| `roomCreated` | `{ roomId: string, host: PlayerView }` | Room created successfully |
| `roomJoined` | `{ roomId: string, players: PlayerView[] }` | Successfully joined room |
| `playerJoined` | `{ player: PlayerView }` | Another player joined |
| `playerLeft` | `{ playerId: string }` | Player left room |
| `playerReady` | `{ playerId: string, ready: boolean }` | Player toggled ready |
| `gameStarted` | `{ state: GameStateView }` | Game begins |
| `gameState` | `{ state: GameStateView }` | State update after move |
| `timerTick` | `{ deadline: number, remaining: number }` | Every second during turn |
| `turnExpired` | `{ playerId: string, autoMove: Move }` | Timer ran out, auto-move made |
| `gameOver` | `{ finalScores: number[], winnerId: string, breakdown: ScoreBreakdown }` | Game ended |
| `rematchOffered` | `{ playerId: string }` | Opponent wants rematch |

### 6.4 ScoreBreakdown

```typescript
interface ScoreBreakdown {
  baseScores: number[];      // [player] — очки за размещение плиток в раунде
  rowBonuses: number[];      // [player] — +2 за каждый полный горизонтальный ряд
  colBonuses: number[];      // [player] — +7 за каждый полный вертикальный столбец
  colorBonuses: number[];    // [player] — +10 за каждый полный цвет (5 плиток)
  floorPenalties: number[];  // [player] — суммарные штрафы за пол (-1,-1,-2,-2,-3,-3...)
}
```
| `rematchStarted` | `{ state: GameStateView }` | Rematch begins |
| `error` | `{ message: string, code: string }` | Any error (invalid move, etc.) |
| `reconnected` | `{ state: GameStateView }` | Reconnection successful |
| `opponentDisconnected` | `{ playerId: string }` | Opponent lost connection |
| `opponentReconnected` | `{ playerId: string }` | Opponent reconnected |

### 6.3 PlayerView (public player info)

```typescript
interface PlayerView {
  socketId: string;
  nickname: string;
  isReady: boolean;
  score: number;        // current score (0 during waiting)
  connected: boolean;
}
```

---

## 7. Timer System

### 7.1 Turn Timer

- Duration: **45 seconds** per turn (configurable per room)
- Started when `gameState` is emitted to the current player
- Server emits `timerTick` every second to both players
- On screen: visual countdown (circle or bar)
- At 10 seconds remaining: pulse animation + warning color

### 7.2 Auto-Move on Timeout

If player doesn't act before deadline:
1. Server computes a valid random move:
   - Try factories first: choose first non-empty factory, take most abundant color
   - If no factories: take most abundant color from center
   - Place on first valid pattern line row
2. Apply the move normally
3. Emit `turnExpired` with the move details
4. Switch to next player's turn

### 7.3 Timer Implementation

```typescript
class TurnTimer {
  private roomId: string;
  private deadline: number;
  private interval: NodeJS.Timeout | null = null;

  constructor(roomId: string) {
    this.roomId = roomId;
  }

  start(seconds: number, onExpire: () => void) {
    this.stop();
    this.deadline = Date.now() + seconds * 1000;
    
    this.interval = setInterval(() => {
      const remaining = Math.ceil((this.deadline - Date.now()) / 1000);
      io.to(this.roomId).emit('timerTick', {
        deadline: this.deadline,
        remaining: Math.max(0, remaining)
      });
      
      if (remaining <= 0) {
        this.stop();
        onExpire();
      }
    }, 1000);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  reset(seconds: number, onExpire: () => void) {
    this.start(seconds, onExpire);
  }
}
```

---

## 8. Reconnection System

### 8.1 Disconnection Handling

When `socket.on('disconnect')` fires:
1. Find player by socketId
2. Mark `player.connected = false`
3. If room status is `playing`:
   - Emit `opponentDisconnected` to other player
   - Timer continues running
   - Start 60-second grace period
4. If grace period expires without reconnection:
   - Disconnected player forfeits
   - Other player wins
   - Room status → `finished`

### 8.2 Reconnection Flow

1. Client reconnects with new socket, emits `reconnect` with `{ roomId, nickname }`
2. Server finds room by roomId
3. Server finds player by nickname (nickname acts as identifier within room)
4. Update player's socketId, mark `connected = true`
5. Emit `reconnected` with current `GameStateView`
6. Emit `opponentReconnected` to other player

### 8.3 Edge Cases

- **Room destroyed while disconnected:** Client gets error, redirected to lobby
- **Game ended while disconnected:** Client sees game over screen
- **Nickname collision on reconnect:** If two players have same nickname, use last-connected wins

---

## 9. UI/UX Design

### 9.1 Color Palette (Glassmorphism)

```css
:root {
  --bg-primary: #0f172a;         /* slate-900 */
  --bg-surface: rgba(255,255,255,0.05);
  --bg-surface-hover: rgba(255,255,255,0.1);
  --border: rgba(255,255,255,0.1);
  --border-focus: rgba(129,140,248,0.5);
  
  --accent-primary: #818cf8;      /* indigo-400 */
  --accent-secondary: #34d399;    /* emerald-400 */
  --accent-danger: #f87171;       /* red-400 */
  --accent-warning: #f59e0b;      /* amber-500 */
  
  --text-primary: #f8fafc;        /* slate-50 */
  --text-secondary: #94a3b8;      /* slate-400 */
  
  --tile-blue: #60a5fa;
  --tile-yellow: #fbbf24;
  --tile-red: #f87171;
  --tile-black: #1f2937;
  --tile-white: #f3f4f6;
  --tile-first: #f59e0b;          /* gold for first-player marker */
}
```

### 9.2 Glassmorphism Component Style

```css
.glass {
  background: rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  box-shadow: 0 4px 30px rgba(0, 0, 0, 0.1);
}

.glass-strong {
  background: rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.15);
}
```

### 9.3 Screen Layouts (Mobile Portrait)

#### Login Screen
- Full-screen gradient background (slate-900 → slate-800)
- Floating animated tiles (subtle, decorative)
- Centered card: glass effect
  - Title: "AZUL" (large, gradient text indigo → emerald)
  - Input: nickname (glass input, max 20 chars)
  - Button: "Играть" (full width, gradient bg)
- Bottom: subtle pattern of tiles

#### Lobby Screen
- Header: "Комнаты" + player nickname
- Scrollable list of rooms:
  - Each room: glass card
    - Host nickname + "2/2" or "1/2"
    - Status badge (waiting: amber, playing: emerald, full: gray)
    - Button: "Присоединиться" (or disabled if full/playing)
- FAB (Floating Action Button): "+" to create room
- Bottom sheet: join by roomId input

#### Room (Waiting) Screen
- Header: "Комната: ABC123"
- Two player slots:
  - Host: avatar + nickname + crown icon
  - Guest: avatar + nickname (or empty slot with "Ожидание...")
- Ready toggle: glass switch per player
- Bottom: 
  - "Готов" button (becomes "Отменить готовность")
  - Share button (copy roomId)
- When both ready: 3-2-1 countdown → auto transition

#### Game Screen
- Top bar (height: 60px):
  - Left: opponent avatar + nickname + score
  - Center: round number "Раунд 3"
  - Right: timer circle (45s countdown, turns red at 10s)
- Middle section (factories + center):
  - 5 factories arranged in pentagon/star or vertical list
  - Each factory: 4 tile slots, glass container
  - Center pool: below factories, glass container, larger
  - Tap tile color first, then tap factory/center to take
- Bottom section (player board):
  - Tab or swipe to switch: my board / opponent board
  - Pattern lines: 5 rows, left-aligned, glass background
  - Wall: 5×5 grid, each cell shows color when placed
  - Floor line: horizontal row of 7 slots, red-tinted glass
  - Score: large number top-right of board

#### Game Over Screen
- Full-screen overlay with glass background
- Confetti animation (if winner)
- Large scores: "12 : 8"
- Breakdown table:
  | Player | Базовые | Ряды | Столбцы | Цвета | Итого |
  |--------|---------|------|---------|-------|-------|
- Buttons: "Реванш" (both must click), "В лобби"

### 9.4 Tile Component Design

```
┌─────────────┐
│  ◆◆◆◆◆◆◆   │  <- Top: subtle highlight
│  ◆◆◆◆◆◆◆   │
│  ◆◆◆◆◆◆◆   │  <- Body: solid color
│  ◆◆◆◆◆◆◆   │
│  ◆◆◆◆◆◆◆   │
│         ◆   │  <- Bottom right: subtle shadow
└─────────────┘

Size: 40×40px on mobile
Border-radius: 12px (slightly rounded square, like real tiles)
Shadow: inner highlight + outer drop shadow for depth
Selected state: ring-2 ring-white, scale-110, glow effect
First-player marker: golden tile with "1" icon
```

---

## 10. Error Handling

| Error Code | Description | Client Action |
|------------|-------------|---------------|
| `ROOM_NOT_FOUND` | Room ID doesn't exist | Show error, stay in lobby |
| `ROOM_FULL` | Room already has 2 players | Show error, suggest create new |
| `NOT_YOUR_TURN` | Move sent when not current player | Ignore (shouldn't happen with UI) |
| `INVALID_MOVE` | Move violates game rules | Show tooltip with reason |
| `GAME_NOT_STARTED` | Action requires active game | Stay in waiting screen |
| `NICKNAME_TAKEN` | Nickname already in room | Prompt for different nickname |
| `ALREADY_IN_ROOM` | Trying to join while in another room | Ask to leave current first |
| `TIMER_EXPIRED` | Move sent after timeout | Show "Время вышло" toast |
| `SERVER_ERROR` | Internal server error | Show generic error, offer reconnect |

---

## 11. Project Structure

```
azul/
├── docs/
│   └── superpowers/
│       └── specs/
│           └── 2025-06-10-azul-online-design.md   <- this file
│
├── server/                              # Node.js backend
│   ├── src/
│   │   ├── index.ts                     # Entry point
│   │   ├── server.ts                    # Express + Socket.io setup
│   │   ├── config.ts                    # Environment config
│   │   ├── socket/
│   │   │   ├── connection.ts            # Connection handler
│   │   │   ├── roomHandlers.ts          # Room events
│   │   │   └── gameHandlers.ts          # Game events
│   │   ├── game/
│   │   │   ├── AzulGame.ts              # Core game engine
│   │   │   ├── types.ts                 # Game types
│   │   │   ├── scoring.ts               # Score calculation
│   │   │   └── validators.ts            # Move validation
│   │   ├── store/
│   │   │   ├── RoomStore.ts             # Room in-memory storage
│   │   │   └── PlayerStore.ts           # Player in-memory storage
│   │   ├── timer/
│   │   │   └── TurnTimer.ts             # Turn timer manager
│   │   └── utils/
│   │       └── idGenerator.ts           # Room ID generation
│   ├── tests/
│   │   ├── AzulGame.test.ts             # Game logic tests (TDD)
│   │   ├── scoring.test.ts              # Scoring tests (TDD)
│   │   ├── validators.test.ts           # Validation tests (TDD)
│   │   └── roomLifecycle.test.ts        # Room flow tests (TDD)
│   ├── package.json
│   └── tsconfig.json
│
├── client/                              # React frontend
│   ├── public/
│   │   └── favicon.ico
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx                      # Router setup
│   │   ├── index.css                    # Tailwind + glassmorphism
│   │   ├── pages/
│   │   │   ├── LoginPage.tsx
│   │   │   ├── LobbyPage.tsx
│   │   │   ├── RoomPage.tsx
│   │   │   └── GamePage.tsx
│   │   ├── components/
│   │   │   ├── common/
│   │   │   │   ├── GlassCard.tsx        # Reusable glass container
│   │   │   │   ├── Timer.tsx            # Countdown display
│   │   │   │   └── Button.tsx           # Styled buttons
│   │   │   └── game/
│   │   │       ├── Tile.tsx             # Individual tile
│   │   │       ├── Factory.tsx          # Factory display (4 tiles)
│   │   │       ├── Center.tsx           # Center pool
│   │   │       ├── PatternLine.tsx      # Pattern line row
│   │   │       ├── Wall.tsx             # Wall grid
│   │   │       ├── FloorLine.tsx        # Floor line slots
│   │   │       ├── ScoreBoard.tsx       # Score display
│   │   │       └── PlayerBoard.tsx      # Full player board
│   │   ├── hooks/
│   │   │   ├── useSocket.ts             # Socket.io connection
│   │   │   └── useGameState.ts          # Game state + actions
│   │   ├── types/
│   │   │   └── game.ts                  # Shared TypeScript types
│   │   └── utils/
│   │       └── constants.ts             # Game constants
│   ├── index.html
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   └── tsconfig.json
│
├── package.json                          # Root workspace (if monorepo)
└── README.md
```

---

## 12. Dependencies

### Server
- `express` — HTTP server
- `socket.io` — WebSocket transport
- `typescript` — TypeScript support
- `vitest` — Test runner (TDD)
- `cors` — CORS middleware

### Client
- `react` + `react-dom` — UI framework
- `react-router-dom` — Client-side routing
- `socket.io-client` — WebSocket client
- `tailwindcss` — Utility CSS
- `typescript` — TypeScript support
- `vite` — Build tool
- `framer-motion` — Animations (tile movement, screen transitions)
- `canvas-confetti` — Win celebration effect

---

## 13. Deployment

### Server
- Single Node.js process
- Port: `3000` (configurable via `PORT` env var)
- CORS: allow client origin (configurable via `CLIENT_URL` env var)
- No persistent storage required
- Health check: `GET /health` → `{ status: 'ok', players: N, rooms: M }`

### Client
- Static build via Vite
- Served as static files from server OR separate CDN/hosting
- Environment: `VITE_SOCKET_URL` for WebSocket endpoint

---

## 14. Testing Strategy (TDD)

### Server Tests (Vitest)

**Phase 1: Core Game Logic**
- `AzulGame.test.ts`:
  - Game initialization (bag, factories, center)
  - Taking tiles from factory (valid/invalid)
  - Taking tiles from center
  - Pattern line placement (valid/invalid)
  - Wall tiling scoring
  - Floor line penalties
  - Endgame detection
  - Full game simulation (2 players, multiple rounds)

**Phase 2: Scoring**
- `scoring.test.ts`:
  - Single tile placement (no neighbors = 1)
  - Horizontal streak bonus
  - Vertical streak bonus
  - Both horizontal + vertical
  - Floor penalties at all positions
  - Final scoring (rows, columns, colors)

**Phase 3: Validation**
- `validators.test.ts`:
  - Invalid factory index
  - Color not present in factory
  - Pattern line full
  - Wrong color for pattern line
  - Color already on wall in that row
  - Not player's turn

**Phase 4: Room Lifecycle**
- `roomLifecycle.test.ts`:
  - Create room
  - Join room
  - Ready toggle
  - Game start
  - Leave during waiting
  - Disconnect during game
  - Reconnect
  - Rematch

---

## 15. Open Questions / TODOs

| # | Question | Priority | Decision |
|---|----------|----------|----------|
| 1 | Room ID format: 6-char alphanumeric? | Low | Yes, e.g., "ABC123" |
| 2 | Max nickname length? | Low | 20 characters |
| 3 | What happens if both players disconnect? | Low | Room destroyed after 60s |
| 4 | Should we show opponent's wall tile colors? | Low | Yes, part of public state |
| 5 | Animation duration for tile movement? | Low | 300ms default |
| 6 | Should first-player marker be visually distinct? | Low | Yes, golden tile with "1" |

---

## 16. Approval

**Status:** ☐ Pending review  ☐ Approved  ☐ Changes requested

**Reviewer:** _______________

**Date:** _______________

**Comments:** _______________

---

*End of Specification*
