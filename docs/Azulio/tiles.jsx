// tiles.jsx — Azulejo tile system: glaze colors, ornate SVG motifs, <Tile> component.
// Five game colors mapped to historic azulejo glazes (cobalt, antimony gold,
// iron terracotta, manganese, copper-emerald). Each tile carries a hand-built
// ceramic motif painted in a contrasting glaze line.

// ── Glaze palette (one per Azul color code) ────────────────────────────────
const GLAZE = {
  blue:   { fill: '#1B3A6B', line: '#EDE7D6', deep: '#12264A' },   // cobalt
  yellow: { fill: '#C9A24B', line: '#1B3A6B' },                    // antimony gold
  red:    { fill: '#9C4A2F', line: '#F4EFE3' },                    // iron terracotta
  black:  { fill: '#2D2A3C', line: '#CFC6E0' },                    // manganese
  white:  { fill: '#2E6B5E', line: '#F2EEE2' },                    // copper emerald
};

const COLOR_RU = {
  blue: 'Синий', yellow: 'Жёлтый', red: 'Терракота', black: 'Манган', white: 'Изумруд',
};
const COLOR_ORDER = ['blue', 'yellow', 'red', 'black', 'white'];

// Each glaze color carries its OWN ceramic motif (used when motif === 'unique').
const COLOR_MOTIF = {
  blue:   'medallion', // cobalt rosette
  yellow: 'lattice',   // antimony quatrefoil
  red:    'star',      // iron octagram
  black:  'fleur',     // manganese four-leaf cross
  white:  'sun',       // copper sunburst
};

// Wall template (rows × cols) — the fixed diagonal colour layout.
const WALL = [
  ['blue', 'yellow', 'red', 'black', 'white'],
  ['white', 'blue', 'yellow', 'red', 'black'],
  ['black', 'white', 'blue', 'yellow', 'red'],
  ['red', 'black', 'white', 'blue', 'yellow'],
  ['yellow', 'red', 'black', 'white', 'blue'],
];

// ── Ornament motifs. Each returns SVG children drawn in a 0..100 viewBox. ───
function MotifMedallion({ stroke, sw }) {
  const petals = [];
  for (let k = 0; k < 8; k++) {
    petals.push(
      <ellipse key={k} cx="50" cy="27" rx="6.5" ry="15"
        transform={`rotate(${k * 45} 50 50)`}
        fill="none" stroke={stroke} strokeWidth={sw} />
    );
  }
  const corner = (x, y, rot) => (
    <path d={`M0,22 A22,22 0 0 1 22,0`} transform={`translate(${x} ${y}) rotate(${rot} 0 0)`}
      fill="none" stroke={stroke} strokeWidth={sw} opacity="0.85" />
  );
  return (
    <g>
      <circle cx="50" cy="50" r="36" fill="none" stroke={stroke} strokeWidth={sw} opacity="0.55" />
      {petals}
      <circle cx="50" cy="50" r="7" fill={stroke} opacity="0.9" />
      {corner(2, 2, 0)}
      {corner(98, 2, 90)}
      {corner(98, 98, 180)}
      {corner(2, 98, 270)}
    </g>
  );
}

function MotifLattice({ stroke, sw }) {
  // interlaced quatrefoil: four edge circles + central diamond + node dots
  return (
    <g fill="none" stroke={stroke} strokeWidth={sw}>
      <circle cx="50" cy="14" r="20" opacity="0.8" />
      <circle cx="50" cy="86" r="20" opacity="0.8" />
      <circle cx="14" cy="50" r="20" opacity="0.8" />
      <circle cx="86" cy="50" r="20" opacity="0.8" />
      <path d="M50,30 L70,50 L50,70 L30,50 Z" opacity="0.95" />
      <circle cx="50" cy="50" r="3.2" fill={stroke} stroke="none" />
      <circle cx="50" cy="14" r="2.4" fill={stroke} stroke="none" />
      <circle cx="50" cy="86" r="2.4" fill={stroke} stroke="none" />
      <circle cx="14" cy="50" r="2.4" fill={stroke} stroke="none" />
      <circle cx="86" cy="50" r="2.4" fill={stroke} stroke="none" />
    </g>
  );
}

function MotifSmooth({ stroke, sw }) {
  return (
    <g fill="none" stroke={stroke} strokeWidth={sw}>
      <rect x="16" y="16" width="68" height="68" rx="4" opacity="0.7" />
      <path d="M50,38 L62,50 L50,62 L38,50 Z" opacity="0.85" />
      <circle cx="24" cy="24" r="2.6" fill={stroke} stroke="none" />
      <circle cx="76" cy="24" r="2.6" fill={stroke} stroke="none" />
      <circle cx="76" cy="76" r="2.6" fill={stroke} stroke="none" />
      <circle cx="24" cy="76" r="2.6" fill={stroke} stroke="none" />
    </g>
  );
}

// 8-point octagram (two overlaid squares) with a centred bloom — iron terracotta.
function MotifStar({ stroke, sw }) {
  return (
    <g fill="none" stroke={stroke} strokeWidth={sw}>
      <rect x="22" y="22" width="56" height="56" opacity="0.85" />
      <rect x="22" y="22" width="56" height="56" transform="rotate(45 50 50)" opacity="0.85" />
      <circle cx="50" cy="50" r="11" />
      <circle cx="50" cy="50" r="2.8" fill={stroke} stroke="none" />
    </g>
  );
}

