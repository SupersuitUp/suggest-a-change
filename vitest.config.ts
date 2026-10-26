import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['test/client/**/*.test.{ts,tsx}', 'test/server/**/*.test.ts', 'test/github/**/*.test.ts'], environment: 'node' },
})
