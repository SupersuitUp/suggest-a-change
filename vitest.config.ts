import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['test/client/**/*.test.ts'], environment: 'node' },
})
