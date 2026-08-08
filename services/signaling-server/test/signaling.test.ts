import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { CLOSE_HOST_DISCONNECTED } from '../src/index'

// A unique valid code per test prevents session state leaking between tests.
const SESSION_CODE = 'ABC999'
let connectionSequence = 1

/**
 * Waits for exactly one JSON message from a client-side WebSocket.
 *
 * The Worker sends connection lifecycle messages immediately, so we register
 * this listener before calling socket.accept().
 */
function nextJsonMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    socket.addEventListener(
      'message',
      (event) => {
        resolve(JSON.parse(event.data as string))
      },
      { once: true },
    )
  })
}

function nextClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.addEventListener(
      'close',
      (event) => resolve({ code: event.code, reason: event.reason }),
      { once: true },
    )
  })
}

/**
 * Makes an in-runtime WebSocket request through the public Worker.
 *
 * This tests the complete path:
 * Worker route validation -> Durable Object lookup -> DO socket acceptance.
 */
async function connectSocket(
  path: string,
  expectedInitialMessage: Record<string, unknown>,
): Promise<WebSocket> {
  const response = await exports.default.fetch(`https://example.test${path}`, {
    headers: {
      'CF-Connecting-IP': `203.0.113.${connectionSequence++}`,
      Upgrade: 'websocket',
    },
  })

  expect(response.status).toBe(101)

  const socket = response.webSocket

  if (socket === null) {
    throw new Error('Expected the Worker to return a WebSocket.')
  }

  // Listen first: the DO may already have sent its initial lifecycle message.
  const initialMessage = nextJsonMessage(socket)
  socket.accept()

  expect(await initialMessage).toEqual(expectedInitialMessage)

  return socket
}

