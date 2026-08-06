import { defineConfig } from 'vitest/config'

/**
 * Base Vitest config. Extend it from a workspace's own `vitest.config.ts`:
 *
 *   import { mergeConfig } from 'vitest/config'
 *   import { baseConfig } from '@repo/vitest-config'
 *
 *   export default mergeConfig(baseConfig, defineConfig({ test: { ... } }))
 */
export const baseConfig = defineConfig({
  test: {
    environment: 'node',
    globals: false,
    passWithNoTests: true,
    include: ['src/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
    },
  },
})

export default baseConfig
