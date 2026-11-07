import '@fontsource-variable/space-grotesk';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { fetchStatus } from './actions';
import { Scene } from './scene/Scene';
import { useStore } from './store';
import './styles.css';
import { ChatPanel, Inspector, Landing, RecoveryCard, RightPanel, StatusBar, Transport } from './ui/Panels';

function App() {
  const environment = useStore((s) => s.environment);
  useEffect(() => {
    void fetchStatus();
    const id = setInterval(fetchStatus, 15000);
    return () => clearInterval(id);
  }, []);
  return (
    <>
      <Scene />
      <StatusBar />
      {environment ? (
        <>
          <ChatPanel />
          <RightPanel />
          <Inspector />
          <RecoveryCard />
          <Transport />
        </>
      ) : (
        <Landing />
      )}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
