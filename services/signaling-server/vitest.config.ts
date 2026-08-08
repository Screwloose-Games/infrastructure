import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Reuse the real Worker/DO bindings from local Wrangler config.
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
})
