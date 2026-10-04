import readline from 'node:readline';
import { AuthService } from '../auth/AuthService.js';
import { ConfigError, loadEnvFile, parseConfig } from '../config/env.js';
import { systemClock } from '../core/clock.js';
import { PgDb } from '../db/db.js';
import { migrate } from '../db/migrations.js';

/** Prompt without echoing the typed characters. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s.startsWith(question)) write.call(rl, s);
      else write.call(rl, '');
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = parseConfig(process.env);
  const args = process.argv.slice(2);
  const idx = args.indexOf('--username');
  const username = idx >= 0 ? args[idx + 1] : undefined;
  const reset = args.includes('--reset-password');
  if (!username) {
    console.error('usage: npm run user:create -- --username <name> [--reset-password]');
    process.exit(2);
  }
  // Non-interactive use (e.g. provisioning): SCALP_PASSWORD; never pass passwords as CLI args.
  let password = process.env.SCALP_PASSWORD ?? '';
  if (!password) {
    password = await promptHidden('Password (min 12 chars): ');
    const again = await promptHidden('Repeat password: ');
    if (password !== again) {
      console.error('✖ passwords do not match');
      process.exit(1);
    }
  }
  const db = new PgDb(config.databaseUrl);
  try {
    await migrate(db);
    const auth = new AuthService(db, config.sessionSecret, systemClock);
    if (reset) {
      const ok = await auth.setPassword(username, password);
      console.log(ok ? `✔ password reset for ${username} (all sessions signed out)` : `✖ no user ${username}`);
    } else {
      await auth.createUser(username, password);
      console.log(`✔ user ${username.toLowerCase()} created`);
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? `✖ ${err.message}` : `✖ ${(err as Error).message}`);
  process.exit(1);
});
