import { GameBoard } from './components/GameBoard'
import { GameControls } from './components/GameControls'
import { useGameStore } from './store/gameStore'

function App() {
  const resetGame = useGameStore((state) => state.resetGame)

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      <header className="py-6 px-8 border-b border-slate-700/50">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-white font-['Playfair_Display'] tracking-wide">
              Azul
            </h1>
            <p className="text-slate-400 text-sm mt-1">Бумажная версия</p>
          </div>
          <button
            onClick={resetGame}
            className="px-6 py-2.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg font-medium transition-colors shadow-lg"
          >
            Новая игра
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-8">
        <GameBoard />
        <GameControls />
      </main>

      <footer className="py-6 text-center text-slate-500 text-sm">
        <p>Играйте на бумаге, используйте это приложение как помощник</p>
      </footer>
    </div>
  )
}

export default App
