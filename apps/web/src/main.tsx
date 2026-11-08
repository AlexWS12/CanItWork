import '@fontsource-variable/space-grotesk';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import * as actions from './actions';
import { fetchStatus, openSharedRun } from './actions';
import { initAuth, useAuth } from './auth';
import { runner } from './runner';
import { Scene } from './scene/Scene';
import { useStore } from './store';
import './styles.css';
import { LockedRunNotice, MySystems } from './ui/Account';
import { ChatPanel } from './ui/ChatPanel';
import { Inspector } from './ui/Inspector';
import { Landing } from './ui/Landing';
import { MobileNav } from './ui/MobileNav';
import { RecoveryCard } from './ui/RecoveryCard';
import { RightPanel } from './ui/RightPanel';
import { TopBar } from './ui/TopBar';
import { Transport } from './ui/Transport';

// A handle for poking at the live run from the browser console during development.
if (import.meta.env.DEV) Object.assign(window, { __tv: { runner, store: useStore, actions, auth: useAuth } });

function App() {
  const environment = useStore((s) => s.environment);
  // The build screen stays up until the Red Team's claims are tested
  const building = useStore((s) => s.building);
  const view = useStore((s) => s.view);
  useEffect(() => {
    document.documentElement.dataset.view = view;
  }, [view]);
  // Sign-in finishes first, so a private saved run opens for its owner straight away.
  useEffect(() => {
    void initAuth().then(openSharedRun);
    // A share link pasted into an open tab only changes the hash, so open it then too. The app's own link updates don't fire this.
    const opened = () => void openSharedRun();
    window.addEventListener('hashchange', opened);
    return () => window.removeEventListener('hashchange', opened);
  }, []);
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
      <MySystems />
      <LockedRunNotice />
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
