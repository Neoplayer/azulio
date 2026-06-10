import React from 'react';
import { motion } from 'framer-motion';
import { Tile } from './Tile';
import { TileType } from '../types/game';
import { useGameStore } from '../store/gameStore';

export const Center: React.FC = () => {
  const { center, selectedTile, takeFromCenter } = useGameStore();

  const tiles = center.reduce((acc, tile) => {
    acc[tile] = (acc[tile] || 0) + 1;
    return acc;
  }, {} as Record<TileType, number>);

  const isEmpty = center.length === 0;

  return (
    <motion.div
      layout
      className={`
        p-6 rounded-3xl center-shadow
        bg-gradient-to-br from-slate-800/80 to-slate-900/80
        border border-slate-700/50
        min-h-[200px]
      `}
    >
      <h3 className="text-lg font-semibold text-slate-300 mb-4 flex items-center gap-2">
        <span className="w-3 h-3 rounded-full bg-amber-500"></span>
        Центр
        {!isEmpty && (
          <span className="text-sm text-slate-500">
            ({center.length} плиток)
          </span>
        )}
      </h3>

      {isEmpty ? (
        <div className="flex items-center justify-center h-32 text-slate-600">
          Пусто
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          {Object.entries(tiles).map(([tile, count]) => (
            <motion.div
              key={tile}
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              className="relative"
            >
              <Tile
                tile={tile as TileType}
                onClick={() => takeFromCenter(tile as TileType)}
                isSelected={selectedTile === tile}
                size="lg"
              />
              {count > 1 && (
                <span className="absolute -top-2 -right-2 w-6 h-6 bg-amber-600 rounded-full text-xs flex items-center justify-center text-white font-bold">
                  {count}
                </span>
              )}
            </motion.div>
          ))}
        </div>
      )}
    </motion.div>
  );
};