// Four-leaf floral cross with diagonal buds — manganese.
function MotifFleur({ stroke, sw }) {
  const leaf = (rot) => (
    <path key={rot} d="M50,50 C40,33 40,18 50,8 C60,18 60,33 50,50 Z"
      transform={`rotate(${rot} 50 50)`} opacity="0.9" />
  );
  const bud = (x, y) => <circle key={x + '-' + y} cx={x} cy={y} r="3" fill={stroke} stroke="none" opacity="0.85" />;
  return (
    <g fill="none" stroke={stroke} strokeWidth={sw}>
      {[0, 90, 180, 270].map(leaf)}
      <circle cx="50" cy="50" r="6" />
      <circle cx="50" cy="50" r="2.4" fill={stroke} stroke="none" />
      {bud(28, 28)}{bud(72, 28)}{bud(72, 72)}{bud(28, 72)}
    </g>
  );
}

// Radiant sunburst — concentric rings + spokes — copper emerald.
function MotifSun({ stroke, sw }) {
  const rays = [];
  for (let k = 0; k < 12; k++) {
    rays.push(
      <line key={k} x1="50" y1="19" x2="50" y2="30"
        transform={`rotate(${k * 30} 50 50)`} strokeLinecap="round" />
    );
  }
  return (
    <g fill="none" stroke={stroke} strokeWidth={sw}>
      <circle cx="50" cy="50" r="33" opacity="0.5" />
      {rays}
      <circle cx="50" cy="50" r="15" opacity="0.9" />
      <circle cx="50" cy="50" r="6" />
      <circle cx="50" cy="50" r="2.6" fill={stroke} stroke="none" />
    </g>
  );
}

function Motif({ name, stroke, sw }) {
  if (name === 'lattice') return <MotifLattice stroke={stroke} sw={sw} />;
  if (name === 'smooth') return <MotifSmooth stroke={stroke} sw={sw} />;
  if (name === 'star') return <MotifStar stroke={stroke} sw={sw} />;
  if (name === 'fleur') return <MotifFleur stroke={stroke} sw={sw} />;
  if (name === 'sun') return <MotifSun stroke={stroke} sw={sw} />;
  return <MotifMedallion stroke={stroke} sw={sw} />;
}

// ── Tile ───────────────────────────────────────────────────────────────────
// variants: filled glaze tile | ghost (empty wall target, faint) | empty slot
function Tile({ color, size = 28, motif = 'unique', ghost = false, empty = false,
                selected = false, dim = false, radius = 4, style = {} }) {
  const g = color ? GLAZE[color] : null;
  // 'unique' (default) gives every glaze color its own ornament; an explicit
  // motif name forces that single ornament across all tiles.
  const motifName = (!motif || motif === 'unique') ? (color ? COLOR_MOTIF[color] : 'medallion') : motif;

  // Empty pattern-line slot — a recessed porcelain square
  if (empty || !color) {
    return (
      <div style={{
        width: size, height: size, borderRadius: radius,
        background: 'rgba(20,30,55,0.05)',
        boxShadow: 'inset 0 1px 2px rgba(20,30,55,0.18), inset 0 -1px 0 rgba(255,255,255,0.5)',
        ...style,
      }} />
    );
  }

  const sw = 2.4;

  // Ghost wall cell — shows which colour belongs there, very faint
  if (ghost) {
    return (
      <div style={{
        width: size, height: size, borderRadius: radius, position: 'relative',
        background: `color-mix(in srgb, ${g.fill} 13%, transparent)`,
        boxShadow: 'inset 0 1px 2px rgba(20,30,55,0.12)',
        overflow: 'hidden', ...style,
      }}>
        <svg viewBox="0 0 100 100" width="100%" height="100%" style={{ display: 'block', opacity: 0.4 }}>
          <Motif name={motifName} stroke={g.fill} sw={sw} />
        </svg>
      </div>
    );
  }

  // Filled glaze tile
  return (
    <div style={{
      width: size, height: size, borderRadius: radius, position: 'relative',
      background: g.fill,
      opacity: dim ? 0.55 : 1,
      boxShadow: selected
        ? `inset 1.5px 1.5px 2px rgba(255,255,255,0.28), inset -1.5px -1.5px 2px rgba(0,0,0,0.32), 0 0 0 2.5px var(--az-gold), 0 0 12px rgba(201,162,75,0.75), 0 3px 6px rgba(0,0,0,0.3)`
        : `inset 1.5px 1.5px 2px rgba(255,255,255,0.26), inset -1.5px -1.5px 2px rgba(0,0,0,0.32), 0 1px 2px rgba(0,0,0,0.28)`,
      transform: selected ? 'translateY(-2px)' : 'none',
      transition: 'transform 0.12s ease',
      overflow: 'hidden', ...style,
    }}>
      {/* glaze gloss */}
      <div style={{
        position: 'absolute', inset: 0, borderRadius: radius,
        background: 'radial-gradient(120% 90% at 28% 18%, rgba(255,255,255,0.32), rgba(255,255,255,0) 55%)',
        pointerEvents: 'none',
      }} />
      <svg viewBox="0 0 100 100" width="100%" height="100%" style={{ display: 'block', opacity: 0.72 }}>
        <Motif name={motifName} stroke={g.line} sw={sw} />
      </svg>
    </div>
  );
}

Object.assign(window, {
  GLAZE, COLOR_RU, COLOR_ORDER, COLOR_MOTIF, WALL, Tile, Motif,
});
