import { useEffect, useState } from 'react';
import { cx } from '../components/ui';
import { DESKTOP_PANELS, DRAWER_WIDTHS, WORKER_DESK_WIDTH } from '../lib/layout';
import { useStore } from '../store/store';
import { actors, findActor, kmh, type ActorKind } from './actors';
import { useCityUi, type CityOptions } from './cityUi';

/** Where the middle of the area the panels leave free is, as a CSS `left`. */
function freeCentre(rightCover: number): string {
  return `calc(${DESKTOP_PANELS.left}px + (100% - ${DESKTOP_PANELS.left + rightCover}px) / 2)`;
}

const RIDES: { label: string; kind: ActorKind; name?: string; needs: keyof CityOptions }[] = [
  { label: 'TAXI', kind: 'vehicle', name: 'TAXI', needs: 'traffic' },
  { label: 'BUS', kind: 'vehicle', name: 'BUS', needs: 'traffic' },
  { label: 'DRONE', kind: 'drone', needs: 'sky' },
  { label: 'BLIMP', kind: 'blimp', needs: 'sky' },
];

const chip = 'focus-ring label-strong border border-line-2 bg-ink-950/80 px-1 py-[3px] text-[8.5px] text-fg-2 backdrop-blur-[2px] hover:text-fg disabled:opacity-40 disabled:hover:text-fg-2 md:px-1.5 md:text-[9px]';

function RideBadge({ id }: { id: string }) {
  const stop = useCityUi((s) => s.stopRide);
  const ticker = useCityUi((s) => s.ticker);
  const setTicker = useCityUi((s) => s.setTicker);
  const selectWorker = useStore((s) => s.selectWorker);
  const [info, setInfo] = useState(() => describe(id));
  useEffect(() => {
    const t = window.setInterval(() => setInfo(describe(id)), 250);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stop();
    };
    window.addEventListener('keydown', key);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('keydown', key);
    };
  }, [id, stop]);
  return (
    <>
      <span className="label-strong flex items-center gap-1.5 border border-line-2 bg-ink-950/85 px-2 py-[3px] text-[9.5px] text-fg backdrop-blur-[2px]">
        <span className="pulse h-1.5 w-1.5 rounded-full bg-signal" />
        RIDING · {info.name}
        {info.speed !== null && <span className="num text-fg-2">{info.speed} km/h</span>}
      </span>
      <span className="label hidden text-[9px] md:inline">Drag to look around · scroll to zoom</span>
      {info.workerId && (
        <button type="button" className={chip} onClick={() => selectWorker(info.workerId!)} aria-label="Open this worker's desk">
          OPEN WORKER
        </button>
      )}
      {id === 'blimp' && (
        <button type="button" className={chip} onClick={() => setTicker(ticker === 'quotes' ? 'pnl' : 'quotes')} aria-label="Switch what the ticker shows">
          TICKER · {ticker === 'quotes' ? 'QUOTES' : 'ACCOUNT'}
        </button>
      )}
      <button type="button" onClick={stop} className={chip} aria-label="Stop riding">
        EXIT · ESC
      </button>
    </>
  );
}

function describe(id: string): { name: string; speed: number | null; workerId: string | null } {
  const a = actors.get(id);
  if (!a) return { name: '…', speed: null, workerId: null };
  return { name: a.tag ? `${a.name} (${a.tag.text})` : a.name, speed: a.kind === 'vehicle' ? kmh(a.speed) : null, workerId: a.tag?.workerId ?? null };
}

/**
 * The city's own controls: pick something to ride along with (or click it in the city), and switch the
 * traffic and the sky on or off. Pure viewing preferences: none of it touches trading.
 */
export function CityHud({ lowPower }: { lowPower: boolean }) {
  const ride = useCityUi((s) => s.ride);
  const cuts = useCityUi((s) => s.cuts);
  const options = useCityUi((s) => s.options);
  const setOption = useCityUi((s) => s.setOption);
  const startRide = useCityUi((s) => s.startRide);
  const rightCover = useStore((s) => (s.ui.selectedWorker ? WORKER_DESK_WIDTH : s.ui.drawer ? DRAWER_WIDTHS[s.ui.drawer] : DESKTOP_PANELS.right));
  const wide = !lowPower;

  const go = (kind: ActorKind, name?: string) => {
    const a = findActor(kind, name);
    if (a) startRide(a.id);
  };
  return (
    <>
      <div
        className={cx('pointer-events-none absolute top-1 z-10 flex items-center gap-1.5', wide ? '-translate-x-1/2 whitespace-nowrap' : 'left-1.5 right-1.5 flex-wrap')}
        style={wide ? { left: freeCentre(rightCover) } : undefined}
      >
        <div className="pointer-events-auto flex flex-wrap items-center gap-1.5">
          {ride ? (
            <RideBadge id={ride} />
          ) : (
            <>
              <span className="label hidden text-[9px] md:inline">Ride</span>
              {RIDES.map((r) => (
                <button key={r.label} type="button" className={chip} disabled={!options[r.needs]} onClick={() => go(r.kind, r.name)} aria-label={`Ride along with a ${r.label.toLowerCase()}`}>
                  {r.label}
                </button>
              ))}
              <span className="mx-0.5 hidden h-3 w-px bg-line-2 md:inline-block" />
              {(['traffic', 'sky'] as const).map((k) => (
                <button key={k} type="button" className={chip} onClick={() => setOption(k, !options[k])} aria-pressed={options[k]}>
                  <span className={cx('mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle', options[k] ? 'bg-signal' : 'bg-fg-3')} />
                  {k === 'traffic' ? (
                    <>
                      <span className="md:hidden">CARS</span>
                      <span className="hidden md:inline">TRAFFIC</span>
                    </>
                  ) : (
                    'SKY'
                  )}
                </button>
              ))}
            </>
          )}
        </div>
      </div>
      {cuts > 0 && <div key={cuts} className="ride-cut pointer-events-none absolute inset-0 z-10" />}
    </>
  );
}
