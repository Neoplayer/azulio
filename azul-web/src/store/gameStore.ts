import { create } from 'zustand';
import { SYMBOLS, COPIES_PER_SYMBOL, FACTORIES_COUNT, TILES_PER_FACTORY, type TileType } from '../types/game';

interface Factory {
  id: number;
  tiles: TileType[];
}

interface GameState {
  bag: TileType[];
  factories: Factory[];
  center: TileType[];
  selectedFactory: number | null;
  selectedTile: TileType | null;
  
  // Actions
  resetGame: () => void;
  newRound: () => void;
  selectFactory: (factoryId: number | null) => void;
  selectTile: (tile: TileType | null) => void;
  takeFromFactory: (factoryId: number, tileType: TileType) => void;
  takeFromCenter: (tileType: TileType) => void;
}

function shuffleArray<T>(array: T[]): T[] {
  const newArray = [...array];
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
  }
  return newArray;
}

function createBag(): TileType[] {
  const bag: TileType[] = [];
  for (const symbol of SYMBOLS) {
    for (let i = 0; i < COPIES_PER_SYMBOL; i++) {
      bag.push(symbol);
    }
  }
  return shuffleArray(bag);
}

function drawTiles(bag: TileType[], count: number): { tiles: TileType[]; remainingBag: TileType[] } {
  const tiles = bag.slice(0, count);
  const remainingBag = bag.slice(count);
  return { tiles, remainingBag };
}

function createFactories(bag: TileType[]): { factories: Factory[]; remainingBag: TileType[] } {
  const factories: Factory[] = [];
  let currentBag = [...bag];
  
  for (let i = 0; i < FACTORIES_COUNT; i++) {
    const result = drawTiles(currentBag, TILES_PER_FACTORY);
    factories.push({
      id: i + 1,
      tiles: result.tiles,
    });
    currentBag = result.remainingBag;
  }
  
  return { factories, remainingBag: currentBag };
}

export const useGameStore = create<GameState>((set, get) => ({
  bag: [],
  factories: [],
  center: [],
  selectedFactory: null,
  selectedTile: null,

  resetGame: () => {
    const bag = createBag();
    const { factories, remainingBag } = createFactories(bag);
    set({
      bag: remainingBag,
      factories,
      center: [],
      selectedFactory: null,
      selectedTile: null,
    });
  },

  newRound: () => {
    const { bag } = get();
    const { factories, remainingBag } = createFactories(bag);
    set({
      bag: remainingBag,
      factories,
      center: [],
      selectedFactory: null,
      selectedTile: null,
    });
  },

  selectFactory: (factoryId) => {
    set({ selectedFactory: factoryId });
  },

  selectTile: (tile) => {
    set({ selectedTile: tile });
  },

  takeFromFactory: (factoryId, tileType) => {
    const { factories, center } = get();
    const factory = factories.find(f => f.id === factoryId);
    
    if (!factory || !factory.tiles.includes(tileType)) return;

    const leftovers = factory.tiles.filter(t => t !== tileType);

    const newFactories = factories.map(f =>
      f.id === factoryId ? { ...f, tiles: [] } : f
    );

    set({
      factories: newFactories,
      center: [...center, ...leftovers],
      selectedFactory: null,
      selectedTile: null,
    });
  },

  takeFromCenter: (tileType) => {
    const { center } = get();
    if (!center.includes(tileType)) return;

    const remaining = center.filter(t => t !== tileType);

    set({
      center: remaining,
      selectedFactory: null,
      selectedTile: null,
    });
  },
}));
