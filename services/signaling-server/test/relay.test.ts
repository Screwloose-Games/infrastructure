import { SELF } from 'cloudflare:test'
import { expect, it } from 'vitest'

const sessionUrl = (code: string) => `https://signaling.test/session/${code}`

/**
 * Durable Objects are keyed by session code and persist for the whole test run,
 * so every test uses its own code to avoid leaking sockets between tests.
 */
async function openPeer(code: string): Promise<WebSocket> {
  const response = await SELF.fetch(sessionUrl(code), {
    headers: { Upgrade: 'websocket' },
  })

  expect(response.status).toBe(101)

  const socket = response.webSocket
  if (!socket) {
    throw new Error('expected a webSocket on the 101 response')
  }

  socket.accept()
  return socket
}

it('answers the health check', async () => {
  const response = await SELF.fetch('https://signaling.test/')

  expect(response.status).toBe(200)
  expect(await response.text()).toBe('ok')
})

it('relays a message to the other peer without echoing it back', async () => {
  const peerA = await openPeer('RELAY')
  const peerB = await openPeer('RELAY')

  const delivered = new Promise<string>((resolve) => {
    peerB.addEventListener('message', (event) => resolve(String(event.data)))
  })

  let echoedToSender = false
  peerA.addEventListener('message', () => {
    echoedToSender = true
  })

  peerA.send('{"type":"offer"}')

  expect(await delivered).toBe('{"type":"offer"}')
  expect(echoedToSender).toBe(false)

  peerA.close()
  peerB.close()
})

it('rejects a third peer joining the same session', async () => {
  const peerA = await openPeer('FULL')
  const peerB = await openPeer('FULL')

  const third = await SELF.fetch(sessionUrl('FULL'), {
    headers: { Upgrade: 'websocket' },
  })

  expect(third.status).toBe(403)

  peerA.close()
  peerB.close()
})
