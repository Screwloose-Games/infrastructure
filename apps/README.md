# apps/

User-facing applications — anything with a UI or an end-user entry point (web
frontends, dashboards, desktop clients).

Each subdirectory is its own pnpm workspace with its own `package.json`. Apps
are deployable leaves: they may depend on `packages/*` and call into
`services/*`, but nothing should depend on an app.
