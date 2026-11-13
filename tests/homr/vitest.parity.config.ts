import { defineConfig } from 'vitest/config';

// The Node run of the TypeScript homr port (tests/homr/parity.run.ts); not part of `npm test`.
export default defineConfig({
  test: { include: ['tests/homr/parity.run.ts'], environment: 'node', pool: 'forks', testTimeout: 24 * 3600 * 1000 },
});
