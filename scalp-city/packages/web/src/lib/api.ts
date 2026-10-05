import type {
  ChartResponse,
  JournalTradeView,
  ManualOrderRequest,
  OrderPreview,
  OrderView,
  ReadinessView,
  RiskLimits,
  RiskLimitsChangePreview,
  Snapshot,
  SystemView,
  Timeframe,
  WorkerUpdateRequest,
  WorkerView,
} from '@scalp-city/shared';

export interface SessionResponse {
  authenticated: boolean;
  username: string | null;
  csrfToken: string | null;
  hasUsers?: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;
export function setCsrf(token: string | null): void {
  csrfToken = token;
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

/** The server (or its host) is not answering with data: starting up, restarting, or the wrong address. */
export function isUnavailable(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 'UNAVAILABLE' || err.code === 'UNREACHABLE' || err.code === 'STARTING');
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'UNREACHABLE', 'Cannot reach the server. Check your connection and try again.');
  }
  const text = await res.text();
  let data: { error?: string; message?: string } | null = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // A web page where data was expected: the server's "starting up" page while the previous instance
      // finishes after a deploy, the host's error page, or an address that is not the Scalp City server.
      const restarting = res.status === 502 || res.status === 503 || res.status === 504;
      throw new ApiError(
        res.status,
        'UNAVAILABLE',
        restarting ? 'The server is starting up or restarting. Wait a minute and try again.' : `The server answered with a web page instead of data (HTTP ${res.status}). It may still be starting up, or this is not the Scalp City server address.`,
      );
    }
  }
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/auth/login') onUnauthorized?.();
    throw new ApiError(res.status, data?.error ?? 'ERROR', data?.message ?? `HTTP ${res.status}`);
  }
  return data as T;
}

export const Api = {
  session: () => call<SessionResponse>('GET', '/api/session'),
  login: (username: string, password: string) => call<SessionResponse>('POST', '/api/auth/login', { username, password }),
  /** First run only: create the owner account with the setup code from the server log. */
  setup: (setupCode: string, username: string, password: string) => call<SessionResponse>('POST', '/api/auth/setup', { setupCode, username, password }),
  logout: () => call<{ ok: true }>('POST', '/api/auth/logout', {}),
  snapshot: () => call<Snapshot>('GET', '/api/snapshot'),
  readiness: () => call<ReadinessView>('GET', '/api/readiness'),

  enableLive: (body: { password: string; confirmAccount: string; acknowledgeRealMoney: boolean; secondConfirmation: boolean }) =>
    call<SystemView>('POST', '/api/live/enable', body),
  disarmLive: () => call<SystemView>('POST', '/api/live/disarm', {}),
  switchEnv: (target: 'paper' | 'live', password: string) => call<SystemView>('POST', '/api/env/switch', { target, password, confirmed: true }),

  setAutotrading: (enabled: boolean, confirmed?: boolean) => call<SystemView>('POST', '/api/controls/autotrading', { enabled, confirmed }),
  setPaused: (paused: boolean) => call<SystemView>('POST', '/api/controls/pause', { paused }),
  killSwitch: (reason: string) => call<{ system: SystemView; canceled: number; failed: string[] }>('POST', '/api/controls/kill-switch', { reason }),
  releaseKillSwitch: () => call<SystemView>('POST', '/api/controls/kill-switch/release', { confirmed: true }),
  flatten: () => call<{ started: boolean }>('POST', '/api/controls/flatten', { confirmed: true }),

  setWorkerEnabled: (id: string, enabled: boolean, confirmed?: boolean) => call<WorkerView>('POST', `/api/workers/${encodeURIComponent(id)}/enabled`, { enabled, confirmed }),
  updateWorker: (id: string, patch: WorkerUpdateRequest) => call<WorkerView>('PATCH', `/api/workers/${encodeURIComponent(id)}`, patch),

  riskLimits: () => call<{ limits: RiskLimits }>('GET', '/api/risk/limits'),
  previewRiskLimits: (limits: Partial<RiskLimits>) => call<RiskLimitsChangePreview>('POST', '/api/risk/limits/preview', { limits }),
  updateRiskLimits: (limits: Partial<RiskLimits>, confirmed?: boolean, password?: string) => call<{ limits: RiskLimits }>('PUT', '/api/risk/limits', { limits, confirmed, password }),

  previewOrder: (req: ManualOrderRequest) => call<OrderPreview>('POST', '/api/orders/preview', req),
  submitOrder: (previewToken: string) => call<OrderView>('POST', '/api/orders', { previewToken, confirmed: true }),
  cancelOrder: (id: string) => call<{ message: string; order: OrderView }>('POST', `/api/orders/${encodeURIComponent(id)}/cancel`, {}),
  orders: (limit = 200) => call<OrderView[]>('GET', `/api/orders?limit=${limit}`),
  orderEvents: (id: string) => call<{ event: string; toState: string; fillQty: number | null; fillPrice: number | null; occurredAt: number }[]>('GET', `/api/orders/${encodeURIComponent(id)}/events`),

  resetBreaker: (id: string) => call<SystemView>('POST', `/api/breakers/${encodeURIComponent(id)}/reset`, { confirmed: true }),
  reconcileRun: () => call<unknown>('POST', '/api/reconciliation/run', {}),
  reconcileAccept: () => call<unknown>('POST', '/api/reconciliation/accept', { confirmed: true }),

  chart: (symbol: string, tf: Timeframe, date?: string) => call<ChartResponse>('GET', `/api/chart?symbol=${encodeURIComponent(symbol)}&tf=${tf}${date ? `&date=${date}` : ''}`),
  journal: (worker?: string) => call<JournalTradeView[]>('GET', `/api/journal?limit=200${worker ? `&worker=${encodeURIComponent(worker)}` : ''}`),
  journalTrade: (id: string) =>
    call<{ trade: JournalTradeView; events: { kind: string; orderId: string | null; qty: number | null; price: number | null; realizedPnl: number | null; at: number | null }[] }>(
      'GET',
      `/api/journal/${encodeURIComponent(id)}`,
    ),
  audit: (beforeId?: number) =>
    call<{ id: number; occurredAt: number; actor: string; action: string; env: string | null; workerId: string | null; symbol: string | null; clientOrderId: string | null; details: Record<string, unknown>; hash: string }[]>(
      'GET',
      `/api/audit?limit=200${beforeId ? `&beforeId=${beforeId}` : ''}`,
    ),
  auditVerify: () => call<{ ok: boolean; checked: number; brokenAtId: number | null }>('GET', '/api/audit/verify'),
  optionContracts: (underlying: string, type: 'call' | 'put', expiration?: string) =>
    call<{ symbol: string; expiration: string; strike: number; type: string; tradable: boolean; openInterest: number | null }[]>(
      'GET',
      `/api/options/contracts?underlying=${underlying}&type=${type}${expiration ? `&expiration=${expiration}` : ''}`,
    ),
};
