# Signaling-server implementation notes

`game-signaling` is a Cloudflare Worker that exposes one hibernation-aware
`SignalSession` Durable Object for each six-character session code. The Worker
uses `env.SIGNAL.getByName(code)`, so a session needs no separate provisioning.

The public contract is intentionally narrow:

- `GET /health` returns `{ "status": "ok" }`.
- `GET /sessions/<code>` reports whether the host and client are connected.
- `/sessions/<code>/host` opens the one host socket.
- `/sessions/<code>/join` opens the one client socket, only while the host is
  connected.

The service accepts only JSON WebRTC offer, answer, and ICE-candidate messages.
It adds the sender role before relaying, limits request and message rates, and
does not store game or reconnectable-session data. Socket attachments preserve
only role, session code, and quota state while a Durable Object is hibernating.

Keep both the Worker name (`game-signaling`) and Durable Object class name
(`SignalSession`) stable. The latter preserves the namespace created by the
previous migration-based configuration; rename it only with an explicit Durable
Object lifecycle change.

Run `pnpm --filter @repo/signaling-server test` before deployment. Regenerate
`worker-configuration.d.ts` from the service directory with `wrangler types`
whenever `wrangler.jsonc` changes.
