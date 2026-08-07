import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

// A unique valid code per test prevents session state leaking between tests.
const SESSION_CODE = 'ABC999';

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
				resolve(JSON.parse(event.data as string));
			},
			{ once: true },
		);
	});
}

/**
 * Makes an in-runtime WebSocket request through the public Worker.
 *
 * This tests the complete path:
 * Worker route validation -> Durable Object lookup -> DO socket acceptance.
 */
async function connectSocket(path: string, expectedInitialMessage: Record<string, unknown>): Promise<WebSocket> {
	const response = await exports.default.fetch(`https://example.test${path}`, {
		headers: {
			Upgrade: 'websocket',
		},
	});

	expect(response.status).toBe(101);

	const socket = response.webSocket;

	if (socket === null) {
		throw new Error('Expected the Worker to return a WebSocket.');
	}

	// Listen first: the DO may already have sent its initial lifecycle message.
	const initialMessage = nextJsonMessage(socket);
	socket.accept();

	expect(await initialMessage).toEqual(expectedInitialMessage);

	return socket;
}

describe('session signaling', () => {
	it('rate limits repeated host creation before Durable Object routing', async () => {
		const headers = {
			'CF-Connecting-IP': '198.51.100.99',
			Upgrade: 'websocket',
		};

		for (const sessionCode of ['ABC222', 'ABC223', 'ABC224', 'ABC225', 'ABC226']) {
			const response = await exports.default.fetch(`https://example.test/sessions/${sessionCode}/host`, {
				headers,
			});

			expect(response.status).toBe(101);
			response.webSocket?.accept();
			response.webSocket?.close(1000, 'test complete');
		}

		const blocked = await exports.default.fetch('https://example.test/sessions/ABC227/host', {
			headers,
		});

		expect(blocked.status).toBe(429);
		expect(await blocked.json()).toEqual({
			error: 'Too many session requests. Please wait a moment and try again.',
		});
	});

	it('rejects a join attempt when no host exists', async () => {
		const response = await exports.default.fetch(`https://example.test/sessions/${SESSION_CODE}/join`, {
			headers: {
				Upgrade: 'websocket',
			},
		});

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: 'No live host exists for this session.',
		});
	});

	it('connects one host and one client, then reports both roles', async () => {
		const host = await connectSocket(`/sessions/${SESSION_CODE}/host`, {
			type: 'host_connected',
			session_code: SESSION_CODE,
		});

		// Register before the join occurs, so we observe the host notification.
		const hostSawClientJoin = nextJsonMessage(host);

		const client = await connectSocket(`/sessions/${SESSION_CODE}/join`, {
			type: 'client_connected',
			session_code: SESSION_CODE,
		});

		expect(await hostSawClientJoin).toEqual({
			type: 'client_joined',
			session_code: SESSION_CODE,
		});

		const statusResponse = await exports.default.fetch(`https://example.test/sessions/${SESSION_CODE}`);

		expect(await statusResponse.json()).toEqual({
			session_code: SESSION_CODE,
			host_connected: true,
			client_connected: true,
		});

		host.close(1000, 'test complete');
		client.close(1000, 'test complete');
	});

	it('relays an offer from host to client with trusted sender identity', async () => {
		const host = await connectSocket('/sessions/BCD999/host', {
			type: 'host_connected',
			session_code: 'BCD999',
		});

		const hostSawClientJoin = nextJsonMessage(host);

		const client = await connectSocket('/sessions/BCD999/join', {
			type: 'client_connected',
			session_code: 'BCD999',
		});

		await hostSawClientJoin;

		const receivedOffer = nextJsonMessage(client);

		host.send(
			JSON.stringify({
				type: 'offer',
				payload: { sdp: 'test-offer' },
			}),
		);

		expect(await receivedOffer).toEqual({
			type: 'offer',
			payload: { sdp: 'test-offer' },
			from: 'host',
		});

		host.close(1000, 'test complete');
		client.close(1000, 'test complete');
	});

	it('rejects an offer sent by the joining client', async () => {
		const host = await connectSocket('/sessions/CDE999/host', {
			type: 'host_connected',
			session_code: 'CDE999',
		});

		const hostSawClientJoin = nextJsonMessage(host);

		const client = await connectSocket('/sessions/CDE999/join', {
			type: 'client_connected',
			session_code: 'CDE999',
		});

		await hostSawClientJoin;

		const rejection = nextJsonMessage(client);

		client.send(
			JSON.stringify({
				type: 'offer',
				payload: { sdp: 'not-permitted' },
			}),
		);

		expect(await rejection).toEqual({
			type: 'signal_rejected',
			reason: 'Only the host may send an offer.',
		});

		host.close(1000, 'test complete');
		client.close(1000, 'test complete');
	});
});
