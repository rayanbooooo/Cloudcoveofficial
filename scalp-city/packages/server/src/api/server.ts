import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { App } from '../system/App.js';
import { HttpError, loadSession, sendError } from './http.js';
import { registerRoutes } from './routes.js';
import { WsGateway } from './ws.js';

export interface ServerHandle {
  fastify: FastifyInstance;
  gateway: WsGateway;
}

function originAllowed(app: App, origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return false;
  if (app.config.allowedOrigins.includes(origin)) return true;
  try {
    // Same-origin (production: the server serves the UI itself).
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function buildServer(app: App, opts: { webDist?: string | null } = {}): Promise<ServerHandle> {
  const production = app.config.nodeEnv === 'production';
  const fastify = Fastify({
    // Per-request logs are noise for a trading server; HTTP logs only warnings and errors.
    loggerInstance: app.logger.child({ component: 'http' }, { level: 'warn' }) as unknown as FastifyBaseLogger,
    trustProxy: production,
    bodyLimit: 64 * 1024,
  });

  await fastify.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await fastify.register(cookie);
  await fastify.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  await fastify.register(websocket, { options: { maxPayload: 16 * 1024 } });

  fastify.decorateRequest('session', null);
  fastify.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/ws')) req.session = await loadSession(app, req);
  });
  fastify.setErrorHandler((err, _req, reply) => {
    if (!(err instanceof HttpError)) app.logger.error({ err }, 'request failed');
    return sendError(reply, err, production);
  });

  const gateway = new WsGateway(app);
  gateway.start();
  fastify.get(
    '/ws',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        if (!originAllowed(app, req.headers.origin, req.headers.host)) {
          await reply.code(403).send({ error: 'FORBIDDEN_ORIGIN', message: 'origin not allowed' });
          return;
        }
        if (!req.session) {
          await reply.code(401).send({ error: 'UNAUTHENTICATED', message: 'sign in required' });
        }
      },
    },
    (socket, req) => {
      gateway.handle(socket, req.session!);
    },
  );

  registerRoutes(fastify, app);

  const dist = opts.webDist ?? null;
  if (dist && fs.existsSync(path.join(dist, 'index.html'))) {
    await fastify.register(fastifyStatic, { root: dist, prefix: '/', index: ['index.html'], maxAge: production ? '1h' : 0 });
    fastify.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws')) return reply.code(404).send({ error: 'NOT_FOUND', message: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  fastify.addHook('onClose', async () => gateway.stop());
  return { fastify, gateway };
}
