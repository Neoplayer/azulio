import { create } from 'zustand';
import type { Color, Move, PlayerView, Room, ServerMessage, ClientMessage } from '@azul/shared';
import { createSession, wsUrl } from './lib/api';

export type Screen = 'login' | 'lobby' | 'room' | 'game' | 'results';

export interface Session {
  playerId: string;
  token: string;
  name: string;
}

export interface Selection {
  source: Move['source'];
  color: Color;
  count: number;
}

export interface GameOver {
  scores: { id: string; name: string; score: number }[];
  winnerIds: string[];
}

interface State {
  screen: Screen;
  session: Session | null;
  connection: 'idle' | 'connecting' | 'open' | 'closed';
  rooms: Room[];
  room: Room | null;
  view: PlayerView | null;
  currentPlayerId: string | null;
  deadline: number | null;
  selection: Selection | null;
  over: GameOver | null;
  toast: string | null;

  login: (name: string) => Promise<void>;
  tryRestore: () => void;
  logout: () => void;
  createRoom: (name: string, maxPlayers: number) => void;
  joinRoom: (roomId: string) => void;
  leaveRoom: () => void;
  startGame: () => void;
  selectTile: (source: Move['source'], color: Color) => void;
  cancelSelection: () => void;
  placeAt: (target: Move['target']) => void;
  backToLobby: () => void;
  showToast: (msg: string) => void;
}

const LS = {
  token: 'azul.token',
  name: 'azul.name',
  playerId: 'azul.playerId',
  roomId: 'azul.roomId',
};

let socket: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function send(msg: ClientMessage): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

