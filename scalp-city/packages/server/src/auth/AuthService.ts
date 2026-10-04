import { createHmac, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { Clock } from '../core/clock.js';
import { iso, ms, type Db } from '../db/db.js';

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

/** scrypt$N$r$p$salt$hash (base64url). */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) throw new Error('password must be at least 12 characters');
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, 'base64url');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64url'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export interface SessionRecord {
  sessionId: string;
  userId: string;
  username: string;
  csrfToken: string;
  expiresAt: number;
}

export const SESSION_COOKIE = 'sc_session';
const SESSION_TTL_MS = 12 * 3_600_000;

// A real hash to spend time on when the username doesn't exist (no user enumeration by timing).
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$' + Buffer.alloc(64).toString('base64url');

/**
 * Single-tenant authentication. Session tokens live only in an HttpOnly
 * cookie; the database stores an HMAC of the token, so a database leak
 * does not yield usable sessions.
 */
export class AuthService {
  /** First-run setup code (in memory only); null once an account exists. */
  private setupCode: string | null = null;
  private setupQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly secret: string,
    private readonly clock: Clock,
  ) {}

  /**
   * First run: when no account exists, mint a one-time setup code that the
   * server prints to its own console. Creating the owner account from the
   * browser requires it, so whoever merely finds the URL cannot claim the
   * server. There is no public sign-up: once one account exists, setup is
   * closed for good (further accounts only via `npm run user:create`).
   */
  async prepareSetup(): Promise<string | null> {
    if ((await this.userCount()) > 0) {
      this.setupCode = null;
      return null;
    }
    // 10 symbols from a 32-letter unambiguous alphabet (50 bits); 256 % 32 = 0, so no modulo bias.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const raw = [...randomBytes(10)].map((b) => alphabet[b % 32]).join('');
    this.setupCode = `${raw.slice(0, 5)}-${raw.slice(5)}`;
    return this.setupCode;
  }

  get setupOpen(): boolean {
    return this.setupCode !== null;
  }

  /**
   * Create the owner account with the setup code. Serialized, so two
   * simultaneous requests can never both succeed; the code is single-use.
   */
  setupOwner(code: string, username: string, password: string): Promise<'ok' | 'closed' | 'bad_code'> {
    const run = this.setupQueue.then(async () => {
      if (this.setupCode === null || (await this.userCount()) > 0) {
        this.setupCode = null;
        return 'closed' as const;
      }
      const norm = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!safeEqual(norm(code), norm(this.setupCode))) return 'bad_code' as const;
      await this.createUser(username, password);
      this.setupCode = null;
      return 'ok' as const;
    });
    this.setupQueue = run.catch(() => undefined);
    return run;
  }

  private sessionKey(token: string): string {
    return createHmac('sha256', this.secret).update(token).digest('hex');
  }

  async userCount(): Promise<number> {
    const { rows } = await this.db.query<{ c: number }>('SELECT COUNT(*) AS c FROM users');
    return Number(rows[0]?.c ?? 0);
  }

  async createUser(username: string, password: string): Promise<string> {
    const u = username.trim().toLowerCase();
    if (!/^[a-z0-9_.-]{3,32}$/.test(u)) throw new Error('username must be 3–32 characters: a-z 0-9 _ . -');
    const id = randomUUID();
    await this.db.query('INSERT INTO users(id, username, password_hash) VALUES ($1,$2,$3)', [id, u, await hashPassword(password)]);
    this.setupCode = null; // an account exists: first-run setup is closed
    return id;
  }

  async setPassword(username: string, password: string): Promise<boolean> {
    const r = await this.db.query('UPDATE users SET password_hash = $2 WHERE username = $1', [username.trim().toLowerCase(), await hashPassword(password)]);
    if (r.rowCount > 0) await this.db.query('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username = $1)', [username.trim().toLowerCase()]);
    return r.rowCount > 0;
  }

  async login(username: string, password: string, meta: { ip: string | null; userAgent: string | null }): Promise<{ token: string; session: SessionRecord } | null> {
    const { rows } = await this.db.query<{ id: string; username: string; password_hash: string }>('SELECT id, username, password_hash FROM users WHERE username = $1', [
      username.trim().toLowerCase(),
    ]);
    const user = rows[0];
    const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) return null;
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const expiresAt = this.clock.now() + SESSION_TTL_MS;
    const sessionId = this.sessionKey(token);
    await this.db.query('INSERT INTO sessions(id, user_id, csrf_token, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6)', [
      sessionId,
      user.id,
      csrfToken,
      iso(expiresAt),
      meta.ip,
      meta.userAgent?.slice(0, 300) ?? null,
    ]);
    await this.db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    await this.db.query('DELETE FROM sessions WHERE expires_at < now()');
    return { token, session: { sessionId, userId: user.id, username: user.username, csrfToken, expiresAt } };
  }

  async session(token: string | undefined | null): Promise<SessionRecord | null> {
    if (!token || token.length < 20 || token.length > 200) return null;
    const sessionId = this.sessionKey(token);
    const { rows } = await this.db.query<{ user_id: string; username: string; csrf_token: string; expires_at: Date }>(
      `SELECT s.user_id, u.username, s.csrf_token, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
      [sessionId],
    );
    const r = rows[0];
    if (!r) return null;
    const expiresAt = ms(r.expires_at)!;
    if (expiresAt <= this.clock.now()) {
      await this.db.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
      return null;
    }
    return { sessionId, userId: r.user_id, username: r.username, csrfToken: r.csrf_token, expiresAt };
  }

  async logout(token: string | undefined | null): Promise<void> {
    if (!token) return;
    await this.db.query('DELETE FROM sessions WHERE id = $1', [this.sessionKey(token)]);
  }

  /** Step-up re-authentication for dangerous actions (enable LIVE, switch to LIVE, loosen live limits). */
  async verifyUserPassword(userId: string, password: string): Promise<boolean> {
    const { rows } = await this.db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [userId]);
    return verifyPassword(password, rows[0]?.password_hash ?? DUMMY_HASH);
  }
}
