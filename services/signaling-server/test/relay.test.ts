import { SELF } from 'cloudflare:test'
import { expect, it } from 'vitest'

const sessionUrl = (code: string) => `https://signaling.test/session/${code}`

interface Peer {
  socket: WebSocket
  /** Resolves with the first buffered-or-future message matching `match`. */
  next(match: (data: string) => boolean): Promise<string>
  closed: Promise<{ code: number; reason: string }>
}

/** `session/*` control frame type, or null for a relayed WebRTC payload. */
function controlType(data: string): string | null {
  try {
    const parsed = JSON.parse(data) as { type?: unknown }
    return typeof parsed.type === 'string' && parsed.type.startsWith('session/')
      ? parsed.type
      : null
  } catch {
    return null
  }
}

const ofType = (type: string) => (data: string) => controlType(data) === type
const isRelayed = (data: string) => controlType(data) === null

function attach(socket: WebSocket): Peer {
  const buffered: string[] = []
  let waiter: { match: (d: string) => boolean; resolve: (d: string) => void } | null = null

  socket.addEventListener('message', (event) => {
    const data = String(event.data)
    if (waiter?.match(data)) {
      const pending = waiter
      waiter = null
      pending.resolve(data)
      return
    }
    buffered.push(data)
  })

  let markClosed: (value: { code: number; reason: string }) => void = () => {}
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    markClosed = resolve
  })
  socket.addEventListener('close', (event) => {
    markClosed({ code: event.code, reason: event.reason })
  })

  return {
    socket,
    next(match) {
      const index = buffered.findIndex(match)
      const found = buffered[index]
      if (index >= 0 && found !== undefined) {
        buffered.splice(index, 1)
        return Promise.resolve(found)
      }
      return new Promise((resolve) => {
        waiter = { match, resolve }
      })
    },
    closed,
  }
}

/**
 * Durable Objects are keyed by session code and live for the whole test run, so
 * each test uses its own six-character code.
 */
async function openPeer(code: string): Promise<Peer> {
  const response = await SELF.fetch(sessionUrl(code), {
    headers: { Upgrade: 'websocket' },
  })

  expect(response.status).toBe(101)

  const socket = response.webSocket
  if (!socket) {
    throw new Error('expected a webSocket on the 101 response')
  }

  // Attach before accept() so the server's immediate `session/joined` frame is
  // buffered rather than lost.
  const peer = attach(socket)
  socket.accept()
  return peer
}

const parse = (data: string) => JSON.parse(data) as Record<string, unknown>

it('answers the health check', async () => {
  const response = await SELF.fetch('https://signaling.test/')

  expect(response.status).toBe(200)
  expect(await response.text()).toBe('ok')
})

it('rejects a code that is not six characters', async () => {
  const short = await SELF.fetch(sessionUrl('ABC12'))
  const long = await SELF.fetch(sessionUrl('ABC1234'))

  expect(short.status).toBe(404)
  expect(long.status).toBe(404)
})

it('tells the first peer it is the host and the second it is the client', async () => {
  const host = await openPeer('JOIN01')
  expect(parse(await host.next(ofType('session/joined')))).toMatchObject({
    role: 'host',
    peers: 1,
  })

  const client = await openPeer('JOIN01')
  expect(parse(await client.next(ofType('session/joined')))).toMatchObject({
    role: 'client',
    peers: 2,
  })

  // The host needs this to know it can spawn the arriving player.
  await host.next(ofType('session/peer-joined'))

  host.socket.close()
  client.socket.close()
})

it('treats join codes case-insensitively', async () => {
  const host = await openPeer('ab12cd')
  await host.next(ofType('session/joined'))

  const client = await openPeer('AB12CD')
  expect(parse(await client.next(ofType('session/joined')))).toMatchObject({
    role: 'client',
    peers: 2,
  })

  host.socket.close()
  client.socket.close()
})

it('relays a payload to the other peer without echoing it back', async () => {
  const host = await openPeer('RELAY1')
  const client = await openPeer('RELAY1')

  const delivered = client.next(isRelayed)

  let echoedToSender = false
  host.socket.addEventListener('message', (event) => {
    if (isRelayed(String(event.data))) {
      echoedToSender = true
    }
  })

  host.socket.send('{"type":"offer","sdp":"v=0"}')

  expect(await delivered).toBe('{"type":"offer","sdp":"v=0"}')
  expect(echoedToSender).toBe(false)

  host.socket.close()
  client.socket.close()
})

it('rejects a third peer joining the same session', async () => {
  const host = await openPeer('FULL01')
  const client = await openPeer('FULL01')

  const third = await SELF.fetch(sessionUrl('FULL01'), {
    headers: { Upgrade: 'websocket' },
  })

  expect(third.status).toBe(403)

  host.socket.close()
  client.socket.close()
})

it('ends the session with a distinct close code when the host disconnects', async () => {
  const host = await openPeer('HOSTGO')
  const client = await openPeer('HOSTGO')
  await client.next(ofType('session/joined'))

  host.socket.close()

  expect(await client.closed).toMatchObject({ code: 4000 })
})

it('tells the host when the client leaves, without ending the session', async () => {
  const host = await openPeer('CLIGO1')
  const client = await openPeer('CLIGO1')
  await host.next(ofType('session/peer-joined'))

  client.socket.close()

  await host.next(ofType('session/peer-left'))
  expect(host.socket.readyState).toBe(WebSocket.OPEN)

  host.socket.close()
})

it('closes a peer that tries to push gameplay-sized payloads through signaling', async () => {
  const host = await openPeer('BIG001')
  await host.next(ofType('session/joined'))

  host.socket.send('x'.repeat(64 * 1024 + 1))

  expect(await host.closed).toMatchObject({ code: 4001 })
})
