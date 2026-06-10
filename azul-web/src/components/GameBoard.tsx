import React, { useEffect } from 'react';
import { motion } from 'framer-motion';
import { Factory } from './Factory';
import { Center } from './Center';
import { useGameStore } from '../store/gameStore';

export const GameBoard: React.FC = () => {
  const { 
    factories, 
    selectedFactory, 
    selectedTile,
    selectFactory, 
    selectTile,
    takeFromFactory,
    resetGame 
  } = useGameStore();

  useEffect(() => {
    resetGame();
  }, []);

  return (
    <div className="space-y-8">
      {/* Factories Grid */}
      <section>
        <h2 className="text-xl font-semibold text-slate-300 mb-4 flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-blue-500"></span>
          Витрины
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          {factories.map((factory, index) => (
            <motion.div
              key={factory.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1 }}
            >
              <Factory
                factory={factory}
                isSelected={selectedFactory === factory.id}
                onSelect={() => {
                  if (selectedFactory === factory.id) {
                    selectFactory(null);
                  } else {
                    selectFactory(factory.id);
                  }
                }}
                onTileSelect={(tile) => {
                  if (selectedFactory === factory.id && selectedTile === tile) {
                    takeFromFactory(factory.id, tile);
                  } else {
                    selectFactory(factory.id);
                    selectTile(tile);
                  }
                }}
                selectedTile={selectedTile}
              />
            </motion.div>
          ))}
        </div>
      </section>

      {/* Center Pool */}
      <section>
        <Center />
      </section>
    </div>
  );
};
