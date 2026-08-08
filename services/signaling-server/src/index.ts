import { DurableObject } from "cloudflare:workers";

// A six-character code alphabet that deliberately excludes ambiguous characters
const SESSION_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;

// A session has one ordinary status route and two WebSocket roles.
type SessionEndpoint = "status" | "host_socket" | "join_socket";

// A socket can belong to the player hosting the session or its one joiner.
type ConnectionRole = "host" | "client";

// Parsed routing data. The Worker and DO both use this shape so they agree
// about which session code and endpoint a request represents.
interface SessionRoute {
  sessionCode: string;
  endpoint: SessionEndpoint;
}

// This attachment lives on an individual WebSocket connection.
//
// Unlike ordinary class properties, WebSocket attachments survive DO hibernation
// while the socket itself remains open.
interface ConnectionAttachment {
  // This lets the Durable Object identify each connected socket after waking.
  role: ConnectionRole;

  // Useful later for diagnostics and timeouts; not game state.
  connectedAt: number;

  // Hibernation-safe per-socket signaling quota. This prevents one accepted
  // peer from turning the Durable Object into a high-rate relay.
  signalWindowStartedAt: number;
  signalsInWindow: number;
}

// The only protocol msgs that may travel through this signaling service.
//
// WebRTC's actual offer, answer, and ICE-candidate shapes stay inside 'payload'.
// This keeps the signaling service reusable while still rejecting arbitrary
// msg categories such as gameplay state or player input.
type SignalMessageType = "offer" | "answer" | "ice_candidate";

interface SignalingMessage {
  type: SignalMessageType;
  payload: Record<string, unknown>;
}

// The relay adds the sender role itself. Clients cannot claim to tbe the host.
interface RelayedSignalingMessage extends SignalingMessage {
  from: ConnectionRole;
}

// Signaling data is small. This is intenionally far below a game-state payload.
const MAX_SIGNALING_MESSAGE_BYTES = 64 * 1024;

/** The host owns the authoritative simulation, so its departure ends a session. */
export const CLOSE_HOST_DISCONNECTED = 4000;

// A normal WebRTC negotiation sends only a small burst of offer/answer/ICE
// messages. This leaves room for that burst while cutting off a socket flood.
const SIGNALING_WINDOW_MS = 10_000;
const MAX_SIGNALING_MESSAGES_PER_WINDOW = 30;

/**
 * Parses either:
 *
 *   /sessions/7K2QX9
 *   /sessions/7K2QX9/host
 *   /sessions/7K2QX9/join
 *
 * Returning null means the URL is not a session route.
 */
function sessionRouteFromPath(pathname: string): SessionRoute | null {
  // The final segment is optional for status, or selects one WebSocket role.
  const match = /^\/sessions\/([^/]+)(?:\/(host|join))?$/.exec(pathname);

  if (match === null) {
    return null;
  }

  return {
    // Codes are case-insensitive at the HTTP boundary.
    sessionCode: match[1].toUpperCase(),

    // No final segment means status. Otherwise select the requested socket role.
    endpoint:
      match[2] === "host"
        ? "host_socket"
        : match[2] === "join"
          ? "join_socket"
          : "status",
  };
}

/**
 * Checks whether an HTTP request is asking to become a WebSocket connection.
 *
 * A browser creates this Upgrade header automatically when calling
 * new WebSocket("ws://...")
 */
function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("Upgrade")?.toLowerCase() == "websocket";
}

/**
 * Returns the least-bad anonymous key available before account support exists.
 *
 * Cloudflare sets CF-Connecting-IP at its edge. It is intentionally used only
 * for a coarse abuse limit: shared NATs can contain several legitimate players,
 * so the limits below remain generous and are not an identity system.
 */
function anonymousRequesterKey(
  request: Request,
  endpoint: SessionEndpoint,
): string {
  const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
  return `${endpoint}:${clientIp}`;
}

/**
 * Stops abusive HTTP/upgrade traffic before it can create or wake a session DO.
 */
