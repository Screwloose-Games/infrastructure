# infrastructure

Screwloose Games monorepo, managed with [pnpm workspaces](https://pnpm.io/workspaces)
and [Turborepo](https://turborepo.com).

## Layout

| Directory   | Purpose                                                          |
| ----------- | ---------------------------------------------------------------- |
| `apps/`     | User-facing applications                                         |
| `services/` | Long-running backend services (APIs, workers)                    |
| `tools/`    | Developer and operational tooling (CLIs, scripts, generators)    |
| `packages/` | Shared internal libraries and configuration                      |

Each subdirectory of those is its own pnpm workspace. See the README in each
directory for details.

## Requirements

- Node `>=22` (see `.nvmrc`)
- pnpm 10 — `corepack enable && corepack prepare pnpm@10.15.0 --activate`

## Getting started

```sh
pnpm install
pnpm build      # turbo run build
pnpm test       # turbo run test
pnpm dev        # turbo run dev
```

## Scripts

| Script               | What it does                                          |
| -------------------- | ----------------------------------------------------- |
| `pnpm build`         | `turbo run build` across all workspaces               |
| `pnpm dev`           | `turbo run dev` (persistent, uncached)                |
| `pnpm test`          | `turbo run test`                                      |
| `pnpm check-types`   | `turbo run check-types`                               |
| `pnpm lint`          | `biome check .` across the repo                       |
| `pnpm lint:fix`      | `biome check --write .`                               |
| `pnpm format`        | `biome format --write .`                              |
| `pnpm changeset`     | Record a version bump + changelog entry               |
| `pnpm release`       | Build, then `changeset publish`                       |

## Adding a workspace

1. Create the directory, e.g. `services/api/`.
2. Add a `package.json` with a scoped name (`@repo/api`), `"private": true` for
   anything not published, and the scripts Turborepo drives — `build`,
   `dev`, `test`, `check-types`, `lint`.
3. Add a `tsconfig.json` extending the shared base. Path options live in the
   workspace, not the shared base — TypeScript resolves relative paths against
   the file they are written in:

   ```json
   {
     "extends": "@repo/typescript-config/node.json",
     "compilerOptions": { "outDir": "dist", "rootDir": "src" },
     "include": ["src/**/*"],
     "exclude": ["node_modules", "dist"]
   }
   ```

   with `"@repo/typescript-config": "workspace:*"` in `devDependencies`.
4. Take shared dependency versions from the pnpm catalog where one exists —
   `"typescript": "catalog:"` instead of pinning a version locally.
5. Run `pnpm install` from the repo root.

## Tooling

- **Turborepo** — task graph and caching (`turbo.json`)
- **Biome** — lint and format, configured once in `@repo/biome-config`
- **Vitest** — tests, with a shared base in `@repo/vitest-config`
- **Changesets** — versioning and changelogs
- **GitHub Actions** — `.github/workflows/ci.yml` runs lint, typecheck, build, test
