// NOTE: this workspace deliberately does NOT use the shared `@repo/vitest-config`
// base. `@cloudflare/vitest-pool-workers` requires `defineWorkersConfig` so tests
// run inside the real workerd runtime with actual Durable Objects. Swapping this
// for the shared base will break the tests.
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: { configPath: './wrangler.toml' },
      },
    },
  },
})
