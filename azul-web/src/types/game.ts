export interface Factory {
  id: number;
  tiles: TileType[];
}

export const TILE_COLORS = {
  A: {
    bg: 'bg-blue-500',
    border: 'border-blue-600',
    text: 'text-white',
    hex: '#3b82f6',
  },
  B: {
    bg: 'bg-yellow-500',
    border: 'border-yellow-600',
    text: 'text-slate-900',
    hex: '#eab308',
  },
  C: {
    bg: 'bg-red-500',
    border: 'border-red-600',
    text: 'text-white',
    hex: '#ef4444',
  },
  D: {
    bg: 'bg-slate-800',
    border: 'border-slate-900',
    text: 'text-white',
    hex: '#1f2937',
  },
  E: {
    bg: 'bg-slate-100',
    border: 'border-slate-300',
    text: 'text-slate-900',
    hex: '#f3f4f6',
  },
} as const;

export type TileType = keyof typeof TILE_COLORS;

export const SYMBOLS: TileType[] = ['A', 'B', 'C', 'D', 'E'];

export const COPIES_PER_SYMBOL = 20;
export const FACTORIES_COUNT = 5;
export const TILES_PER_FACTORY = 4;
