# @repo/signaling-server Proof-of-concept

WebRTC signaling relay on Cloudflare Workers, for peer-hosted,
host-authoritative two-player sessions. The two players exchange SDP
offers/answers and ICE candidates through it, then talk directly over WebRTC —
gameplay traffic never touches this server.

One Worker fronts a single Durable Object class, `SignalSession`. Each join code
maps to its own DO instance via `env.SIGNAL.getByName(code)`, so sessions are
isolated with no provisioning step. Session state is limited to open WebSockets
and their hibernation-safe attachments; there is no database or reconnectable
session state.

## Endpoints

| Route                   | Behaviour                                      |
| ----------------------- | ---------------------------------------------- |
| `GET /health`           | `200 {"status":"ok"}` — health check           |
| `GET /sessions/<code>`  | JSON status for the session                    |
| `/sessions/<code>/host` | WebSocket upgrade; creates the host connection |
| `/sessions/<code>/join` | WebSocket upgrade; joins a live host           |

`<code>` is a **six-character**, case-insensitive join code matching
`[A-HJ-NP-Z2-9]{6}`. The alphabet deliberately avoids ambiguous characters.
Malformed codes are rejected with `400`.

Rejections before the socket opens:

| Status | Meaning                                          |
| ------ | ------------------------------------------------ |
| `400`  | Malformed session code                           |
| `409`  | No host exists, or that host/client slot is full |
| `426`  | Request was not a WebSocket upgrade              |
| `429`  | Request rate limit exceeded                      |

## Protocol

The host explicitly connects first; one client may then join. Roles are assigned
by the endpoint and never change.

The server sends JSON lifecycle frames:

| Frame                                          | Sent to | When                   |
| ---------------------------------------------- | ------- | ---------------------- |
| `{"type":"host_connected","session_code":…}`   | host    | immediately on connect |
| `{"type":"client_connected","session_code":…}` | client  | immediately on connect |
| `{"type":"client_joined","session_code":…}`    | host    | client connects        |
| `{"type":"client_left","session_code":…}`      | host    | client disconnects     |

Client frames must be JSON objects with `type` `offer`, `answer`, or
`ice_candidate`, plus an object `payload`. The Worker adds the trustworthy
`from` role before relaying: hosts may offer, clients may answer, and either may
send ICE candidates. Invalid frames receive `signal_rejected` and close with
WebSocket policy code `1008`.

Close codes:

| Code   | Meaning                                             |
| ------ | --------------------------------------------------- |
| `4000` | Host disconnected — the session is over             |
| `1008` | Invalid, oversized, or rate-limited signaling frame |

Losing the host ends the session, because the host owns the simulation. Losing
the client does not: the host keeps playing solo and another client may join.

Signaling messages are capped at **64 KiB UTF-8** and each socket may send 30
messages per 10 seconds. Gameplay snapshots belong on the WebRTC data channel.

## Develop

```sh
pnpm --filter @repo/signaling-server dev     # wrangler dev on localhost:8787
pnpm --filter @repo/signaling-server test    # real Durable Objects, in-process
```

Manual check against a running `wrangler dev` — open two terminals:

```sh
npx wscat -c ws://localhost:8787/sessions/ABC123/host
```

Connect the joiner at `/sessions/ABC123/join`. Each endpoint receives its
connection frame, and the host receives `client_joined`.

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
command and will _not_ invoke this script.

### Currently deployed

<https://signaling.screwloose.workers.dev>

```sh
curl https://signaling.screwloose.workers.dev.workers.dev/health
npx wscat -c wss://signaling.screwloose.workers.dev.workers.dev/sessions/ABC123/host
```

The Worker is public and unauthenticated — anyone who guesses a six-character
code can join that session. See _Not implemented_ below.

## Constraints

`SignalSession` remains the deployed Durable Object class name. Its current
`exports` declaration preserves the namespace created by the prior migration
configuration; rename it only with an explicit Durable Object lifecycle change.

This workspace does not use the shared `@repo/vitest-config`; see the comment in
`vitest.config.ts` for why. Its `tsconfig.json` extends the shared _base_ rather
than `node.json`, because Node globals conflict with the Workers runtime types.

## Not implemented

- **Code expiry.** Sessions live as long as the host holds the socket; there is
  no TTL on a code.
- **Auth.** Anyone who knows a code can join it. An auth handshake before
  `accept()` is the natural place to add one.
- **Reconnection.** Out of scope for the MVP, per `todo.md`.
- **TURN relay.** STUN only; restrictive NAT / CGNAT will fail to connect.
