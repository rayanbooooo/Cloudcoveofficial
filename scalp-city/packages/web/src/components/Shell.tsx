import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Api, ApiError, setCsrf } from '../lib/api';
import { timeET } from '../lib/format';
import { DRAWER_WIDTHS } from '../lib/layout';
import { realtime } from '../lib/realtime';
import { useStore, type DrawerId } from '../store/store';
import { AccountDrawerBody, OrdersDrawerBody, PositionsDrawerBody } from './drawers/Portfolio';
import { RiskDrawerBody } from './drawers/Risk';
import { AuditDrawerBody, HealthDrawerBody, JournalDrawerBody, LiveDrawerBody } from './drawers/System';
import { SettingsDrawerBody, TradeDrawerBody } from './drawers/Trade';
import { Btn, cx, Drawer, ErrorText, Field, inputCls } from './ui';

function AuthFrame({ subtitle, children }: { subtitle: string; children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-ink-950 p-4">
      <div className="pointer-events-none absolute inset-0 opacity-[0.07]" style={{ backgroundImage: 'linear-gradient(rgba(140,160,190,.6) 1px, transparent 1px), linear-gradient(90deg, rgba(140,160,190,.6) 1px, transparent 1px)', backgroundSize: '48px 48px' }} />
      <div className="panel relative w-full max-w-[380px] p-6">
        <div className="display text-[20px] tracking-[0.24em]">SCALP CITY</div>
        <div className="label mt-1">{subtitle}</div>
        {children}
      </div>
    </div>
  );
}

/**
 * First run: no account exists yet. The owner creates it here with the
 * one-time setup code the server printed in its own log, which proves
 * control of the server. Once an account exists this screen never returns.
 */
function SetupForm() {
  const setSession = useStore((s) => s.setSession);
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = confirm.length > 0 && confirm !== password;
  const valid = code.trim().length >= 10 && /^[a-zA-Z0-9_.-]{3,32}$/.test(username.trim()) && password.length >= 12 && password === confirm;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await Api.setup(code, username, password);
      setCsrf(r.csrfToken);
      setSession({ authenticated: true, username: r.username, hasUsers: true });
      realtime.start();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setSession({ authenticated: false, username: null, hasUsers: true });
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame subtitle="First run · create your account">
      <p className="mt-4 text-[12px] leading-relaxed text-fg-2">
        Scalp City has a single owner and no public sign-up. To prove you control this server, enter the <span className="text-fg">setup code</span> printed in its log when it started.
      </p>
      <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
        <Field label="Setup code (from the server log)">
          <input className={cx(inputCls, 'uppercase tracking-[0.2em]')} value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXXX-XXXXX" autoComplete="one-time-code" autoFocus spellCheck={false} />
        </Field>
        <Field label="Username">
          <input className={inputCls} autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="3–32 letters, digits, . _ -" />
        </Field>
        <Field label="Password (12+ characters)">
          <input className={inputCls} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Confirm password">
          <input className={inputCls} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        {mismatch && <div className="text-[11.5px] text-pending">Passwords don&rsquo;t match.</div>}
        <ErrorText>{error}</ErrorText>
        <Btn variant="solid" type="submit" className="mt-1 !h-8" disabled={busy || !valid}>
          Create account
        </Btn>
      </form>
      <div className="mt-4 border-t border-line pt-3 text-[11px] text-fg-3">
        No access to the log? An account can also be created on the server: <span className="num text-fg-2">npm run user:create -- --username you</span>
      </div>
    </AuthFrame>
  );
}

export function Login() {
  const session = useStore((s) => s.session);
  const setSession = useStore((s) => s.setSession);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (session && !session.hasUsers) return <SetupForm />;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await Api.login(username, password);
      setCsrf(r.csrfToken);
      setSession({ authenticated: true, username: r.username, hasUsers: true });
      realtime.start();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame subtitle="Trading command center · sign in">
      <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
        <Field label="Username">
          <input className={inputCls} autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </Field>
        <Field label="Password">
          <input className={inputCls} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <Btn variant="solid" type="submit" className="mt-1 !h-8" disabled={busy || !username || !password}>
          Sign in
        </Btn>
      </form>
      <div className="mt-4 border-t border-line pt-3 text-[11px] text-fg-3">There is no public sign-up: this server already has its owner account. Sign in with it.</div>
    </AuthFrame>
  );
}

