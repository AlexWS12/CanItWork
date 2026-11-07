import '@fontsource-variable/space-grotesk';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { fetchStatus } from './actions';
import { Scene } from './scene/Scene';
import { useStore } from './store';
import './styles.css';
import { ChatPanel } from './ui/ChatPanel';
import { Inspector } from './ui/Inspector';
import { Landing } from './ui/Landing';
import { MobileNav } from './ui/MobileNav';
import { RecoveryCard } from './ui/RecoveryCard';
import { RightPanel } from './ui/RightPanel';
import { TopBar } from './ui/TopBar';
import { Transport } from './ui/Transport';

function App() {
  const environment = useStore((s) => s.environment);
  // The build screen stays up until the Red Team's claims are tested
  const building = useStore((s) => s.building);
  const view = useStore((s) => s.view);
  useEffect(() => {
    document.documentElement.dataset.view = view;
  }, [view]);
  useEffect(() => {
    void fetchStatus();
    const id = setInterval(fetchStatus, 15000);
    return () => clearInterval(id);
  }, []);
  return (
    <>
      <Scene />
      <TopBar />
      {environment && !building ? (
        <>
          <MobileNav />
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
