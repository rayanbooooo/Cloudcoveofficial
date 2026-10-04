import { ConfigError, loadEnvFile, parseConfig } from '../config/env.js';
import { PgDb } from '../db/db.js';
import { migrate } from '../db/migrations.js';
import { WorkerRepository } from '../workers/WorkerRepository.js';

async function main(): Promise<void> {
  loadEnvFile();
  const config = parseConfig(process.env);
  const db = new PgDb(config.databaseUrl);
  try {
    const n = await migrate(db, (m) => console.log(`• ${m}`));
    await new WorkerRepository(db).seed();
    console.log(n ? `✔ applied ${n} migration(s)` : '✔ database already up to date');
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? `✖ ${err.message}` : err);
  process.exit(1);
});