describe('session signaling', () => {
  it('answers health checks and rejects malformed session requests', async () => {
    const health = await exports.default.fetch('https://example.test/health')
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok' })

    const malformed = await exports.default.fetch('https://example.test/sessions/SHORT')
    expect(malformed.status).toBe(400)

    const wrongMethod = await exports.default.fetch('https://example.test/sessions/ABC999', {
      method: 'POST',
    })
    expect(wrongMethod.status).toBe(405)
  })

  it('rate limits repeated host creation before Durable Object routing', async () => {
    const headers = {
      'CF-Connecting-IP': '198.51.100.99',
      Upgrade: 'websocket',
    }

    for (const sessionCode of ['ABC222', 'ABC223', 'ABC224', 'ABC225', 'ABC226']) {
      const response = await exports.default.fetch(
        `https://example.test/sessions/${sessionCode}/host`,
        {
          headers,
        },
      )

      expect(response.status).toBe(101)
      response.webSocket?.accept()
      response.webSocket?.close(1000, 'test complete')
    }

    const blocked = await exports.default.fetch('https://example.test/sessions/ABC227/host', {
      headers,
    })

    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toEqual({
      error: 'Too many session requests. Please wait a moment and try again.',
    })
  })

  it('rejects a join attempt when no host exists', async () => {
    const response = await exports.default.fetch(
      `https://example.test/sessions/${SESSION_CODE}/join`,
      {
        headers: {
          Upgrade: 'websocket',
        },
      },
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'No live host exists for this session.',
    })
  })

  it('connects one host and one client, then reports both roles', async () => {
    const host = await connectSocket(`/sessions/${SESSION_CODE}/host`, {
      type: 'host_connected',
      session_code: SESSION_CODE,
    })

    // Register before the join occurs, so we observe the host notification.
    const hostSawClientJoin = nextJsonMessage(host)

    const client = await connectSocket(`/sessions/${SESSION_CODE}/join`, {
      type: 'client_connected',
      session_code: SESSION_CODE,
    })

    expect(await hostSawClientJoin).toEqual({
      type: 'client_joined',
      session_code: SESSION_CODE,
    })

    const statusResponse = await exports.default.fetch(
      `https://example.test/sessions/${SESSION_CODE}`,
    )

    expect(await statusResponse.json()).toEqual({
      session_code: SESSION_CODE,
      host_connected: true,
      client_connected: true,
    })

    host.close(1000, 'test complete')
    client.close(1000, 'test complete')
  })

  it('rejects duplicate hosts and clients', async () => {
    const host = await connectSocket('/sessions/DEF999/host', {
      type: 'host_connected',
      session_code: 'DEF999',
    })

    const duplicateHost = await exports.default.fetch('https://example.test/sessions/DEF999/host', {
      headers: { Upgrade: 'websocket' },
    })
    expect(duplicateHost.status).toBe(409)

    const joined = nextJsonMessage(host)
    const client = await connectSocket('/sessions/DEF999/join', {
      type: 'client_connected',
      session_code: 'DEF999',
    })
    await joined

    const duplicateClient = await exports.default.fetch(
      'https://example.test/sessions/DEF999/join',
      {
        headers: { Upgrade: 'websocket' },
      },
    )
    expect(duplicateClient.status).toBe(409)

    host.close(1000, 'test complete')
    client.close(1000, 'test complete')
  })

  it('closes the client when its host disconnects', async () => {
    const host = await connectSocket('/sessions/EFG999/host', {
      type: 'host_connected',
      session_code: 'EFG999',
    })
    const hostSawClientJoin = nextJsonMessage(host)
    const client = await connectSocket('/sessions/EFG999/join', {
      type: 'client_connected',
      session_code: 'EFG999',
    })
    await hostSawClientJoin

    const clientClosed = nextClose(client)
    host.close(1000, 'test complete')
    expect(await clientClosed).toMatchObject({ code: CLOSE_HOST_DISCONNECTED })
  })

  it('notifies the host when a client leaves and permits another client', async () => {
    const host = await connectSocket('/sessions/FGH999/host', {
      type: 'host_connected',
      session_code: 'FGH999',
    })
    const hostSawFirstJoin = nextJsonMessage(host)
    const firstClient = await connectSocket('/sessions/FGH999/join', {
      type: 'client_connected',
      session_code: 'FGH999',
    })
    await hostSawFirstJoin

    const hostSawLeave = nextJsonMessage(host)
    firstClient.close(1000, 'test complete')
    expect(await hostSawLeave).toEqual({
      type: 'client_left',
      session_code: 'FGH999',
    })

    const hostSawSecondJoin = nextJsonMessage(host)
    const secondClient = await connectSocket('/sessions/FGH999/join', {
      type: 'client_connected',
      session_code: 'FGH999',
    })
    await hostSawSecondJoin

    host.close(1000, 'test complete')
    secondClient.close(1000, 'test complete')
  })

  it('relays an offer from host to client with trusted sender identity', async () => {
    const host = await connectSocket('/sessions/BCD999/host', {
      type: 'host_connected',
      session_code: 'BCD999',
    })

    const hostSawClientJoin = nextJsonMessage(host)

    const client = await connectSocket('/sessions/BCD999/join', {
      type: 'client_connected',
      session_code: 'BCD999',
    })

    await hostSawClientJoin

    const receivedOffer = nextJsonMessage(client)

    host.send(
      JSON.stringify({
        type: 'offer',
        payload: { sdp: 'test-offer' },
      }),
    )

    expect(await receivedOffer).toEqual({
      type: 'offer',
      payload: { sdp: 'test-offer' },
      from: 'host',
    })

    host.close(1000, 'test complete')
    client.close(1000, 'test complete')
  })

  it('rejects an offer sent by the joining client', async () => {
    const host = await connectSocket('/sessions/CDE999/host', {
      type: 'host_connected',
      session_code: 'CDE999',
    })

    const hostSawClientJoin = nextJsonMessage(host)

    const client = await connectSocket('/sessions/CDE999/join', {
      type: 'client_connected',
      session_code: 'CDE999',
    })

    await hostSawClientJoin

    const rejection = nextJsonMessage(client)

    client.send(
      JSON.stringify({
        type: 'offer',
        payload: { sdp: 'not-permitted' },
      }),
    )

    expect(await rejection).toEqual({
      type: 'signal_rejected',
      reason: 'Only the host may send an offer.',
    })

    host.close(1000, 'test complete')
    client.close(1000, 'test complete')
  })

  it('rejects malformed, binary, and oversized signaling frames', async () => {
    const host = await connectSocket('/sessions/GHJ999/host', {
      type: 'host_connected',
      session_code: 'GHJ999',
    })

    const malformedRejection = nextJsonMessage(host)
    const malformedClose = nextClose(host)
    host.send('not json')
    expect(await malformedRejection).toMatchObject({ type: 'signal_rejected' })
    expect(await malformedClose).toMatchObject({ code: 1008 })

    const binaryHost = await connectSocket('/sessions/HJK999/host', {
      type: 'host_connected',
      session_code: 'HJK999',
    })
    const binaryRejection = nextJsonMessage(binaryHost)
    const binaryClose = nextClose(binaryHost)
    binaryHost.send(new Uint8Array([1, 2, 3]))
    expect(await binaryRejection).toMatchObject({ type: 'signal_rejected' })
    expect(await binaryClose).toMatchObject({ code: 1008 })

    const oversizedHost = await connectSocket('/sessions/JKL999/host', {
      type: 'host_connected',
      session_code: 'JKL999',
    })
    const oversizedRejection = nextJsonMessage(oversizedHost)
    const oversizedClose = nextClose(oversizedHost)
    oversizedHost.send('é'.repeat(40_000))
    expect(await oversizedRejection).toMatchObject({ type: 'signal_rejected' })
    expect(await oversizedClose).toMatchObject({ code: 1008 })
  })

  it('relays answers and ICE candidates, then closes a peer that exceeds its signaling quota', async () => {
    const host = await connectSocket('/sessions/KLM999/host', {
      type: 'host_connected',
      session_code: 'KLM999',
    })
    const hostSawClientJoin = nextJsonMessage(host)
    const client = await connectSocket('/sessions/KLM999/join', {
      type: 'client_connected',
      session_code: 'KLM999',
    })
    await hostSawClientJoin

    const answer = nextJsonMessage(host)
    client.send(JSON.stringify({ type: 'answer', payload: { sdp: 'test-answer' } }))
    expect(await answer).toEqual({
      type: 'answer',
      payload: { sdp: 'test-answer' },
      from: 'client',
    })

    const candidate = nextJsonMessage(client)
    host.send(
      JSON.stringify({
        type: 'ice_candidate',
        payload: { candidate: 'candidate:1' },
      }),
    )
    expect(await candidate).toEqual({
      type: 'ice_candidate',
      payload: { candidate: 'candidate:1' },
      from: 'host',
    })

    const quotaRejection = nextJsonMessage(host)
    const quotaClose = nextClose(host)
    for (let message = 0; message < 30; message += 1) {
      host.send(JSON.stringify({ type: 'ice_candidate', payload: { message } }))
    }
    expect(await quotaRejection).toMatchObject({ type: 'signal_rejected' })
    expect(await quotaClose).toMatchObject({ code: 1008 })
    client.close(1000, 'test complete')
  })
})
