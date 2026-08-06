Here's a complete, self-contained brief you can hand to your local agent to build and deploy the signaling server.

---

## Build brief: Cloudflare signaling server (Worker + one Durable Object per session code)

### Architecture
One Worker acts as the HTTP/WebSocket entry point. It defines a single Durable Object class (`SignalSession`). At runtime, the Worker maps each session code to a DO instance via `env.SIGNAL.idFromName(sessionCode)` — so you get exactly one DO instance per session code automatically, with no per-session provisioning. Peers connect over WebSocket to a session; the DO relays signaling messages (SDP offers/answers, ICE candidates) between the peers in that session.

### Prerequisites
Install `wrangler` (`npm install -g wrangler` or use `npx wrangler`). Authenticate using the API token that was just set up — do **not** hardcode it. Export it in the shell: `export CLOUDFLARE_API_TOKEN=<the token>`. Durable Objects with the modern `new_sqlite_classes` migration are available on the free Workers plan; if you use the older `new_classes` key you'll need a paid plan.

### File: `wrangler.toml`
```toml
name = "game-signaling"
main = "src/index.js"
compatibility_date = "2025-01-01"

[[durable_objects.bindings]]
name = "SIGNAL"
class_name = "SignalSession"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["SignalSession"]
```

### File: `src/index.js`
```js
// Worker entry: route /session/<code> to the matching Durable Object instance.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/session\/([A-Za-z0-9_-]{1,64})$/);
    if (!match) return new Response("Not found", { status: 404 });

    const sessionCode = match[1];
    const id = env.SIGNAL.idFromName(sessionCode); // one DO instance per code
    const stub = env.SIGNAL.get(id);
    return stub.fetch(request);
  },
};

// Durable Object: relays signaling messages between peers in one session.
export class SignalSession {
  constructor(state, env) {
    this.state = state;
    this.sockets = new Set();
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.sockets.add(server);

    server.addEventListener("message", (event) => {
      // Relay to every other peer in this session (simple broadcast).
      for (const peer of this.sockets) {
        if (peer !== server && peer.readyState === WebSocket.OPEN) {
          peer.send(event.data);
        }
      }
    });

    const cleanup = () => this.sockets.delete(server);
    server.addEventListener("close", cleanup);
    server.addEventListener("error", cleanup);

    return new Response(null, { status: 101, webSocket: client });
  }
}
```

### Deploy and verify
Run `wrangler deploy` from the project root. Test with any WS client against `wss://game-signaling.<your-subdomain>.workers.dev/session/TESTCODE` — open two connections to the same code and confirm a message from one arrives at the other. Stream live logs with `wrangler tail` (this is why the token has Workers Tail read).

### Notes and hardening to consider
This is a minimal broadcast relay, which is the right starting point for a 2-peer game signaling flow. For production you'll likely want to add: a max-peers-per-session cap, an auth/handshake check before `accept()`, message size limits, and optionally WebSocket Hibernation (`state.acceptWebSocket()` instead of `server.accept()`) to reduce billing/idle cost for long-lived sessions. If you don't actually store anything in KV, drop the `Workers KV Storage` permission from the token — the code above uses only Durable Objects.

---

One correction to my earlier message: the values here are placeholders (`game-signaling`, `compatibility_date`)

Keep the DO **class name** (`SignalSession`) and the migration `tag` stable across deploys, since renaming the class later requires a rename migration. 