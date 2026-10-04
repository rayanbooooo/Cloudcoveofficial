import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { safeEqual, SESSION_COOKIE, type SessionRecord } from '../auth/AuthService.js';
import type { App } from '../system/App.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionRecord | null;
  }
}

/** Parse a body/query with zod; 400 on failure. */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new HttpError(400, 'BAD_REQUEST', r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  }
  return r.data;
}

/** Resolve the session from the cookie (does not enforce). */
export async function loadSession(app: App, req: FastifyRequest): Promise<SessionRecord | null> {
  const token = req.cookies?.[SESSION_COOKIE];
  return app.auth.session(token);
}

/** Require an authenticated session; for state-changing methods also a matching CSRF header. */
export function requireAuth(req: FastifyRequest): SessionRecord {
  const s = req.session;
  if (!s) throw new HttpError(401, 'UNAUTHENTICATED', 'sign in required');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const header = req.headers['x-csrf-token'];
    const token = Array.isArray(header) ? header[0] : header;
    if (!token || !safeEqual(token, s.csrfToken)) throw new HttpError(403, 'CSRF', 'missing or invalid CSRF token');
  }
  return s;
}

export function sendError(reply: FastifyReply, err: unknown, production: boolean): FastifyReply {
  if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message, details: err.details });
  const e = err as { statusCode?: number; message?: string; code?: string };
  if (e?.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.code ?? 'ERROR', message: e.message ?? 'request failed' });
  return reply.status(500).send({ error: 'INTERNAL', message: production ? 'internal error' : (e?.message ?? 'internal error') });
}
