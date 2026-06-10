// board.jsx — Игра screen components for Azul Online (mobile).
// Depends on Tile/WALL/GLAZE/COLOR_RU from tiles.jsx (on window).

const PENALTIES = [-1, -1, -2, -2, -2, -3, -3];
const CAP = [1, 2, 3, 4, 5];

// ── App bar: round, turn + timer, menu ─────────────────────────────────────
function AppBar({ round, timer, urgent }) {
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
            <circle cx="22" cy="22" r="19" className="az-timer-fill"
              strokeDasharray="119.4" strokeDashoffset="33" />
          </svg>
          <span className="az-timer-num">{timer}</span>
        </div>
        <span className="az-turn-label">ВАШ ХОД</span>
      </div>
      <button className="az-menu" aria-label="Меню">
        <span></span><span></span><span></span>
      </button>
    </div>
  );
}

// ── Opponent strip ──────────────────────────────────────────────────────────
function MiniWall({ wall, motif }) {
  return (
    <div className="az-miniwall">
      {wall.map((row, r) => row.map((c, k) => (
        <div key={r + '-' + k} className="az-minicell"
          style={{ background: c ? GLAZE[c].fill : 'rgba(20,30,55,0.10)' }} />
      )))}
    </div>
  );
}

function OpponentStrip({ opp, motif }) {
  return (
    <div className="az-card az-opp">
      <div className="az-opp-id">
        <div className="az-avatar">{opp.name[0]}</div>
        <div className="az-opp-meta">
          <div className="az-opp-name">
            {opp.name}
            <span className={'az-dot ' + (opp.connected ? 'az-dot-on' : 'az-dot-off')}></span>
          </div>
          <div className="az-opp-sub">соперник · {opp.connected ? 'на связи' : 'отключён'}</div>
        </div>
      </div>
      <MiniWall wall={opp.wall} motif={motif} />
      <div className="az-opp-stats">
        <div className="az-opp-score">{opp.score}</div>
        <div className="az-opp-score-k">очки</div>
        <div className="az-opp-floor">пол&nbsp;−{opp.floorPenalty}</div>
      </div>
    </div>
  );
}

// ── Market: factories + center ──────────────────────────────────────────────
function Factory({ tiles, idx, motif, sel, hint }) {
  const isSel = hint && sel && sel.factory === idx;
  return (
    <div className={'az-factory' + (isSel ? ' az-factory-sel' : '')}>
      <span className="az-factory-tag">{idx + 1}</span>
      <div className="az-factory-tiles">
        {tiles.map((c, i) => {
          const picked = isSel && c === sel.color;
          const dim = isSel && c !== sel.color;
          return <Tile key={i} color={c} size={24} motif={motif} selected={picked} dim={dim} />;
        })}
      </div>
    </div>
  );
}

function CenterPool({ tiles, hasFirst, motif, sel, hint }) {
  const isSel = hint && sel && sel.factory === 'center';
  return (
    <div className={'az-center' + (isSel ? ' az-factory-sel' : '')}>
      <div className="az-center-head">
        <span className="az-center-k">ЦЕНТР СТОЛА</span>
        <span className="az-center-note">жетон «1» взят</span>
      </div>
      <div className="az-center-tiles">
        {hasFirst && <div className="az-first-token" title="жетон первого игрока">1</div>}
        {tiles.map((c, i) => {
          const picked = isSel && c === sel.color;
          const dim = isSel && c !== sel.color;
          return <Tile key={i} color={c} size={24} motif={motif} selected={picked} dim={dim} />;
        })}
      </div>
    </div>
  );
}

function Market({ factories, center, hasFirst, motif, sel, hint }) {
  return (
    <section className="az-section">
      <SectionHead n="01" title="РЫНОК" sub="фабрики + центр" />
      <div className="az-factories">
        {factories.map((f, i) => (
          <Factory key={i} tiles={f} idx={i} motif={motif} sel={sel} hint={hint} />
        ))}
      </div>
      <CenterPool tiles={center} hasFirst={hasFirst} motif={motif} sel={sel} hint={hint} />
    </section>
  );
}

