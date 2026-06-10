import React from 'react';
import { motion } from 'framer-motion';
import { TileType, TILE_COLORS } from '../types/game';

interface TileProps {
  tile: TileType;
  onClick?: () => void;
  isSelected?: boolean;
  isDisabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

export const Tile: React.FC<TileProps> = ({ 
  tile, 
  onClick, 
  isSelected = false, 
  isDisabled = false,
  size = 'md'
}) => {
  const colors = TILE_COLORS[tile];
  
  const sizeClasses = {
    sm: 'w-8 h-8 text-sm',
    md: 'w-12 h-12 text-lg',
    lg: 'w-16 h-16 text-xl',
  };

  return (
    <motion.div
      whileHover={!isDisabled ? { scale: 1.1, y: -2 } : {}}
      whileTap={!isDisabled ? { scale: 0.95 } : {}}
      animate={isSelected ? { 
        scale: 1.15, 
        boxShadow: `0 0 20px ${colors.hex}80`,
      } : {}}
      className={`
        ${sizeClasses[size]}
        ${colors.bg}
        ${colors.border}
        ${colors.text}
        border-2
        rounded-lg
        tile-shadow
        flex
        items-center
        justify-center
        font-bold
        cursor-${isDisabled ? 'not-allowed opacity-50' : 'pointer'}
        transition-all
        duration-200
      `}
      onClick={!isDisabled ? onClick : undefined}
    >
      {tile}
    </motion.div>
  );
};
