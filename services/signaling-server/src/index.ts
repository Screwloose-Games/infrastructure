/**
 * WebRTC signaling relay.
 *
 * The Worker routes `/session/<code>` to a Durable Object instance derived from
 * the session code, so every peer using the same code lands in the same DO with
 * no per-session provisioning. The DO relays SDP offers/answers and ICE
 * candidates between the peers connected to it.
 */

export interface Env {
  SIGNAL: DurableObjectNamespace
}

const SESSION_PATH = /^\/session\/([A-Za-z0-9_-]{1,64})$/

/** A signaling session is a 2-peer handshake; reject anyone else. */
const MAX_PEERS = 2

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/') {
      return new Response('ok', { status: 200 })
    }

    const match = SESSION_PATH.exec(url.pathname)
    if (!match?.[1]) {
      return new Response('Not found', { status: 404 })
    }

    const id = env.SIGNAL.idFromName(match[1]) // one DO instance per code
    return env.SIGNAL.get(id).fetch(request)
  },
} satisfies ExportedHandler<Env>

export class SignalSession {
  private readonly sockets = new Set<WebSocket>()

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }

    if (this.sockets.size >= MAX_PEERS) {
      return new Response('Session full', { status: 403 })
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    server.accept()
    this.sockets.add(server)

    server.addEventListener('message', (event: MessageEvent) => {
      // Broadcast to every other peer in this session.
      for (const peer of this.sockets) {
        if (peer !== server && peer.readyState === WebSocket.OPEN) {
          peer.send(event.data)
        }
      }
    })

    const cleanup = () => {
      this.sockets.delete(server)
    }
    server.addEventListener('close', cleanup)
    server.addEventListener('error', cleanup)

    return new Response(null, { status: 101, webSocket: client })
  }
}
