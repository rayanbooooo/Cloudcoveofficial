import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Api, setCsrf, setUnauthorizedHandler } from './lib/api';
import { realtime } from './lib/realtime';
import { useStore } from './store/store';
import './styles.css';

async function boot(): Promise<void> {
  setUnauthorizedHandler(() => {
    realtime.stop();
    setCsrf(null);
    useStore.setState({ ready: false, session: { authenticated: false, username: null, hasUsers: true } });
  });
  try {
    const s = await Api.session();
    setCsrf(s.csrfToken);
    useStore.getState().setSession({ authenticated: s.authenticated, username: s.username, hasUsers: s.hasUsers !== false });
    if (s.authenticated) realtime.start();
  } catch {
    useStore.getState().setSession({ authenticated: false, username: null, hasUsers: true });
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
void boot();
