# @repo/signaling-server

WebRTC signaling relay on Cloudflare Workers. Two peers exchange SDP
offers/answers and ICE candidates through it, then connect to each other
directly — the server is only the rendezvous point.

One Worker fronts a single Durable Object class, `SignalSession`. Each session
code maps to its own DO instance via `env.SIGNAL.idFromName(code)`, so sessions
are isolated with no provisioning step.

## Endpoints

| Route             | Behaviour                                                  |
| ----------------- | ---------------------------------------------------------- |
| `GET /`           | `200 ok` — health check                                    |
| `/session/<code>` | WebSocket upgrade; joins the session for `<code>`          |

`<code>` must match `[A-Za-z0-9_-]{1,64}`. Anything else is a `404`.

Every message received from one peer is broadcast verbatim to the other peers
in the same session. The relay does not parse or validate payloads.

Status codes on the session route:

- `426` — request was not a WebSocket upgrade
- `403` — session already has `MAX_PEERS` (2) connected

## Develop

```sh
pnpm --filter @repo/signaling-server dev     # wrangler dev on localhost:8787
pnpm --filter @repo/signaling-server test    # real Durable Objects, in-process
```

Manual check against a running `wrangler dev` — open two terminals:

```sh
npx wscat -c ws://localhost:8787/session/TESTCODE
```

Type into one; it appears in the other.

## Deploy

Not wired into CI — deploys are manual and deliberate.

```sh
export CLOUDFLARE_API_TOKEN=...            # from .env at the repo root
pnpm --filter @repo/signaling-server run deploy
npx wrangler tail                          # live logs
```

Note the `run` in `pnpm run deploy`. Bare `pnpm deploy` is pnpm's own built-in
command and will *not* invoke this script.

Then verify against `wss://game-signaling.<your-subdomain>.workers.dev/session/TESTCODE`.

## Constraints

`SignalSession` (the DO class name) and the `v1` migration tag in
`wrangler.toml` must stay stable across deploys — renaming the class later
requires an explicit rename migration.

This workspace does not use the shared `@repo/vitest-config`; see the comment in
`vitest.config.ts` for why. Its `tsconfig.json` extends the shared *base* rather
than `node.json`, because Node globals conflict with the Workers runtime types.

## Possible hardening

Not implemented, in rough priority order: an auth handshake before `accept()`,
message size limits, and WebSocket Hibernation (`state.acceptWebSocket()`) to
cut idle billing on long-lived sessions.
