import { lazy, Suspense, useEffect, useState } from 'react';
import { useStore } from './store/store';
import { Modals } from './components/Modals';
import { MarketPanel } from './components/panels/Market';
import { Scanner } from './components/panels/Scanner';
import { Timeline } from './components/panels/Timeline';
import { Vault } from './components/panels/Vault';
import { WorkersPanel } from './components/panels/Workers';
import { Dock, Drawers, Login, Toasts } from './components/Shell';
import { EnvBadge, SafetyControls, StatusLine, TopBar } from './components/TopBar';
import { WorkerDesk } from './components/WorkerDesk';
import { cx } from './components/ui';
import { RiskDrawerBody } from './components/drawers/Risk';
import { AccountDrawerBody, PositionsDrawerBody } from './components/drawers/Portfolio';

const CityScene = lazy(() => import('./city/CityScene'));

function useIsMobile(): boolean {
  const [m, setM] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
}

function Loading({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="label">{label}</div>
    </div>
  );
}

function DesktopLayout() {
  const live = useStore((s) => s.system?.env === 'live');
  return (
    <div className={cx('flex h-full flex-col', live && 'live-frame')}>
      <TopBar />
      <StatusLine />
      <main className="relative min-h-0 flex-1">
        <div className="absolute inset-0">
          <Suspense fallback={<Loading label="Loading city…" />}>
            <CityScene />
          </Suspense>
        </div>
        {/* Floating panels: the city stays the primary surface (spec §96). */}
        <div className="pointer-events-none absolute inset-0 grid grid-cols-[288px_minmax(0,1fr)_340px] grid-rows-[minmax(0,1fr)_auto] gap-3 p-3">
          <div className="pointer-events-auto flex min-h-0 flex-col gap-3 overflow-y-auto">
            <Vault />
            <MarketPanel />
          </div>
          <div />
          <div className="pointer-events-auto flex min-h-0 flex-col gap-3 overflow-y-auto">
            <WorkersPanel />
            <Scanner />
          </div>
          <div className="pointer-events-auto col-span-3 grid min-h-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
            <div className="max-h-[188px] min-h-0">
              <Timeline maxRows={60} />
            </div>
            <Dock />
          </div>
        </div>
      </main>
      <Drawers />
      <WorkerDesk />
      <Modals />
      <Toasts />
    </div>
  );
}

/** Mobile (spec §99): simplified 3D, but LIVE status and safety controls are never hidden. */
function MobileLayout() {
  const tab = useStore((s) => s.ui.mobileTab);
  const setTab = useStore((s) => s.setMobileTab);
  const live = useStore((s) => s.system?.env === 'live');
  return (
    <div className={cx('flex h-full flex-col', live && 'live-frame')}>
      <header className="flex h-[var(--bar-h)] shrink-0 items-center justify-between border-b border-line bg-ink-950 px-3">
        <span className="display text-[13px] tracking-[0.2em]">SCALP CITY</span>
        <EnvBadge compact />
      </header>
      <StatusLine />
      <main className="relative min-h-0 flex-1 overflow-y-auto">
        {tab === 'city' && (
          <div className="flex h-full flex-col">
            <div className="relative min-h-[240px] flex-1">
              <Suspense fallback={<Loading label="Loading city…" />}>
                <CityScene lowPower />
              </Suspense>
            </div>
            <div className="p-2">
              <Scanner />
            </div>
          </div>
        )}
        {tab === 'account' && (
          <div className="flex flex-col gap-2 p-2">
            <Vault />
            <AccountDrawerBody />
            <PositionsDrawerBody />
          </div>
        )}
        {tab === 'workers' && (
          <div className="flex flex-col gap-2 p-2">
            <WorkersPanel />
            <MarketPanel />
            <Timeline maxRows={40} />
          </div>
        )}
        {tab === 'risk' && <RiskDrawerBody />}
      </main>
      <div className="shrink-0 border-t border-line bg-ink-950 px-2 py-2">
        <SafetyControls vertical />
      </div>
      <nav className="grid shrink-0 grid-cols-4 border-t border-line bg-ink-950 pb-[env(safe-area-inset-bottom)]">
        {(['city', 'account', 'workers', 'risk'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={cx('label-strong py-3 text-[10.5px]', tab === t ? 'text-fg' : 'text-fg-3')}>
            {t}
          </button>
        ))}
      </nav>
      <Drawers />
      <WorkerDesk />
      <Modals />
      <Toasts />
    </div>
  );
}

export function App() {
  const session = useStore((s) => s.session);
  const ready = useStore((s) => s.ready);
  const mobile = useIsMobile();
  if (!session) return <Loading label="Connecting…" />;
  if (!session.authenticated) return <Login />;
  if (!ready) return <Loading label="Loading trading state…" />;
  return mobile ? <MobileLayout /> : <DesktopLayout />;
}
