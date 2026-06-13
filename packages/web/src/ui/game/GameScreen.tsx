import { useEffect, useState } from 'react';
import type { Color, PlayerView, PlayerBoard, Move } from '../../wire';
import { FLOOR_PENALTIES } from '../../wire';
import { Tile } from '../Tile';
import { WALL, COLOR_RU, GLAZE, type TileMotif } from '../../lib/azulejo';
import { legalRowsFor, isMyTurn, myBoard } from '../../lib/moves';
import { useStore } from '../../store';

const MOTIF: TileMotif = 'unique';
const TURN_MS = 60_000;

// ── Background tracery ──────────────────────────────────────────────────────
function BgPattern() {
  const line = 'rgba(245,242,235,0.06)';
  const gold = 'rgba(201,162,75,0.07)';
  return (
    <svg className="az-bg-svg" preserveAspectRatio="xMidYMin slice">
      <defs>
        <radialGradient id="bgGlow" cx="50%" cy="0%" r="85%">
          <stop offset="0%" stopColor="#234C86" stopOpacity="0.5" />
          <stop offset="60%" stopColor="#0F2143" stopOpacity="0" />
        </radialGradient>
        <pattern id="bgPat" width="56" height="56" patternUnits="userSpaceOnUse">
          <path
            d="M28 -28 A40 40 0 0 1 -28 28 M28 84 A40 40 0 0 1 84 28 M84 84 A40 40 0 0 1 28 84 M-28 28 A40 40 0 0 1 28 84"
            fill="none"
            stroke={line}
            strokeWidth="1.1"
          />
          <path
            d="M28 0 A28 28 0 0 1 56 28 A28 28 0 0 1 28 56 A28 28 0 0 1 0 28 A28 28 0 0 1 28 0 Z"
            fill="none"
            stroke={gold}
            strokeWidth="0.8"
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#bgPat)" />
      <rect width="100%" height="100%" fill="url(#bgGlow)" />
    </svg>
  );
}