async function enforceRequestRateLimit(
  request: Request,
  route: SessionRoute,
  env: Env,
): Promise<Response | null> {
  const isHostCreation = route.endpoint === "host_socket";
  const limiter = isHostCreation
    ? env.HOST_CREATION_LIMIT
    : env.SESSION_REQUEST_LIMIT;
  const outcome = await limiter.limit({
    key: anonymousRequesterKey(request, route.endpoint),
  });

  if (outcome.success) {
    return null;
  }

  console.warn(
    JSON.stringify({
      event: "request_rate_limited",
      endpoint: route.endpoint,
    }),
  );

  return Response.json(
    { error: "Too many session requests. Please wait a moment and try again." },
    {
      status: 429,
      headers: { "Retry-After": isHostCreation ? "60" : "10" },
    },
  );
}

/**
 * Narrows an unknown parsed JSON value to a non-array object.
 *
 * `JSON.parse()` returns `unknown` in principle: never trust a client to send
 * the shape our TypeScript types expect.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses one allowed client-to-server signaling message.
 *
 * Returning null means the message was malformed, too large, binary, or used
 * a message type this service does not support.
 */
function parseSignalingMessage(
  rawMessage: string | ArrayBuffer,
): SignalingMessage | null {
  // Our protocol is JSON text. Binary WebSocket frames are not part of it
  if (
    typeof rawMessage !== "string" ||
    rawMessage.length > MAX_SIGNALING_MESSAGE_LENGTH
  ) {
    return null;
  }

  let decoded: unknown;

  try {
    decoded = JSON.parse(rawMessage);
  } catch {
    // Invalid JSON is an ordinary client/protocol error, not a Worker crash
    return null;
  }

  if (!isRecord(decoded) || !isRecord(decoded.payload)) {
    return null;
  }

  if (
    decoded.type !== "offer" &&
    decoded.type !== "answer" &&
    decoded.type !== "ice_candidate"
  ) {
    return null;
  }

  // Rebuild the object from known fields. Extra user-supplied fields are dropped.
  return {
    type: decoded.type,
    payload: decoded.payload,
  };
}

/**
 * One instance of this class coordination one named session.
 *
 * For example, every request for 7K2QX9 reaches the same logical
 * SignalSession Durable Object.
 */
export class SignalSession extends DurableObject<Env> {
  /**
   * Finds the currently connected socket for a role, if it exists.
   *
   * Socket attachments remain available across Durable Object hibernation,
   * unlike normal JavaScript class fields.
   */
  private socketForRole(role: ConnectionRole): WebSocket | null {
    const socket = this.ctx.getWebSockets().find((candidate) => {
      const attachment =
        candidate.deserializeAttachment() as ConnectionAttachment | null;

      return attachment?.role === role;
    });

    return socket ?? null;
  }

  // Small readability helpers for session rules and status output.
  private hostIsConnected(): boolean {
    return this.socketForRole("host") !== null;
  }

  private clientIsConnected(): boolean {
    return this.socketForRole("client") !== null;
  }

  /**
   * Reads the durable attachment belonging to one accepted socket.
   *
   * Every accepted socket should have one. The null guard prevents malformed
   * or future code paths from being treated as a valid player.
   */
  private attachmentForSocket(socket: WebSocket): ConnectionAttachment | null {
    return socket.deserializeAttachment() as ConnectionAttachment | null;
  }

  /**
   * Sends a compact, machine-readable protocol error to one player.
   *
   * This is useful later: Godot can map `signal_rejected` to an understandable
   * UI state instead of treating every failure as a generic disconnect.
   */
  private sendSignalRejected(socket: WebSocket, reason: string): void {
    socket.send(
      JSON.stringify({
        type: "signal_rejected",
        reason,
      }),
    );
  }

  /**
   * Records one signaling frame against a socket-local time window.
   *
   * The updated attachment survives Durable Object hibernation, unlike a class
   * property. Returning false means the caller must stop accepting frames.
   */
  private consumeSignalingQuota(
    socket: WebSocket,
    attachment: ConnectionAttachment,
  ): boolean {
    const now = Date.now();
    const windowExpired =
      now - attachment.signalWindowStartedAt >= SIGNALING_WINDOW_MS;
    const nextAttachment: ConnectionAttachment = windowExpired
      ? {
          ...attachment,
          signalWindowStartedAt: now,
          signalsInWindow: 1,
        }
      : {
          ...attachment,
          signalsInWindow: attachment.signalsInWindow + 1,
        };

    if (nextAttachment.signalsInWindow > MAX_SIGNALING_MESSAGES_PER_WINDOW) {
      return false;
    }

    socket.serializeAttachment(nextAttachment);
    return true;
  }

