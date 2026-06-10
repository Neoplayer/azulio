import type { CSSProperties } from 'react';
import type { Color } from '@azul/shared';
import { GLAZE, type TileMotif } from '../lib/azulejo';

// ── Ornament motifs (drawn in a 0..100 viewBox) ─────────────────────────────
function MotifMedallion({ stroke, sw }: { stroke: string; sw: number }) {
  const petals = [];
  for (let k = 0; k < 8; k++) {
    petals.push(
      <ellipse
        key={k}
        cx="50"
        cy="27"
        rx="6.5"
        ry="15"
        transform={`rotate(${k * 45} 50 50)`}
        fill="none"
        stroke={stroke}
        strokeWidth={sw}
      />,
    );
  }
  const corner = (x: number, y: number, rot: number) => (
    <path
      d="M0,22 A22,22 0 0 1 22,0"
      transform={`translate(${x} ${y}) rotate(${rot} 0 0)`}
      fill="none"
      stroke={stroke}
      strokeWidth={sw}
      opacity="0.85"
    />
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

function MotifLattice({ stroke, sw }: { stroke: string; sw: number }) {
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

function MotifSmooth({ stroke, sw }: { stroke: string; sw: number }) {
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

function Motif({ name, stroke, sw }: { name: TileMotif; stroke: string; sw: number }) {
  if (name === 'lattice') return <MotifLattice stroke={stroke} sw={sw} />;
  if (name === 'smooth') return <MotifSmooth stroke={stroke} sw={sw} />;
  return <MotifMedallion stroke={stroke} sw={sw} />;
}

export interface TileProps {
  color?: Color | null;
  size?: number;
  motif?: TileMotif;
  ghost?: boolean;
  empty?: boolean;
  selected?: boolean;
  dim?: boolean;
  radius?: number;
  style?: CSSProperties;
}

/** A glazed azulejo tile, ghost wall target, or empty porcelain slot. */
export function Tile({
  color,
  size = 28,
  motif = 'medallion',
  ghost = false,
  empty = false,
  selected = false,
  dim = false,
  radius = 4,
  style = {},
}: TileProps) {
  const g = color ? GLAZE[color] : null;

  if (empty || !color || !g) {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          background: 'rgba(20,30,55,0.05)',
          boxShadow:
            'inset 0 1px 2px rgba(20,30,55,0.18), inset 0 -1px 0 rgba(255,255,255,0.5)',
          ...style,
        }}
      />
    );
  }

  const sw = 2.4;

  if (ghost) {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          position: 'relative',
          background: `color-mix(in srgb, ${g.fill} 13%, transparent)`,
          boxShadow: 'inset 0 1px 2px rgba(20,30,55,0.12)',
          overflow: 'hidden',
          ...style,
        }}
      >
        <svg viewBox="0 0 100 100" width="100%" height="100%" style={{ display: 'block', opacity: 0.4 }}>
          <Motif name={motif} stroke={g.fill} sw={sw} />
        </svg>
      </div>
    );
  }

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        position: 'relative',
        background: g.fill,
        opacity: dim ? 0.55 : 1,
        boxShadow: selected
          ? `inset 1.5px 1.5px 2px rgba(255,255,255,0.28), inset -1.5px -1.5px 2px rgba(0,0,0,0.32), 0 0 0 2.5px var(--az-gold), 0 0 12px rgba(201,162,75,0.75), 0 3px 6px rgba(0,0,0,0.3)`
          : `inset 1.5px 1.5px 2px rgba(255,255,255,0.26), inset -1.5px -1.5px 2px rgba(0,0,0,0.32), 0 1px 2px rgba(0,0,0,0.28)`,
        transform: selected ? 'translateY(-2px)' : 'none',
        transition: 'transform 0.12s ease',
        overflow: 'hidden',
        ...style,
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: radius,
          background:
            'radial-gradient(120% 90% at 28% 18%, rgba(255,255,255,0.32), rgba(255,255,255,0) 55%)',
          pointerEvents: 'none',
        }}
      />
      <svg viewBox="0 0 100 100" width="100%" height="100%" style={{ display: 'block', opacity: 0.72 }}>
        <Motif name={motif} stroke={g.line} sw={sw} />
      </svg>
    </div>
  );
}
