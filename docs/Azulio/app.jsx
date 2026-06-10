// app.jsx — assembles the Игра screen, background tracery, and Tweaks.
// (Azul Online · mobile game board reference)

// ── Concrete mid-game position (2 players, round 2, your turn) ───────────────
// You have just tapped the 3 blue tiles in factory #2; legal pattern rows glow.
const GAME = {
  round: 2,
  timer: '0:47',
  factories: [
    ['white', 'white', 'red', 'yellow'],
    ['blue', 'blue', 'blue', 'yellow'],   // selected source
    ['black', 'red', 'red', 'white'],
    ['yellow', 'black', 'blue', 'white'],
    ['red', 'red', 'black', 'white'],
  ],
  center: ['yellow', 'black', 'white', 'red', 'yellow'],
  centerHasFirst: false,                  // token already taken (it sits on your floor)
  you: {
    name: 'Вы', score: 21,
    patternLines: [
      [],                                 // row0  cap1  empty   → legal for blue
      ['red', 'red'],                     // row1  cap2  full
      ['yellow'],                         // row2  cap3  1/3
      [],                                 // row3  cap4  empty   → legal for blue
      ['black', 'black', 'black'],        // row4  cap5  3/5
    ],
    wall: [
      [null, null, null, null, null],
      [null, null, 'yellow', null, 'black'],
      [null, 'white', 'blue', null, null],
      [null, null, null, null, null],
      [null, 'red', null, null, null],
    ],
    floor: ['FIRST'],                     // holds first-player token (−1)
  },
  opp: {
    name: 'Лена', score: 18, connected: true, floorPenalty: 1,
    wall: [
      ['blue', 'yellow', 'red', 'black', null], // 4/5 — one tile from ending the game
      [null, 'blue', null, null, null],
      [null, null, 'blue', null, null],
      [null, null, null, null, 'yellow'],
      [null, null, null, null, null],
    ],
  },
};

const SELECTION = { factory: 1, color: 'blue', count: 3 };
const LEGAL_ROWS = [0, 3];

// ── Background tracery (azulejo net), drawn as SVG <pattern> ────────────────
function BgPattern({ kind }) {
  if (kind === 'plain') {
    return (
      <svg className="az-bg-svg" preserveAspectRatio="none">
        <defs>
          <radialGradient id="bgGlow" cx="50%" cy="0%" r="90%">
            <stop offset="0%" stopColor="#234C86" stopOpacity="0.55" />
            <stop offset="55%" stopColor="#0F2143" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#bgGlow)" />
      </svg>
    );
  }
  const line = 'rgba(245,242,235,0.06)';
  const gold = 'rgba(201,162,75,0.07)';
  return (
    <svg className="az-bg-svg" preserveAspectRatio="xMidYMin slice">
      <defs>
        <radialGradient id="bgGlow" cx="50%" cy="0%" r="85%">
          <stop offset="0%" stopColor="#234C86" stopOpacity="0.5" />
          <stop offset="60%" stopColor="#0F2143" stopOpacity="0" />
        </radialGradient>
        {kind === 'diamonds' ? (
          <pattern id="bgPat" width="46" height="46" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="46" height="46" fill="none" />
            <path d="M0 23 H46 M23 0 V46" stroke={line} strokeWidth="1" />
            <circle cx="23" cy="23" r="2" fill={gold} />
          </pattern>
        ) : (
          <pattern id="bgPat" width="56" height="56" patternUnits="userSpaceOnUse">
            <path d="M28 -28 A40 40 0 0 1 -28 28 M28 84 A40 40 0 0 1 84 28 M84 84 A40 40 0 0 1 28 84 M-28 28 A40 40 0 0 1 28 84"
              fill="none" stroke={line} strokeWidth="1.1" />
            <path d="M28 0 A28 28 0 0 1 56 28 A28 28 0 0 1 28 56 A28 28 0 0 1 0 28 A28 28 0 0 1 28 0 Z"
              fill="none" stroke={gold} strokeWidth="0.8" />
          </pattern>
        )}
      </defs>
      <rect width="100%" height="100%" fill="url(#bgPat)" />
      <rect width="100%" height="100%" fill="url(#bgGlow)" />
    </svg>
  );
}

// ── Tweak defaults ──────────────────────────────────────────────────────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "tileMotif": "medallion",
  "background": "tracery",
  "goldFrames": true,
  "moveHint": true
}/*EDITMODE-END*/;

const MOTIF_LABELS = { 'Медальон': 'medallion', 'Решётка': 'lattice', 'Гладкая': 'smooth' };
const BG_LABELS = { 'Кружево': 'tracery', 'Ромбы': 'diamonds', 'Гладкий': 'plain' };

function GameScreen({ t }) {
  return (
    <div className={'az-app' + (t.goldFrames ? ' az-frames' : '')}>
      <BgPattern kind={t.background} />
      <AppBar round={GAME.round} timer={GAME.timer} urgent={false} />
      <OpponentStrip opp={GAME.opp} motif={t.tileMotif} />
      <Market
        factories={GAME.factories} center={GAME.center} hasFirst={GAME.centerHasFirst}
        motif={t.tileMotif} sel={SELECTION} hint={t.moveHint} />
      <PlayerBoard you={GAME.you} motif={t.tileMotif} legalRows={LEGAL_ROWS} hint={t.moveHint} />
      <HintBar sel={SELECTION} hint={t.moveHint} />
    </div>
  );
}

function keyOf(map, val) { return Object.keys(map).find(k => map[k] === val) || Object.keys(map)[0]; }

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  return (
    <React.Fragment>
      <IOSDevice>
        <GameScreen t={t} />
      </IOSDevice>

      <TweaksPanel>
        <TweakSection label="Изразцы" />
        <TweakRadio label="Орнамент плитки"
          value={keyOf(MOTIF_LABELS, t.tileMotif)}
          options={Object.keys(MOTIF_LABELS)}
          onChange={(v) => setTweak('tileMotif', MOTIF_LABELS[v])} />

        <TweakSection label="Фон и оправа" />
        <TweakRadio label="Узор фона"
          value={keyOf(BG_LABELS, t.background)}
          options={Object.keys(BG_LABELS)}
          onChange={(v) => setTweak('background', BG_LABELS[v])} />
        <TweakToggle label="Золотые рамки панелей" value={t.goldFrames}
          onChange={(v) => setTweak('goldFrames', v)} />

        <TweakSection label="Состояние хода" />
        <TweakToggle label="Подсветка выбора (2 тапа)" value={t.moveHint}
          onChange={(v) => setTweak('moveHint', v)} />
      </TweaksPanel>
    </React.Fragment>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
