// NOTE: this workspace deliberately does NOT use the shared `@repo/vitest-config`
// base. `@cloudflare/vitest-pool-workers` runs tests inside the real workerd
// runtime with actual Durable Objects, which requires its own Vite plugin.
// Swapping this for the shared base will break the tests.
//
// vitest-pool-workers 0.20 replaced the old `defineWorkersConfig` +
// `test.poolOptions.workers` setup with the `cloudflareTest()` plugin below.
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
    }),
  ],
})
