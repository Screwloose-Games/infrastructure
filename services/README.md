# services/

Long-running backend services — APIs, workers, schedulers, and anything else
that gets deployed and stays up.

Each subdirectory is its own pnpm workspace with its own `package.json`. A
service owns its data and exposes an interface; it should not import from
`apps/*`.
