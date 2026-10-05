import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Api, isUnavailable, setCsrf, setUnauthorizedHandler } from './lib/api';
import { realtime } from './lib/realtime';
import { useStore } from './store/store';
import './styles.css';

async function boot(): Promise<void> {
  setUnauthorizedHandler(() => {
    realtime.stop();
    setCsrf(null);
    useStore.setState({ ready: false, session: { authenticated: false, username: null, hasUsers: true } });
  });
  // While the server is starting (a deploy restarts it for a minute or two) keep asking, instead of
  // showing a sign-in form that cannot work yet.
  for (;;) {
    try {
      const s = await Api.session();
      setCsrf(s.csrfToken);
      useStore.getState().setBootNote(null);
      useStore.getState().setSession({ authenticated: s.authenticated, username: s.username, hasUsers: s.hasUsers !== false });
      if (s.authenticated) realtime.start();
      return;
    } catch (err) {
      if (!isUnavailable(err)) {
        useStore.getState().setSession({ authenticated: false, username: null, hasUsers: true });
        return;
      }
      useStore.getState().setBootNote('The server is starting up. This page reconnects by itself…');
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
void boot();
