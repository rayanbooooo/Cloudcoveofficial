import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { money, pnlClass, UNAVAILABLE } from '../lib/format';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function Panel({
  title,
  meta,
  children,
  className,
  accent,
  bodyClassName,
}: {
  title?: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
  accent?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cx('panel relative', className)}>
      {accent && <div className="absolute inset-x-0 top-0 h-px" style={{ background: accent }} />}
      {title !== undefined && (
        <header className="panel-head">
          <div className="label">{title}</div>
          {meta !== undefined && <div className="label !text-fg-2">{meta}</div>}
        </header>
      )}
      <div className={bodyClassName ?? 'p-2.5'}>{children}</div>
    </section>
  );
}

export function Stat({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx('flex flex-col gap-0.5 min-w-0', className)}>
      <div className="label">{label}</div>
      <div className="num text-fg truncate">{children}</div>
    </div>
  );
}

export function Money({ value, sign, className }: { value: number | null | undefined; sign?: boolean; className?: string }) {
  if (value === null || value === undefined) return <span className={cx('label !text-fg-3', className)}>{UNAVAILABLE}</span>;
  return <span className={cx('num', sign ? pnlClass(value) : '', className)}>{money(value, { sign })}</span>;
}

export function Dot({ status, pulse }: { status: 'ok' | 'warn' | 'error' | 'off' | 'live' | 'signal'; pulse?: boolean }) {
  const color = {
    ok: 'bg-call',
    warn: 'bg-pending',
    error: 'bg-put',
    off: 'bg-fg-3',
    live: 'bg-live',
    signal: 'bg-signal',
  }[status];
  return <span className={cx('inline-block h-1.5 w-1.5 shrink-0 rounded-full', color, pulse && 'pulse')} />;
}

type Variant = 'ghost' | 'solid' | 'danger' | 'warn' | 'call' | 'outline';

export function Btn({ variant = 'ghost', className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const styles: Record<Variant, string> = {
    ghost: 'text-fg-2 hover:text-fg hover:bg-ink-700 border border-transparent',
    outline: 'text-fg border border-line-2 hover:border-fg-3 hover:bg-ink-700',
    solid: 'bg-fg text-ink-950 hover:bg-white border border-fg',
    danger: 'bg-live text-white hover:bg-[#ff5248] border border-[#ff6b63]',
    warn: 'text-pending border border-pending/50 hover:bg-pending/10',
    call: 'text-call border border-call/50 hover:bg-call/10',
  };
  return (
    <button
      {...rest}
      className={cx(
        'focus-ring inline-flex h-7 items-center justify-center gap-1.5 rounded-[2px] px-2.5 label-strong text-[10.5px] transition-colors disabled:opacity-40',
        styles[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cx('focus-ring relative h-4 w-7 shrink-0 rounded-[2px] border transition-colors disabled:opacity-40', on ? 'border-call/70 bg-call/20' : 'border-line-2 bg-ink-800')}
    >
      <span className={cx('absolute top-[2px] h-2.5 w-2.5 rounded-[1px] transition-all', on ? 'left-[13px] bg-call' : 'left-[2px] bg-fg-3')} />
    </button>
  );
}

export function Modal({
  open,
  onClose,
  title,
  danger,
  children,
  width = 460,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  danger?: boolean;
  children: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 flex items-center justify-center p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-ink-950/80 backdrop-blur-[2px]" onClick={onClose} />
          <motion.div
            role="dialog"
            aria-modal="true"
            className={cx('relative w-full max-h-[90vh] overflow-y-auto border bg-ink-900', danger ? 'border-live/70' : 'border-line-2')}
            style={{ maxWidth: width }}
            initial={{ y: 12, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 8, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
          >
            {danger && <div className="badge-live h-1.5" />}
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div className={cx('display text-[15px]', danger ? 'text-live' : 'text-fg')}>{title}</div>
              <button onClick={onClose} className="label hover:!text-fg" aria-label="Close">
                ESC
              </button>
            </div>
            <div className="p-4">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Drawer({ open, onClose, title, children, width = 560 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          className="fixed bottom-0 right-0 top-[calc(var(--bar-h)+var(--status-h))] z-40 flex flex-col border-l border-line-2 bg-ink-900 shadow-[-24px_0_48px_-24px_rgba(0,0,0,0.9)]"
          style={{ width: `min(${width}px, 100vw)` }}
          initial={{ x: 40, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 40, opacity: 0 }}
          transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <div className="display text-[14px] tracking-wider">{title}</div>
            <button onClick={onClose} className="label hover:!text-fg" aria-label="Close panel">
              CLOSE ✕
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">{children}</div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

export function Row({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx('flex items-baseline justify-between gap-3 border-b border-line/60 py-1.5 last:border-b-0', className)}>
      <span className="label">{label}</span>
      <span className="num text-right text-fg">{children}</span>
    </div>
  );
}

export function Check({ ok, label, detail }: { ok: boolean; label: ReactNode; detail?: ReactNode }) {
  return (
    <div className="flex items-start gap-2 py-[3px]">
      <span className={cx('num mt-[1px] w-3 shrink-0 text-[11px]', ok ? 'text-call' : 'text-put')}>{ok ? '✓' : '✕'}</span>
      <div className="min-w-0 flex-1">
        <div className={cx('label-strong text-[10.5px]', ok ? 'text-fg' : 'text-put')}>{label}</div>
        {detail && <div className="num truncate text-[10.5px] text-fg-3">{detail}</div>}
      </div>
    </div>
  );
}

/** Segmented charge bar. `ghost` (optional) is a forming-bar preview drawn faintly behind the confirmed value. */
export function ChargeBar({ value, color, ghost }: { value: number; color: string; ghost?: number }) {
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  return (
    <div className="charge-track" style={{ color }}>
      {ghost !== undefined && ghost > value && <div className="charge-fill opacity-30" style={{ width: `${clamp(ghost)}%` }} />}
      <div className="charge-fill" style={{ width: `${clamp(value)}%` }} />
    </div>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <div className="mt-2 border-l-2 border-put bg-put/5 px-2 py-1.5 text-[12px] text-put">{children}</div>;
}

export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

export const inputCls =
  'focus-ring h-8 w-full rounded-[2px] border border-line-2 bg-ink-850 px-2 num text-[12.5px] text-fg placeholder:text-fg-3 hover:border-fg-3';
