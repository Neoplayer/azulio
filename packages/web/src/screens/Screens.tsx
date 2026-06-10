import { useState } from 'react';
import { useStore } from '../store';

function Brand({ sub }: { sub: string }) {
  return (
    <div className="az-brand">
      <h1 className="az-brand-title">Azul</h1>
      <div className="az-brand-rule" />
      <div className="az-brand-sub">{sub}</div>
    </div>
  );
}

export function LoginScreen() {
  const login = useStore((s) => s.login);
  const [name, setName] = useState(localStorage.getItem('azul.name') ?? '');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await login(name);
    } catch {
      useStore.getState().showToast('Не удалось войти');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="az-screen">
      <Brand sub="изразцовая партия онлайн" />
      <div className="az-panel">
        <label className="az-field-label" htmlFor="nick">
          Ваш ник
        </label>
        <input
          id="nick"
          className="az-input"
          value={name}
          maxLength={16}
          placeholder="Например, Лена"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <div style={{ height: 14 }} />
        <button className="az-btn az-btn-gold" disabled={busy} onClick={submit}>
          {busy ? 'Входим…' : 'Войти как гость'}
        </button>
      </div>
    </div>
  );
}

export function LobbyScreen() {
  const rooms = useStore((s) => s.rooms);
  const session = useStore((s) => s.session);
  const createRoom = useStore((s) => s.createRoom);
  const joinRoom = useStore((s) => s.joinRoom);
  const logout = useStore((s) => s.logout);
  const [creating, setCreating] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(2);

  return (
    <div className="az-screen">
      <div className="az-lobby-head">
        <h2 className="az-lobby-title">Лобби</h2>
        <button
          className="az-lobby-you"
          onClick={logout}
          style={{ background: 'none', border: 'none', cursor: 'pointer' }}
        >
          {session?.name} · выйти
        </button>
      </div>

      {creating ? (
        <div className="az-panel">
          <label className="az-field-label">Название комнаты</label>
          <input
            className="az-input"
            value={roomName}
            maxLength={24}
            placeholder="Партия Лены"
            onChange={(e) => setRoomName(e.target.value)}
          />
          <div style={{ height: 12 }} />
          <label className="az-field-label">Игроков</label>
          <div className="az-row">
            {[2, 3, 4].map((n) => (
              <button
                key={n}
                className={'az-btn ' + (maxPlayers === n ? 'az-btn-cobalt' : 'az-btn-ghost')}
                onClick={() => setMaxPlayers(n)}
              >
                {n}
              </button>
            ))}
          </div>
          <div style={{ height: 14 }} />
          <div className="az-row">
            <button className="az-btn az-btn-ghost" onClick={() => setCreating(false)}>
              Отмена
            </button>
            <button
              className="az-btn az-btn-gold"
              onClick={() => createRoom(roomName, maxPlayers)}
            >
              Создать
            </button>
          </div>
        </div>
      ) : (
        <button className="az-btn az-btn-gold" onClick={() => setCreating(true)}>
          + Создать комнату
        </button>
      )}

      <div className="az-roomlist">
        {rooms.length === 0 && <div className="az-empty">Пока нет активных комнат. Создайте первую!</div>}
        {rooms.map((r) => {
          const full = r.players.length >= r.maxPlayers;
          return (
            <button key={r.id} className="az-roomcard" disabled={full} onClick={() => joinRoom(r.id)}>
              <div>
                <div className="az-roomcard-name">{r.name}</div>
                <div className="az-roomcard-sub">
                  {full ? 'заполнена' : 'ожидает игроков'} · до {r.maxPlayers}
                </div>
              </div>
              <div className="az-roomcard-count">
                {r.players.length}/{r.maxPlayers}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function RoomScreen() {
  const room = useStore((s) => s.room);
  const session = useStore((s) => s.session);
  const startGame = useStore((s) => s.startGame);
  const leaveRoom = useStore((s) => s.leaveRoom);
  if (!room || !session) return null;

  const isHost = room.hostId === session.playerId;
  const canStart = isHost && room.players.length >= 2;

  return (
    <div className="az-screen">
      <Brand sub="комната ожидания" />
      <div className="az-panel">
        <label className="az-field-label">{room.name}</label>
        <div className="az-players">
          {room.players.map((p) => (
            <div key={p.id} className="az-playerrow">
              <div className="az-avatar" style={{ width: 30, height: 30, fontSize: 15 }}>
                {p.name[0] ?? '?'}
              </div>
              <span className="az-playerrow-name">{p.name}</span>
              {p.id === room.hostId && <span className="az-tag-host">ХОЗЯИН</span>}
              {p.id === session.playerId && <span className="az-tag-you">вы</span>}
            </div>
          ))}
          {Array.from({ length: room.maxPlayers - room.players.length }).map((_, i) => (
            <div key={`empty-${i}`} className="az-playerrow" style={{ opacity: 0.5 }}>
              <div className="az-avatar" style={{ width: 30, height: 30, fontSize: 15, background: 'var(--az-muted)' }}>
                ?
              </div>
              <span className="az-playerrow-name">ожидание…</span>
            </div>
          ))}
        </div>
      </div>

      {isHost ? (
        <button className="az-btn az-btn-gold" disabled={!canStart} onClick={startGame}>
          {canStart ? 'Запустить игру' : 'Нужно минимум 2 игрока'}
        </button>
      ) : (
        <div className="az-empty">Ожидаем, пока хозяин запустит партию…</div>
      )}
      <button className="az-btn az-btn-ghost" onClick={leaveRoom}>
        Покинуть комнату
      </button>
    </div>
  );
}

export function ResultsScreen() {
  const over = useStore((s) => s.over);
  const session = useStore((s) => s.session);
  const backToLobby = useStore((s) => s.backToLobby);
  if (!over) return null;

  const ranked = [...over.scores].sort((a, b) => b.score - a.score);
  const youWon = session != null && over.winnerIds.includes(session.playerId);

  return (
    <div className="az-screen">
      <Brand sub={youWon ? 'вы победили!' : 'партия завершена'} />
      <div className="az-result-list">
        {ranked.map((p, i) => {
          const winner = over.winnerIds.includes(p.id);
          return (
            <div key={p.id} className={'az-result-row' + (winner ? ' az-winner' : '')}>
              <div className="az-result-rank">{i + 1}</div>
              <div className="az-result-name">
                {p.name}
                {session?.playerId === p.id ? ' · вы' : ''}
              </div>
              <div className="az-result-score">{p.score}</div>
            </div>
          );
        })}
      </div>
      <button className="az-btn az-btn-gold" onClick={backToLobby}>
        В лобби
      </button>
    </div>
  );
}
