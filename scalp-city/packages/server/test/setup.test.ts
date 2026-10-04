import { describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth/AuthService.js';
import { ManualClock } from '../src/core/clock.js';
import { createPgliteDb } from './support/pglite.js';

const SECRET = 'test-session-secret-test-session-secret-0000';
const PASSWORD = 'correct-horse-battery';

async function fresh() {
  const db = await createPgliteDb();
  return { db, auth: new AuthService(db, SECRET, new ManualClock(Date.UTC(2026, 9, 5, 15))) };
}

describe('first-run owner setup (no public sign-up)', () => {
  it('mints a one-time code only while no account exists and accepts it exactly once', async () => {
    const { db, auth } = await fresh();
    const code = await auth.prepareSetup();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    expect(auth.setupOpen).toBe(true);

    expect(await auth.setupOwner('WRONG-CODE0', 'rayan', PASSWORD)).toBe('bad_code');
    expect(await auth.userCount()).toBe(0);

    // Case and separators are forgiving; the code itself is not.
    expect(await auth.setupOwner(code!.toLowerCase().replace('-', ' '), 'rayan', PASSWORD)).toBe('ok');
    expect(await auth.userCount()).toBe(1);
    expect(auth.setupOpen).toBe(false);

    // Single use, and closed for good once an account exists.
    expect(await auth.setupOwner(code!, 'intruder', PASSWORD)).toBe('closed');
    expect(await auth.prepareSetup()).toBeNull();
    expect(await auth.login('rayan', PASSWORD, { ip: null, userAgent: null })).not.toBeNull();
    await db.close();
  });

  it('lets only one of two simultaneous setup requests win', async () => {
    const { db, auth } = await fresh();
    const code = (await auth.prepareSetup())!;
    const results = await Promise.all([auth.setupOwner(code, 'first', PASSWORD), auth.setupOwner(code, 'second', PASSWORD)]);
    expect(results.sort()).toEqual(['closed', 'ok']);
    expect(await auth.userCount()).toBe(1);
    await db.close();
  });

  it('rejects a weak password without consuming the code', async () => {
    const { db, auth } = await fresh();
    const code = (await auth.prepareSetup())!;
    await expect(auth.setupOwner(code, 'rayan', 'short')).rejects.toThrow(/12 characters/);
    expect(auth.setupOpen).toBe(true);
    expect(await auth.setupOwner(code, 'rayan', PASSWORD)).toBe('ok');
    await db.close();
  });

  it('closes setup when an account is created any other way (CLI)', async () => {
    const { db, auth } = await fresh();
    const code = (await auth.prepareSetup())!;
    await auth.createUser('owner', PASSWORD);
    expect(auth.setupOpen).toBe(false);
    expect(await auth.setupOwner(code, 'intruder', PASSWORD)).toBe('closed');
    await db.close();
  });
});
