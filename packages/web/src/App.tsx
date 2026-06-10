import { useEffect } from 'react';
import { useStore } from './store';
import { LoginScreen, LobbyScreen, RoomScreen, ResultsScreen } from './screens/Screens';
import { GameScreen } from './ui/game/GameScreen';

export default function App() {
  const screen = useStore((s) => s.screen);
  const toast = useStore((s) => s.toast);
  const connection = useStore((s) => s.connection);
  const session = useStore((s) => s.session);
  const tryRestore = useStore((s) => s.tryRestore);

  // Auto-reconnect from a stored guest token on first load.
  useEffect(() => {
    tryRestore();
  }, [tryRestore]);

  const disconnected = session != null && connection === 'closed';

  return (
    <>
      {disconnected && <div className="az-conn">Переподключение…</div>}
      {screen === 'login' && <LoginScreen />}
      {screen === 'lobby' && <LobbyScreen />}
      {screen === 'room' && <RoomScreen />}
      {screen === 'game' && <GameScreen />}
      {screen === 'results' && <ResultsScreen />}
      {toast && <div className="az-toast">{toast}</div>}
    </>
  );
}
