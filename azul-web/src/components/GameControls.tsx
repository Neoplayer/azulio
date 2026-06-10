import React from 'react';
import { motion } from 'framer-motion';
import { useGameStore } from '../store/gameStore';

export const GameControls: React.FC = () => {
  const { newRound, bag, factories, center } = useGameStore();

  const remainingTiles = bag.length;
  const hasActiveFactories = factories.some(f => f.tiles.length > 0);
  const hasCenterTiles = center.length > 0;
  const roundComplete = !hasActiveFactories && !hasCenterTiles;

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="mt-8 p-6 rounded-2xl bg-slate-800/40 border border-slate-700/30"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-6">
          <div className="text-center">
            <p className="text-2xl font-bold text-amber-500">{remainingTiles}</p>
            <p className="text-xs text-slate-500 uppercase tracking-wider">В мешке</p>
          </div>
          
          <div className="h-8 w-px bg-slate-700"></div>
          
          <div className="text-center">
            <p className="text-2xl font-bold text-blue-500">
              {factories.filter(f => f.tiles.length > 0).length}
            </p>
            <p className="text-xs text-slate-500 uppercase tracking-wider">Активных витрин</p>
          </div>
          
          <div className="h-8 w-px bg-slate-700"></div>
          
          <div className="text-center">
            <p className="text-2xl font-bold text-emerald-500">{center.length}</p>
            <p className="text-xs text-slate-500 uppercase tracking-wider">В центре</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {roundComplete && (
            <motion.p 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-emerald-400 text-sm font-medium"
            >
              Раунд завершён!
            </motion.p>
          )}
          
          <button
            onClick={newRound}
            disabled={hasActiveFactories}
            className={`
              px-6 py-3 rounded-xl font-semibold transition-all
              ${hasActiveFactories 
                ? 'bg-slate-700 text-slate-500 cursor-not-allowed' 
                : 'bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-500 hover:to-blue-600 text-white shadow-lg hover:shadow-blue-500/25'
              }
            `}
          >
            {roundComplete ? 'Начать новый раунд' : 'Новый раунд'}
          </button>
        </div>
      </div>
      
      {hasActiveFactories && (
        <p className="mt-3 text-sm text-slate-500">
          Разберите все витрины и центр перед началом нового раунда
        </p>
      )}
    </motion.div>
  );
};
