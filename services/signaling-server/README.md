# @repo/signaling-server Proof-of-concept

WebRTC signaling relay on Cloudflare Workers, for peer-hosted,
host-authoritative two-player sessions. The two players exchange SDP
offers/answers and ICE candidates through it, then talk directly over WebRTC —
gameplay traffic never touches this server.

One Worker fronts a single Durable Object class, `SignalSession`. Each join code
maps to its own DO instance via `env.SIGNAL.idFromName(code)`, so sessions are
isolated with no provisioning step. All state is in memory and dies with the
session; there is no database.

## Endpoints

| Route             | Behaviour                                          |
| ----------------- | -------------------------------------------------- |
| `GET /`           | `200 ok` — health check                            |
| `/session/<code>` | WebSocket upgrade; joins the session for `<code>`  |

`<code>` is a **six-character** join code matching `[A-Za-z0-9_-]{6}`, matched
case-insensitively so a code read off one screen and typed into another resolves
to the same session. Anything that isn't six characters is a `404`.

Rejections before the socket opens:

| Status | Meaning                                    |
| ------ | ------------------------------------------ |
| `404`  | Not a valid six-character code             |
| `426`  | Request was not a WebSocket upgrade        |
| `403`  | Session already has two peers              |

## Protocol

The first peer to join is the **host**, the second is the **client**. Roles are
assigned by arrival order and never change.

The server sends JSON **control frames**, namespaced under `session/` so the
game client can distinguish them from relayed WebRTC payloads:

| Frame                                            | Sent to | When                          |
| ------------------------------------------------ | ------- | ----------------------------- |
| `{"type":"session/joined","role":…,"peers":n}`    | joiner  | immediately on connect        |
| `{"type":"session/peer-joined"}`                  | host    | the client connects           |
| `{"type":"session/peer-left"}`                    | host    | the client disconnects        |

`session/joined` is the "code accepted" signal the join UI waits on.

**Everything else is relayed verbatim** to the other peer and never echoed back
to the sender. The relay does not parse or validate payloads — put your
offer/answer/ICE messages through unchanged.

Close codes:

| Code   | Meaning                                                        |
| ------ | -------------------------------------------------------------- |
| `4000` | Host disconnected — the session is over                        |
| `4001` | Message exceeded 64 KiB                                        |

Losing the host ends the session, because the host owns the simulation. Losing
the client does not: the host keeps playing solo and another client may join.

Signaling messages are capped at **64 KiB**. Gameplay snapshots belong on the
WebRTC data channel, and the cap makes a client that gets that wrong fail
loudly instead of quietly routing game traffic through the server.

## Develop

```sh
pnpm --filter @repo/signaling-server dev     # wrangler dev on localhost:8787
pnpm --filter @repo/signaling-server test    # real Durable Objects, in-process
```

Manual check against a running `wrangler dev` — open two terminals:

```sh
npx wscat -c ws://localhost:8787/session/ABC123
```

Each prints a `session/joined` frame on connect; anything typed into one
appears in the other.

## Deploy

Automatic. `.github/workflows/deploy-signaling-server.yml` deploys the Worker
when a change under `services/signaling-server/` lands on `main` and the `CI`
workflow goes green. It reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
from the `production` GitHub Environment. The same workflow has a **Run
workflow** button for redeploying the current `main` on demand.

To deploy by hand:

```sh
export CLOUDFLARE_API_TOKEN=...            # CLOUDFLARE_WORKERS_API_TOKEN in .env at the repo root
pnpm --filter @repo/signaling-server run deploy
npx wrangler tail                          # live logs
```

Note the `run` in `pnpm run deploy`. Bare `pnpm deploy` is pnpm's own built-in
command and will *not* invoke this script.

Then verify against `wss://game-signaling.<your-subdomain>.workers.dev/session/ABC123`.

## Constraints

`SignalSession` (the DO class name) and the `v1` migration tag in
`wrangler.toml` must stay stable across deploys — renaming the class later
requires an explicit rename migration.

This workspace does not use the shared `@repo/vitest-config`; see the comment in
`vitest.config.ts` for why. Its `tsconfig.json` extends the shared *base* rather
than `node.json`, because Node globals conflict with the Workers runtime types.

## Not implemented

- **Code expiry.** Sessions live as long as the host holds the socket; there is
  no TTL on a code.
- **Auth.** Anyone who knows a code can join it. An auth handshake before
  `accept()` is the natural place to add one.
- **Reconnection.** Out of scope for the MVP, per `todo.md`.
- **TURN relay.** STUN only; restrictive NAT / CGNAT will fail to connect.
- **WebSocket Hibernation.** `state.acceptWebSocket()` would cut idle billing on
  long-lived sessions.
