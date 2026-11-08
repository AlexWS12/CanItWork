import '@fontsource-variable/space-grotesk';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import { Suspense, lazy, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import * as actions from './actions';
import { fetchStatus, openSharedRun } from './actions';
import { devTools } from './dev';
import { initAuth, useAuth } from './auth';
import { runner } from './runner';
import { useStore } from './store';
import './styles.css';
import { LockedRunNotice, MySystems } from './ui/Account';
import { ApiKeys } from './ui/ApiKeys';
import { ChatPanel } from './ui/ChatPanel';
import { FloorTools } from './domains/warehouse/FloorTools';
import { Inspector } from './ui/Inspector';
import { Landing } from './ui/Landing';
import { MobileNav } from './ui/MobileNav';
import { RecoveryCard } from './ui/RecoveryCard';
import { RightPanel } from './ui/RightPanel';
import { TopBar } from './ui/TopBar';
import { Transport } from './ui/Transport';

// The 3D scene (three.js and every domain's view) loads after the first paint, so the landing page shows at once;
// it starts downloading as soon as the browser is idle, so it is ready by the time a build finishes.
const loadScene = () => import('./scene/Scene');
const Scene = lazy(() => loadScene().then((m) => ({ default: m.Scene })));
if (typeof window !== 'undefined') ('requestIdleCallback' in window ? window.requestIdleCallback : setTimeout)(() => void loadScene());

// A handle for poking at the live run from the browser console during development.
if (import.meta.env.DEV) Object.assign(window, { __tv: { runner, store: useStore, actions, auth: useAuth, ...devTools } });

function App() {
  const environment = useStore((s) => s.environment);
  // The build screen stays up until the Red Team's claims are tested
  const building = useStore((s) => s.building);
  const view = useStore((s) => s.view);
  // The landing's live hero runs a showcase design behind the page; the workspace is for the user's own system
  const showcase = useStore((s) => s.showcase);
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
      <Suspense fallback={null}>
        <Scene />
      </Suspense>
      <TopBar />
      {environment && !building && !showcase ? (
        <>
          <MobileNav />
          <ChatPanel />
          <RightPanel />
          {/* Before the Inspector, so the Inspector stacks over it where they meet */}
          <FloorTools />
          <Inspector />
          <RecoveryCard />
          <Transport />
        </>
      ) : (
        <Landing />
      )}
      <MySystems />
      <ApiKeys />
      <LockedRunNotice />
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
