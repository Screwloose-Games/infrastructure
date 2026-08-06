/**
 * WebRTC signaling relay for peer-hosted, host-authoritative 2-player sessions.
 *
 * The Worker routes `/session/<code>` to a Durable Object derived from the
 * session code, so both players using the same code land in the same DO with no
 * provisioning step. The DO relays SDP offers/answers and ICE candidates
 * between them; once the peer connection is up, gameplay traffic goes directly
 * over WebRTC and never touches this server.
 *
 * All state is in-memory and dies with the session. There is no database.
 */

export interface Env {
  SIGNAL: DurableObjectNamespace
}

/**
 * Join codes are the six-character codes shown in the host's UI. Length is
 * fixed so a mistyped code fails here rather than silently opening an empty
 * session the other player can never reach.
 */
const SESSION_PATH = /^\/session\/([A-Za-z0-9_-]{6})$/

/** A session is exactly one host plus one client. */
const MAX_PEERS = 2

/**
 * Signaling carries SDP and ICE only. Gameplay snapshots belong on the WebRTC
 * data channel, so anything this large is a bug on the client.
 */
const MAX_MESSAGE_BYTES = 64 * 1024

/** Application close codes. The client maps these to its UI states. */
export const CLOSE_HOST_DISCONNECTED = 4000
export const CLOSE_MESSAGE_TOO_LARGE = 4001

type Role = 'host' | 'client'

/**
 * Control frames are namespaced under `session/` so the game client can tell
 * them apart from relayed WebRTC payloads, which are forwarded verbatim.
 */
type ControlMessage =
  | { type: 'session/joined'; role: Role; peers: number }
  | { type: 'session/peer-joined' }
  | { type: 'session/peer-left' }

function send(socket: WebSocket, message: ControlMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message))
  }
}

function byteLength(data: string | ArrayBuffer): number {
  return typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/') {
      return new Response('ok', { status: 200 })
    }

    const match = SESSION_PATH.exec(url.pathname)
    if (!match?.[1]) {
      return new Response('Invalid session code', { status: 404 })
    }

    // Codes are read off one screen and typed into another, so match them
    // case-insensitively — otherwise "ab12cd" and "AB12CD" become two sessions.
    const id = env.SIGNAL.idFromName(match[1].toUpperCase())
    return env.SIGNAL.get(id).fetch(request)
  },
} satisfies ExportedHandler<Env>

export class SignalSession {
  /** Insertion order decides roles: the first peer to arrive is the host. */
  private readonly peers = new Map<WebSocket, Role>()

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }

    if (this.peers.size >= MAX_PEERS) {
      return new Response('Session full', { status: 403 })
    }

    const role: Role = this.peers.size === 0 ? 'host' : 'client'
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    server.accept()
    this.peers.set(server, role)

    // The "code accepted" stage: the joiner learns its role and whether the
    // other player is already here.
    send(server, { type: 'session/joined', role, peers: this.peers.size })

    if (role === 'client') {
      this.notifyOthers(server, { type: 'session/peer-joined' })
    }

    server.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as string | ArrayBuffer

      if (byteLength(data) > MAX_MESSAGE_BYTES) {
        server.close(CLOSE_MESSAGE_TOO_LARGE, 'message too large')
        this.handleDeparture(server)
        return
      }

      for (const peer of this.peers.keys()) {
        if (peer !== server && peer.readyState === WebSocket.OPEN) {
          peer.send(data)
        }
      }
    })

    const onGone = () => this.handleDeparture(server)
    server.addEventListener('close', onGone)
    server.addEventListener('error', onGone)

    return new Response(null, { status: 101, webSocket: client })
  }

  private notifyOthers(origin: WebSocket, message: ControlMessage): void {
    for (const peer of this.peers.keys()) {
      if (peer !== origin) {
        send(peer, message)
      }
    }
  }

  private handleDeparture(socket: WebSocket): void {
    const role = this.peers.get(socket)
    if (role === undefined) {
      return // already cleaned up
    }

    this.peers.delete(socket)

    if (role === 'host') {
      // The host owns the simulation, so losing it ends the session. Closing
      // with a distinct code gives the client a useful return path instead of
      // an unexplained socket drop.
      for (const peer of this.peers.keys()) {
        if (peer.readyState === WebSocket.OPEN) {
          peer.close(CLOSE_HOST_DISCONNECTED, 'host disconnected')
        }
      }
      this.peers.clear()
      return
    }

    // The client left. The host keeps playing solo and can accept another.
    for (const peer of this.peers.keys()) {
      send(peer, { type: 'session/peer-left' })
    }
  }
}