  /** Sends a machine-readable error and closes a socket that violated policy. */
  private rejectAndClose(socket: WebSocket, reason: string): void {
    this.sendSignalRejected(socket, reason);
    socket.close(1008, reason);
  }

  /**
   * Handles requests that the public Worker has already validated and routed
   * to this one session's Durable Object.
   */
  async fetch(request: Request): Promise<Response> {
    // The original request URL is still available after Worker forwarding.
    const url = new URL(request.url);
    const route = sessionRouteFromPath(url.pathname);

    // The Worker should prevent this, but DO validates again to remain safe
    if (route === null) {
      return new Response("Not found", { status: 404 });
    }

    // This is a normal HTTP request, used to inspect the session while we
    // build the connection flow.
    if (route.endpoint == "status") {
      return Response.json({
        session_code: route.sessionCode,
        host_connected: this.hostIsConnected(),
        client_connected: this.clientIsConnected(),
      });
    }

    // The /host endpoint must be a WebSocket upgrade request.
    if (!isWebSocketUpgrade(request)) {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    // A joiner may only enter a live session. This avoids creating a
    // client-only room when someone mistypes or uses an expired code.
    if (route.endpoint == "join_socket" && !this.hostIsConnected()) {
      return Response.json(
        { error: "No live host exists for this session." },
        { status: 409 },
      );
    }

    // One host and one joiner is the current two-player MVP limit
    if (route.endpoint === "host_socket" && this.hostIsConnected()) {
      return Response.json(
        { error: "A host is already connected to this session." },
        { status: 409 },
      );
    }
    if (route.endpoint === "join_socket" && this.clientIsConnected()) {
      return Response.json(
        { error: "A client is already connected to this session." },
        { status: 409 },
      );
    }

    // Choose the durable role before creating the socket pair.
    const role: ConnectionRole =
      route.endpoint === "host_socket" ? "host" : "client";

    // A WebSocketPair has two ends:
    //
    // - client: returned to the browser
    // - server: owned by this Durable Object
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // This hibernation-aware API means an idle DO need not stay in memory
    // just because its WebSockets remain connected.
    this.ctx.acceptWebSocket(server);

    // Remember the role on the socket itself, so it survives hibernation
    server.serializeAttachment({
      // Store the role selected from the /host or /join route.
      role,
      sessionCode: route.sessionCode,
      connectedAt: Date.now(),
      signalWindowStartedAt: Date.now(),
      signalsInWindow: 0,
    } satisfies ConnectionAttachment);

    if (role === "host") {
      // The host receives confirmation that its session now exists.
      server.send(
        JSON.stringify({
          type: "host_connected",
          session_code: route.sessionCode,
        }),
      );
    } else {
      // The joiner is now attached to this session's coordinator.
      server.send(
        JSON.stringify({
          type: "client_connected",
          session_code: route.sessionCode,
        }),
      );

      // Tell the already-connected host that a second player arrived.
      // This is a lifecycle notification, not WebRTC signaling yet.
      this.socketForRole("host")?.send(
        JSON.stringify({
          type: "client_joined",
          session_code: route.sessionCode,
        }),
      );
    }

    // HTTP 101 means "Switching Protocols": HTTP has become WebSocket.
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * Receives a signaling frame from one player and forwards it to the other.
   *
   * Because we used ctx.acceptWebSocket(), Cloudflare invokes this method even
   * after the Durable Object hibernates and wakes back up.
   */
  async webSocketMessage(
    socket: WebSocket,
    rawMessage: string | ArrayBuffer,
  ): Promise<void> {
    const sender = this.attachmentForSocket(socket);

    if (sender === null) {
      // This should be impossible for our accepted sockets, but do not
      // relay a message when we cannot identify its sender.
      socket.close(1008, "Socket has no session role.");
      return;
    }

    if (!this.consumeSignalingQuota(socket, sender)) {
      console.warn(
        JSON.stringify({ event: "signal_rate_limited", role: sender.role }),
      );
      this.rejectAndClose(
        socket,
        "Too many signaling messages. Please reconnect and try again.",
      );
      return;
    }

    const message = parseSignalingMessage(rawMessage);

    if (message === null) {
      console.warn(
        JSON.stringify({
          event: "signal_rejected",
          reason: "invalid_message",
          role: sender.role,
        }),
      );
      this.rejectAndClose(
        socket,
        "Expected a small JSON offer, answer, or ice_candidate message.",
      );
      return;
    }

    // We choose a deterministic negotiation policy:
    //
    // - host creates the offer
    // - joiner creates the answer
    // - either peer can discover and send ICE candidates
    if (sender.role === "host" && message.type === "answer") {
      console.warn(
        JSON.stringify({
          event: "signal_rejected",
          reason: "host_sent_answer",
          role: sender.role,
        }),
      );
      this.rejectAndClose(
        socket,
        "Only the joining client may send an answer.",
      );
      return;
    }

    if (sender.role === "client" && message.type === "offer") {
      console.warn(
        JSON.stringify({
          event: "signal_rejected",
          reason: "client_sent_offer",
          role: sender.role,
        }),
      );
      this.rejectAndClose(socket, "Only the host may send an offer.");
      return;
    }

    // Find the other peer at the instant this message is handled.
    const recipientRole: ConnectionRole =
      sender.role === "host" ? "client" : "host";
    const recipient = this.socketForRole(recipientRole);

    if (recipient === null) {
      this.sendSignalRejected(socket, "The other player is not connected.");
      return;
    }

    // The Worker (not the client) adds trustworthy sender identity.
    const relayedMessage: RelayedSignalingMessage = {
      ...message,
      from: sender.role,
    };

    recipient.send(JSON.stringify(relayedMessage));
  }

  /**
   * Restore the session lifecycle guarantees after a hibernating socket closes.
   * The attachment is the source of truth because ordinary class state does not
   * survive hibernation.
   */
  async webSocketClose(
    socket: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const departed = this.attachmentForSocket(socket);
    if (departed === null) {
      return;
    }

    const remainingRole: ConnectionRole =
      departed.role === "host" ? "client" : "host";
    const remaining = this.socketForRole(remainingRole);
    if (remaining === null) {
      return;
    }

    if (departed.role === "host") {
      remaining.close(CLOSE_HOST_DISCONNECTED, "host disconnected");
      return;
    }

    remaining.send(
      JSON.stringify({
        type: "client_left",
        session_code: departed.sessionCode,
      }),
    );
  }

  async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    const attachment = this.attachmentForSocket(socket);
    console.error(
      JSON.stringify({
        event: "socket_error",
        role: attachment?.role,
        error: String(error),
      }),
    );
    socket.close(1011, "socket error");
  }
}

/**
 * The default Worker is the public HTTP/WebSocket entrypoint.
 *
 * It validates paths, codes, methods, and WebSocket upgrades before a request
 * reaches a Durable Object. That avoids creating/billing DO work for junk input.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // A stateless health endpoint lets us distinguish "Worker is alive" from
    // "Durable Object routing works"
    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    const route = sessionRouteFromPath(url.pathname);

    // Unknown paths are not silently treated as sessions
    if (route === null) {
      return new Response("Not found", { status: 404 });
    }

    // Reject malformed codes before creating/routing to an object
    if (!SESSION_CODE_PATTERN.test(route.sessionCode)) {
      return Response.json(
        { error: "Session codes must be six unambiguous characters." },
        { status: 400 },
      );
    }

    // Both currently supported session routes are GET requests.
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Validate the costly WebSocket-upgrade shape before routing to the DO.
    if (route.endpoint !== "status" && !isWebSocketUpgrade(request)) {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const rateLimitResponse = await enforceRequestRateLimit(
      request,
      route,
      env,
    );
    if (rateLimitResponse !== null) {
      return rateLimitResponse;
    }

    // Same code -> same SignalSession DO.
    const session = env.SIGNAL.getByName(route.sessionCode);

    // The DO creates the socket pair and returns the browser-facing side.
    return session.fetch(request);
  },
} satisfies ExportedHandler<Env>;