export const useStore = create<State>((set, get) => {
  function connect(token: string, roomId?: string): void {
    if (socket) {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    }
    set({ connection: 'connecting' });
    const ws = new WebSocket(wsUrl());
    socket = ws;

    ws.onopen = () => {
      set({ connection: 'open' });
      send({ type: 'hello', ...(roomId ? { token, roomId } : { token }) });
      send({ type: 'lobby:subscribe' });
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => send({ type: 'ping' }), 20_000);
    };

    ws.onclose = () => {
      set({ connection: 'closed' });
      if (pingTimer) clearInterval(pingTimer);
      // auto-reconnect while we still hold a session
      const s = get().session;
      if (s) {
        setTimeout(() => {
          if (get().session && (!socket || socket.readyState === WebSocket.CLOSED)) {
            connect(s.token, localStorage.getItem(LS.roomId) ?? undefined);
          }
        }, 1200);
      }
    };

    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string) as ServerMessage;
      } catch {
        return;
      }
      dispatch(msg);
    };
  }

  function dispatch(msg: ServerMessage): void {
    switch (msg.type) {
      case 'hello:ok':
        break;
      case 'lobby:state':
        set({ rooms: msg.rooms });
        break;
      case 'room:state': {
        const room = msg.room;
        localStorage.setItem(LS.roomId, room.id);
        // entering a waiting room → room screen; playing handled by game:state
        set((st) => ({ room, screen: room.status === 'playing' ? st.screen : 'room' }));
        break;
      }
      case 'game:state':
        set((st) => ({
          view: msg.view as PlayerView,
          screen: st.screen === 'results' ? 'results' : 'game',
        }));
        break;
      case 'game:turn':
        set({ currentPlayerId: msg.currentPlayerId, deadline: msg.deadline });
        break;
      case 'game:applied':
        // animations could hook here; state arrives via game:state
        break;
      case 'game:over': {
        const v = get().view;
        const r = get().room;
        const nameOf = (pid: string): string =>
          v?.players.find((p) => p.id === pid)?.name ??
          r?.players.find((p) => p.id === pid)?.name ??
          pid.slice(0, 6);
        const scores = msg.scores.map((s) => ({
          id: s.playerId,
          name: nameOf(s.playerId),
          score: s.score,
        }));
        set({
          over: { scores, winnerIds: msg.winnerIds },
          screen: 'results',
          deadline: null,
          selection: null,
        });
        localStorage.removeItem(LS.roomId);
        break;
      }
      case 'game:aborted':
        localStorage.removeItem(LS.roomId);
        set({ room: null, view: null, screen: 'lobby', selection: null, deadline: null });
        get().showToast('Партия прервана');
        send({ type: 'lobby:subscribe' });
        break;
      case 'player:connection':
        set((st) => {
          if (!st.view) return {};
          return {
            view: {
              ...st.view,
              players: st.view.players.map((p) =>
                p.id === msg.playerId ? { ...p, connected: msg.connected } : p,
              ),
            },
          };
        });
        break;
      case 'session:invalid':
        localStorage.removeItem(LS.token);
        localStorage.removeItem(LS.roomId);
        set({ session: null, screen: 'login', room: null, view: null });
        get().showToast('Сессия истекла, войдите снова');
        break;
      case 'pong':
        break;
      case 'error':
        get().showToast(errorText(msg.code, msg.message));
        break;
    }
  }

  return {
    screen: 'login',
    session: null,
    connection: 'idle',
    rooms: [],
    room: null,
    view: null,
    currentPlayerId: null,
    deadline: null,
    selection: null,
    over: null,
    toast: null,

    async login(name: string) {
      const trimmed = name.trim() || 'Игрок';
      const { playerId, token } = await createSession(trimmed);
      localStorage.setItem(LS.token, token);
      localStorage.setItem(LS.name, trimmed);
      localStorage.setItem(LS.playerId, playerId);
      set({ session: { playerId, token, name: trimmed }, screen: 'lobby' });
      connect(token);
    },

    tryRestore() {
      const token = localStorage.getItem(LS.token);
      const name = localStorage.getItem(LS.name);
      const playerId = localStorage.getItem(LS.playerId);
      if (token && name && playerId) {
        set({ session: { token, name, playerId }, screen: 'lobby' });
        connect(token, localStorage.getItem(LS.roomId) ?? undefined);
      }
    },

    logout() {
      localStorage.removeItem(LS.token);
      localStorage.removeItem(LS.name);
      localStorage.removeItem(LS.playerId);
      localStorage.removeItem(LS.roomId);
      if (socket) socket.close();
      set({ session: null, screen: 'login', rooms: [], room: null, view: null, over: null });
    },

    createRoom(name: string, maxPlayers: number) {
      send({ type: 'room:create', name: name.trim() || 'Комната', maxPlayers, isPrivate: false });
    },

    joinRoom(roomId: string) {
      send({ type: 'room:join', roomId });
    },

    leaveRoom() {
      const room = get().room;
      if (room) send({ type: 'room:leave', roomId: room.id });
      localStorage.removeItem(LS.roomId);
      set({ room: null, screen: 'lobby' });
      send({ type: 'lobby:subscribe' });
    },

    startGame() {
      const room = get().room;
      if (room) send({ type: 'room:start', roomId: room.id });
    },

    selectTile(source: Move['source'], color: Color) {
      const view = get().view;
      if (!view || view.currentPlayerId !== view.you) return;
      const pool = source.type === 'factory' ? view.factories[source.index] : view.center;
      const count = (pool ?? []).filter((c) => c === color).length;
      if (count === 0) return;
      set({ selection: { source, color, count } });
    },

    cancelSelection() {
      set({ selection: null });
    },

    placeAt(target: Move['target']) {
      const { selection, view } = get();
      if (!selection || !view) return;
      const move: Move = { source: selection.source, color: selection.color, target };
      send({ type: 'game:move', move, expectedTurnSeq: view.turnSeq });
      set({ selection: null });
    },

    backToLobby() {
      set({ over: null, view: null, room: null, screen: 'lobby' });
      send({ type: 'lobby:subscribe' });
    },

    showToast(msg: string) {
      set({ toast: msg });
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => set({ toast: null }), 3200);
    },
  };
});

function errorText(code: string, message: string): string {
  switch (code) {
    case 'STALE_TURN_SEQ':
      return 'Ход уже сделан';
    case 'NOT_YOUR_TURN':
      return 'Сейчас не ваш ход';
    case 'ILLEGAL_MOVE':
      return 'Недопустимый ход';
    case 'ROOM_FULL':
      return 'Комната заполнена';
    default:
      return message || 'Ошибка';
  }
}