export function Toasts() {
  // Select the raw array (stable reference) and derive: a selector that builds
  // a new array on every call makes React re-render forever.
  const all = useStore((s) => s.toasts);
  const toasts = useMemo(() => all.filter((t) => !t.dismissed), [all]);
  const dismiss = useStore((s) => s.dismissToast);
  useEffect(() => {
    const timers = toasts.filter((t) => t.severity !== 'error').map((t) => window.setTimeout(() => dismiss(t.id), 8000));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [toasts, dismiss]);
  return (
    <div className="pointer-events-none fixed right-3 top-[calc(var(--bar-h)+34px)] z-[60] flex w-[320px] flex-col gap-2">
      <AnimatePresence>
        {toasts.slice(-4).map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            className={cx('panel pointer-events-auto border-l-2 px-3 py-2', t.severity === 'error' ? 'border-l-put' : t.severity === 'success' ? 'border-l-call' : t.severity === 'warn' ? 'border-l-pending' : 'border-l-signal')}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className={cx('label-strong text-[11px]', t.severity === 'error' ? 'text-put' : t.severity === 'success' ? 'text-call' : 'text-fg')}>{t.title}</span>
              <button className="label hover:!text-fg" onClick={() => dismiss(t.id)}>
                ✕
              </button>
            </div>
            <div className="mt-0.5 text-[12px] text-fg-2">{t.message}</div>
            <div className="num mt-0.5 text-[10px] text-fg-3">{timeET(t.ts)}</div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

const DRAWERS: { id: DrawerId; label: string; title: string; body: () => ReactNode }[] = [
  { id: 'account', label: 'Account', title: 'ACCOUNT', body: () => <AccountDrawerBody /> },
  { id: 'positions', label: 'Positions', title: 'POSITIONS', body: () => <PositionsDrawerBody /> },
  { id: 'orders', label: 'Orders', title: 'ORDERS', body: () => <OrdersDrawerBody /> },
  { id: 'risk', label: 'Risk', title: 'RISK', body: () => <RiskDrawerBody /> },
  { id: 'trade', label: 'Trade', title: 'MANUAL ORDER', body: () => <TradeDrawerBody /> },
  { id: 'journal', label: 'Journal', title: 'TRADE JOURNAL', body: () => <JournalDrawerBody /> },
  { id: 'health', label: 'Health', title: 'SYSTEM HEALTH', body: () => <HealthDrawerBody /> },
  { id: 'settings', label: 'Workers', title: 'WORKER CONFIGURATION', body: () => <SettingsDrawerBody /> },
  { id: 'audit', label: 'Audit', title: 'AUDIT LOG', body: () => <AuditDrawerBody /> },
  { id: 'live', label: 'Live', title: 'LIVE TRADING', body: () => <LiveDrawerBody /> },
];

export function Dock({ className }: { className?: string }) {
  const open = useStore((s) => s.ui.drawer);
  const openDrawer = useStore((s) => s.openDrawer);
  const positions = useStore((s) => s.positions.length);
  const working = useStore((s) => Object.values(s.orders).filter((o) => ['SUBMITTING', 'SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'CANCEL_PENDING'].includes(o.state)).length);
  const health = useStore((s) => s.system?.health.some((h) => h.status === 'error'));
  return (
    <nav className={cx('panel flex items-stretch overflow-x-auto', className)}>
      {DRAWERS.map((d) => {
        const badge = d.id === 'positions' ? positions : d.id === 'orders' ? working : 0;
        return (
          <button
            key={d.id}
            onClick={() => openDrawer(open === d.id ? null : d.id)}
            className={cx('focus-ring label-strong relative flex items-center gap-1.5 whitespace-nowrap border-r border-line px-3 py-2 text-[10.5px] last:border-r-0', open === d.id ? 'bg-ink-600 text-fg' : 'text-fg-2 hover:bg-ink-700 hover:text-fg')}
          >
            {d.label}
            {badge > 0 && <span className="num rounded-[1px] bg-ink-600 px-1 text-[10px] text-fg">{badge}</span>}
            {d.id === 'health' && health && <span className="h-1.5 w-1.5 rounded-full bg-put" />}
          </button>
        );
      })}
    </nav>
  );
}

export function Drawers() {
  const open = useStore((s) => s.ui.drawer);
  const openDrawer = useStore((s) => s.openDrawer);
  const d = DRAWERS.find((x) => x.id === open);
  return (
    <Drawer open={!!d} onClose={() => openDrawer(null)} title={d?.title ?? ''} width={d ? DRAWER_WIDTHS[d.id] : 560}>
      {d?.body()}
    </Drawer>
  );
}
