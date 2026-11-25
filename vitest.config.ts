import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'apps/**/*.test.ts', 'apps/**/*.test.tsx'], environment: 'node', testTimeout: 20000 },
});
