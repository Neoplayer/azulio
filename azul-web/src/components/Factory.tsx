import React from 'react';
import { motion } from 'framer-motion';
import { Tile } from './Tile';
import { TileType } from '../types/game';

interface FactoryData {
  id: number;
  tiles: TileType[];
}

interface FactoryProps {
  factory: FactoryData;
  isSelected: boolean;
  onSelect: () => void;
  onTileSelect: (tile: TileType) => void;
  selectedTile: TileType | null;
}

export const Factory: React.FC<FactoryProps> = ({
  factory,
  isSelected,
  onSelect,
  onTileSelect,
  selectedTile,
}) => {
  const isEmpty = factory.tiles.length === 0;

  return (
    <motion.div
      layout
      className={`
        relative p-4 rounded-2xl factory-shadow
        ${isSelected 
          ? 'bg-slate-700/80 ring-2 ring-amber-500' 
          : 'bg-slate-800/60'
        }
        ${isEmpty ? 'opacity-50' : 'cursor-pointer'}
        transition-all duration-300
        border border-slate-700/50
        hover:border-slate-600/50
      `}
      onClick={!isEmpty ? onSelect : undefined}
      whileHover={!isEmpty ? { scale: 1.02 } : {}}
    >
      <div className="absolute -top-3 -left-3 w-8 h-8 bg-slate-900 rounded-full border border-slate-700 flex items-center justify-center text-sm font-bold text-slate-400">
        {factory.id}
      </div>
      
      <div className="grid grid-cols-2 gap-2 mt-2">
        {factory.tiles.map((tile: TileType, index: number) => (
          <motion.div
            key={`${factory.id}-${tile}-${index}`}
            initial={{ scale: 0, rotate: -180 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ delay: index * 0.1, type: 'spring' }}
          >
            <Tile
              tile={tile}
              onClick={() => onTileSelect(tile)}
              isSelected={isSelected && selectedTile === tile}
              size="md"
            />
          </motion.div>
        ))}
        
        {isEmpty && (
          <div className="col-span-2 text-center text-slate-600 py-4 text-sm">
            Пусто
          </div>
        )}
      </div>
    </motion.div>
  );
};