// ── Player board: pattern lines + wall + floor ──────────────────────────────
function PatternLines({ lines, motif, legalRows, hint }) {
  return (
    <div className="az-pattern">
      {lines.map((line, r) => {
        const cap = CAP[r];
        const legal = hint && legalRows.includes(r);
        // capacity = cap slots, tiles fill from the right (toward the wall)
        const cells = [];
        for (let i = 0; i < cap; i++) {
          const fromRight = cap - 1 - i;       // index position
          const has = fromRight < line.length;
          const color = has ? line[line.length - 1 - fromRight] : null;
          cells.push(
            color
              ? <Tile key={i} color={color} size={26} motif={motif} />
              : <Tile key={i} empty size={26} />
          );
        }
        return (
          <div key={r} className={'az-pline' + (legal ? ' az-legal' : '')}>
            <div className="az-pline-track">{cells}</div>
            {legal && <span className="az-legal-arrow">→</span>}
          </div>
        );
      })}
    </div>
  );
}

function Wall({ wall, motif }) {
  return (
    <div className="az-wall">
      {wall.map((row, r) => (
        <div key={r} className="az-wall-row">
          {row.map((c, k) => {
            const target = WALL[r][k];
            return c
              ? <Tile key={k} color={c} size={26} motif={motif} />
              : <Tile key={k} color={target} size={26} motif={motif} ghost />;
          })}
        </div>
      ))}
    </div>
  );
}

function FloorLine({ floor, motif }) {
  return (
    <div className="az-floor">
      <div className="az-floor-label">ПОЛ · ШТРАФ</div>
      <div className="az-floor-cells">
        {PENALTIES.map((p, i) => {
          const occ = floor[i];
          return (
            <div key={i} className="az-floor-cell">
              <div className="az-floor-slot">
                {occ === 'FIRST'
                  ? <div className="az-first-token az-first-floor">1</div>
                  : occ
                    ? <Tile color={occ} size={24} motif={motif} />
                    : <Tile empty size={24} />}
              </div>
              <span className="az-floor-pen">{p}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PlayerBoard({ you, motif, legalRows, hint }) {
  return (
    <section className="az-section">
      <SectionHead n="02" title="ВАШ ПЛАНШЕТ" sub="узорные ряды → стена">
        <div className="az-myscore">
          <span className="az-myscore-n">{you.score}</span>
          <span className="az-myscore-k">очки</span>
        </div>
      </SectionHead>
      <div className="az-card az-boardcard">
        <div className="az-board-grid">
          <div className="az-board-col">
            <div className="az-col-label">УЗОРНЫЕ РЯДЫ</div>
            <PatternLines lines={you.patternLines} motif={motif} legalRows={legalRows} hint={hint} />
          </div>
          <div className="az-board-div"></div>
          <div className="az-board-col">
            <div className="az-col-label">СТЕНА</div>
            <Wall wall={you.wall} motif={motif} />
          </div>
        </div>
        <FloorLine floor={you.floor} motif={motif} />
      </div>
    </section>
  );
}

// ── Section header (gold-ruled, mono label) ─────────────────────────────────
function SectionHead({ n, title, sub, children }) {
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

// ── Hint bar (2-tap move guidance) ──────────────────────────────────────────
function HintBar({ sel, hint }) {
  if (!hint || !sel) {
    return (
      <div className="az-hint az-hint-idle">
        <span className="az-hint-step">①</span>
        <span>Коснитесь цвета на рынке, чтобы начать ход</span>
      </div>
    );
  }
  return (
    <div className="az-hint">
      <div className="az-hint-chip">
        <Tile color={sel.color} size={20} motif="medallion" />
        <span>{COLOR_RU[sel.color]} ×{sel.count}</span>
      </div>
      <span className="az-hint-step">②</span>
      <span>Выберите <b>подсвеченный ряд</b> или сбросьте на пол</span>
    </div>
  );
}

Object.assign(window, {
  AppBar, OpponentStrip, Market, PlayerBoard, HintBar, SectionHead, PENALTIES, CAP,
});
