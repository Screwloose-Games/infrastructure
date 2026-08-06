# packages/

Shared internal libraries and configuration consumed by `apps/`, `services/`,
and `tools/`. Nothing here is deployed on its own.

Current contents:

| Package                   | Purpose                                     |
| ------------------------- | ------------------------------------------- |
| `@repo/typescript-config` | Shared `tsconfig` bases                     |
| `@repo/biome-config`      | Shared Biome lint/format rules              |
| `@repo/vitest-config`     | Shared Vitest base config                   |

Reference these from a workspace with `"@repo/<name>": "workspace:*"`.
