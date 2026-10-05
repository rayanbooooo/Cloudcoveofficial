import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Never let a test pick up real credentials from the developer's shell.
    env: {
      ALPACA_API_KEY: '',
      ALPACA_API_SECRET: '',
      ALPACA_PAPER_API_KEY: '',
      ALPACA_PAPER_API_SECRET: '',
      ALPACA_LIVE_API_KEY: '',
      ALPACA_LIVE_API_SECRET: '',
      BROKER: '',
      OANDA_PRACTICE_TOKEN: '',
      OANDA_PRACTICE_ACCOUNT_ID: '',
      OANDA_LIVE_TOKEN: '',
      OANDA_LIVE_ACCOUNT_ID: '',
      LIVE_TRADING_ENABLED: 'false',
    },
  },
});