// ── Timer (counts down from the server deadline) ────────────────────────────
function useCountdown(deadline: number | null): number {
  const [, force] = useState(0);
  useEffect(() => {
    if (deadline == null) return;
    const id = setInterval(() => force((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [deadline]);
  if (deadline == null) return 0;
  return Math.max(0, Math.round((deadline - Date.now()) / 1000));
}

function GameMenu({ onClose }: { onClose: () => void }) {
  const [confirmLeave, setConfirmLeave] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="az-menu-overlay" onClick={onClose}>
      <div className="az-menu-card" onClick={(e) => e.stopPropagation()}>
        {!confirmLeave ? (
          <>
            <div className="az-menu-title">Меню</div>
            <button className="az-btn az-btn-cobalt" onClick={onClose}>
              Продолжить
            </button>
            <button className="az-btn az-btn-ghost" onClick={() => setConfirmLeave(true)}>
              Покинуть игру
            </button>
          </>
        ) : (
          <>
            <div className="az-menu-title">Покинуть игру?</div>
            <p className="az-menu-text">Вы вернётесь в лобби, текущая партия будет покинута.</p>
            <button className="az-btn az-btn-gold" onClick={() => useStore.getState().leaveRoom()}>
              Да, покинуть
            </button>
            <button className="az-btn az-btn-ghost" onClick={() => setConfirmLeave(false)}>
              Отмена
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function AppBar({ round, deadline, yourTurn }: { round: number; deadline: number | null; yourTurn: boolean }) {
  const secs = useCountdown(deadline);
  const [menuOpen, setMenuOpen] = useState(false);
  const urgent = yourTurn && secs <= 10;
  const mm = Math.floor(secs / 60);
  const ss = String(secs % 60).padStart(2, '0');
  const frac = Math.min(1, Math.max(0, secs / (TURN_MS / 1000)));
  const dash = 119.4;
  return (
    <div className="az-appbar">
      <div className="az-round">
        <span className="az-round-k">РАУНД</span>
        <span className="az-round-n">{round}</span>
      </div>
      <div className="az-turn">
        <div className={'az-timer' + (urgent ? ' az-timer-urgent' : '')}>
          <svg viewBox="0 0 44 44" className="az-timer-ring">
            <circle cx="22" cy="22" r="19" className="az-timer-track" />
            <circle
              cx="22"
              cy="22"
              r="19"
              className="az-timer-fill"
              strokeDasharray={dash}
              strokeDashoffset={dash * (1 - frac)}
            />
          </svg>
          <span className="az-timer-num">
            {mm}:{ss}
          </span>
        </div>
        <span className={'az-turn-label' + (yourTurn ? '' : ' az-turn-wait')}>
          {yourTurn ? 'ВАШ ХОД' : 'ХОД СОПЕРНИКА'}
        </span>
      </div>
      <button className="az-menu" aria-label="Меню" onClick={() => setMenuOpen(true)}>
        <span></span>
        <span></span>
        <span></span>
      </button>
      {menuOpen && <GameMenu onClose={() => setMenuOpen(false)} />}
    </div>
  );
}

function floorPenalty(board: PlayerBoard): number {
  let sum = 0;
  for (let i = 0; i < board.floor.length && i < FLOOR_PENALTIES.length; i++) sum += FLOOR_PENALTIES[i]!;
  return -sum;
}

function MiniWall({ wall }: { wall: (Color | null)[][] }) {
  return (
    <div className="az-miniwall">
      {wall.map((row, r) =>
        row.map((c, k) => (
          <div
            key={`${r}-${k}`}
            className="az-minicell"
            style={{ background: c ? GLAZE[c].fill : 'rgba(20,30,55,0.10)' }}
          />
        )),
      )}
    </div>
  );
}

function OpponentStrip({
  name,
  board,
  connected,
  yourTurn,
}: {
  name: string;
  board: PlayerBoard;
  connected: boolean;
  yourTurn: boolean;
}) {
  return (
    <div className="az-card az-opp">
      <div className="az-opp-id">
        <div className={'az-avatar' + (yourTurn ? ' az-avatar-turn' : '')}>{name[0] ?? '?'}</div>
        <div className="az-opp-meta">
          <div className="az-opp-name">
            {name}
            <span className={'az-dot ' + (connected ? 'az-dot-on' : 'az-dot-off')}></span>
          </div>
          <div className="az-opp-sub">соперник · {connected ? 'на связи' : 'отключён'}</div>
        </div>
      </div>
      <MiniWall wall={board.wall} />
      <div className="az-opp-stats">
        <div className="az-opp-score">{board.score}</div>
        <div className="az-opp-score-k">очки</div>
        {board.floor.length > 0 && <div className="az-opp-floor">пол&nbsp;−{floorPenalty(board)}</div>}
      </div>
    </div>
  );
}

// ── Market ──────────────────────────────────────────────────────────────────
function FactoryTiles({
  tiles,
  source,
  active,
  selColor,
}: {
  tiles: Color[];
  source: Move['source'];
  active: boolean;
  selColor: Color | null;
}) {
  const selectTile = useStore((s) => s.selectTile);
  return (
    <>
      {tiles.map((c, i) => {
        const picked = selColor != null && c === selColor;
        const dim = selColor != null && c !== selColor;
        return (
          <button
            key={i}
            className="az-tile-btn"
            disabled={!active}
            onClick={() => selectTile(source, c)}
          >
            <Tile color={c} size={24} motif={MOTIF} selected={picked} dim={dim} />
          </button>
        );
      })}
    </>
  );
}

function Market({ view, yourTurn }: { view: PlayerView; yourTurn: boolean }) {
  const selection = useStore((s) => s.selection);
  return (
    <section className="az-section">
      <SectionHead n="01" title="РЫНОК" sub="фабрики + центр" />
      <div className="az-factories">
        {view.factories.map((f, i) => {
          const isSel = selection?.source.type === 'factory' && selection.source.index === i;
          return (
            <div
              key={i}
              className={
                'az-factory' + (isSel ? ' az-factory-sel' : '') + (f.length === 0 ? ' az-factory-empty' : '')
              }
            >
              <span className="az-factory-tag">{i + 1}</span>
              <div className="az-factory-tiles">
                <FactoryTiles
                  tiles={f}
                  source={{ type: 'factory', index: i }}
                  active={yourTurn}
                  selColor={isSel ? selection!.color : null}
                />
              </div>
            </div>
          );
        })}
      </div>
      <CenterPool view={view} yourTurn={yourTurn} />
    </section>
  );
}

function CenterPool({ view, yourTurn }: { view: PlayerView; yourTurn: boolean }) {
  const selection = useStore((s) => s.selection);
  const isSel = selection?.source.type === 'center';
  return (
    <div className={'az-center' + (isSel ? ' az-factory-sel' : '')}>
      <div className="az-center-head">
        <span className="az-center-k">ЦЕНТР СТОЛА</span>
        {!view.centerHasFirstToken && <span className="az-center-note">жетон «1» взят</span>}
      </div>
      <div className="az-center-tiles">
        {view.centerHasFirstToken && (
          <div className="az-first-token" title="жетон первого игрока">
            1
          </div>
        )}
        <FactoryTiles
          tiles={view.center}
          source={{ type: 'center' }}
          active={yourTurn}
          selColor={isSel ? selection!.color : null}
        />
      </div>
    </div>
  );
}

// ── Player board ────────────────────────────────────────────────────────────
const CAP = [1, 2, 3, 4, 5];

function PatternLines({ board, legalRows }: { board: PlayerBoard; legalRows: number[] }) {
  const placeAt = useStore((s) => s.placeAt);
  return (
    <div className="az-pattern">
      {board.patternLines.map((line, r) => {
        const cap = CAP[r]!;
        const color = line.find((c) => c !== null) ?? null;
        const count = line.filter((c) => c !== null).length;
        const legal = legalRows.includes(r);
        const cells = [];
        for (let i = 0; i < cap; i++) {
          const filled = i >= cap - count;
          cells.push(
            filled ? (
              <Tile key={i} color={color} size={26} motif={MOTIF} />
            ) : (
              <Tile key={i} empty size={26} />
            ),
          );
        }
        return (
          <button
            key={r}
            className={'az-pline' + (legal ? ' az-legal' : '')}
            disabled={!legal}
            onClick={() => placeAt({ type: 'patternLine', row: r })}
          >
            <div className="az-pline-track">{cells}</div>
            {legal && <span className="az-legal-arrow">→</span>}
          </button>
        );
      })}
    </div>
  );
}

function Wall({ wall }: { wall: (Color | null)[][] }) {
  return (
    <div className="az-wall">
      {wall.map((row, r) => (
        <div key={r} className="az-wall-row">
          {row.map((c, k) => {
            const target = WALL[r]![k]!;
            return c ? (
              <Tile key={k} color={c} size={26} motif={MOTIF} />
            ) : (
              <Tile key={k} color={target} size={26} motif={MOTIF} ghost />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function FloorLine({ board, canDump }: { board: PlayerBoard; canDump: boolean }) {
  const placeAt = useStore((s) => s.placeAt);
  return (
    <div className="az-floor">
      <div className="az-floor-head">
        <div className="az-floor-label">ПОЛ · ШТРАФ</div>
        {canDump && (
          <button className="az-floor-dump" onClick={() => placeAt({ type: 'floor' })}>
            сбросить на пол
          </button>
        )}
      </div>
      <div className="az-floor-cells">
        {FLOOR_PENALTIES.map((p, i) => {
          const occ = board.floor[i];
          return (
            <div key={i} className="az-floor-cell">
              <div className="az-floor-slot">
                {occ === 'FIRST' ? (
                  <div className="az-first-token az-first-floor">1</div>
                ) : occ ? (
                  <Tile color={occ} size={24} motif={MOTIF} />
                ) : (
                  <Tile empty size={24} />
                )}
              </div>
              <span className="az-floor-pen">{p}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SectionHead({
  n,
  title,
  sub,
  children,
}: {
  n: string;
  title: string;
  sub: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="az-sechead">
      <div className="az-sechead-l">
        <span className="az-sechead-n">{n}</span>
        <div className="az-sechead-txt">
          <span className="az-sechead-t">{title}</span>
          <span className="az-sechead-s">{sub}</span>
        </div>
      </div>
      {children}
    </div>
  );
}

function PlayerBoardView({
  board,
  legalRows,
  canDump,
}: {
  board: PlayerBoard;
  legalRows: number[];
  canDump: boolean;
}) {
  return (
    <section className="az-section">
      <SectionHead n="02" title="ВАШ ПЛАНШЕТ" sub="узорные ряды → стена">
        <div className="az-myscore">
          <span className="az-myscore-n">{board.score}</span>
          <span className="az-myscore-k">очки</span>
        </div>
      </SectionHead>
      <div className="az-card az-boardcard">
        <div className="az-board-grid">
          <div className="az-board-col">
            <div className="az-col-label">УЗОРНЫЕ РЯДЫ</div>
            <PatternLines board={board} legalRows={legalRows} />
          </div>
          <div className="az-board-div"></div>
          <div className="az-board-col">
            <div className="az-col-label">СТЕНА</div>
            <Wall wall={board.wall} />
          </div>
        </div>
        <FloorLine board={board} canDump={canDump} />
      </div>
    </section>
  );
}

function HintBar({ view }: { view: PlayerView }) {
  const selection = useStore((s) => s.selection);
  const cancel = useStore((s) => s.cancelSelection);
  if (!isMyTurn(view)) {
    return (
      <div className="az-hint az-hint-idle">
        <span className="az-hint-step">●</span>
        <span>Ход соперника — ожидайте</span>
      </div>
    );
  }
  if (!selection) {
    return (
      <div className="az-hint az-hint-idle">
        <span className="az-hint-step">1</span>
        <span>Коснитесь цвета на рынке, чтобы начать ход</span>
      </div>
    );
  }
  return (
    <div className="az-hint">
      <div className="az-hint-chip">
        <Tile color={selection.color} size={20} motif={MOTIF} />
        <span>
          {COLOR_RU[selection.color]} ×{selection.count}
        </span>
      </div>
      <span className="az-hint-step">2</span>
      <span>
        Выберите <b>подсвеченный ряд</b> или сбросьте на пол
      </span>
      <button className="az-hint-cancel" onClick={cancel}>
        отмена
      </button>
    </div>
  );
}

export function GameScreen() {
  const view = useStore((s) => s.view);
  const deadline = useStore((s) => s.deadline);
  const selection = useStore((s) => s.selection);
  if (!view) return <div className="az-spinner">Загрузка партии…</div>;

  const board = myBoard(view);
  const yourTurn = isMyTurn(view);
  const legalRows = selection ? legalRowsFor(view, selection.color) : [];
  const opponents = view.players.filter((p) => p.id !== view.you);

  return (
    <div className="az-app az-frames">
      <BgPattern />
      <AppBar round={view.round} deadline={deadline} yourTurn={yourTurn} />
      {opponents.map((opp) => (
        <OpponentStrip
          key={opp.id}
          name={opp.name}
          board={opp.board}
          connected={opp.connected}
          yourTurn={view.currentPlayerId === opp.id}
        />
      ))}
      <Market view={view} yourTurn={yourTurn} />
      {board && <PlayerBoardView board={board} legalRows={legalRows} canDump={!!selection} />}
      <HintBar view={view} />
    </div>
  );
}
