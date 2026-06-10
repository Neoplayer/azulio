import type { Color } from '@azul/shared';

/** Historic azulejo glaze per game colour: fill + contrasting motif line. */
export const GLAZE: Record<Color, { fill: string; line: string }> = {
  blue: { fill: '#1B3A6B', line: '#EDE7D6' }, // cobalt
  yellow: { fill: '#C9A24B', line: '#1B3A6B' }, // antimony gold
  red: { fill: '#9C4A2F', line: '#F4EFE3' }, // iron terracotta
  black: { fill: '#2D2A3C', line: '#CFC6E0' }, // manganese
  white: { fill: '#2E6B5E', line: '#F2EEE2' }, // copper emerald
};

export const COLOR_RU: Record<Color, string> = {
  blue: 'Синий',
  yellow: 'Жёлтый',
  red: 'Терракота',
  black: 'Манган',
  white: 'Изумруд',
};

/** Fixed diagonal wall layout (rows × cols). */
export const WALL: Color[][] = [
  ['blue', 'yellow', 'red', 'black', 'white'],
  ['white', 'blue', 'yellow', 'red', 'black'],
  ['black', 'white', 'blue', 'yellow', 'red'],
  ['red', 'black', 'white', 'blue', 'yellow'],
  ['yellow', 'red', 'black', 'white', 'blue'],
];

export const FLOOR_PENALTY_LABELS = [-1, -1, -2, -2, -2, -3, -3];

export type TileMotif = 'medallion' | 'lattice' | 'smooth';
