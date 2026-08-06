This issue covers an MVP implementation for networked multiplayer. The goal is peer-hosted, host-authoritative two-player multiplayer.

A player hosts from the Multiplayer menu and immediately starts/continues a solo session. They receive a six-character join code. A second player enters that code to establish a WebRTC connection and spawn into the host's session.

This requires code running outside the game and I considered a Go backend on a VM at first, but I think I'd rather explore the Cloudflare stack with this. That's a Cloudflare Worker for serverless compute, Durable Objects for session storage, and should we want it, they have a managed TURN service.

Hosting stuff costs money but Cloudflare is famous for their generous [free tier](https://www.cloudflare.com/plans/#developer-platform/compute) and even moderate success is within the limits.

## Architecture

- Game client: Godot Web export
- Control plane: Cloudflare Worker + one Durable Object per session code.
- Signaling: browser/Godot clients connect to the Worker over WSS; the Worker forwards WebRTC offer/answer/ICE messages between the two players.
- Game traffic: direct WebRTC connection between host and client.
- NAT traversal: STUN enabled.
- Authority: host simulates the game; client sends input and receives authoritative state/snapshots.
- State storage: ephemeral/in-memory only. No accounts or database.

## Player flow

1. Host selects Multiplayer.
2. Game creates a session and shows a six-character code.
3. Client selects Join Game and enters/pastes the code.
4. Client sees real connection stages: code accepted, establishing peer route, syncing world state, spawning.
5. Host selects a safe spawn point and spawns the client.
6. Both players see the other player, nameplate, and disconnect state.

## Acceptance criteria

- Two players on separate networks can host and join via a code.
- Game traffic uses WebRTC; signaling does not carry gameplay snapshots.
- The host remains authoritative for player/world state.
- The client cannot control the host or another player.
- The host can play while waiting for a second player.
- Host disconnect ends the session; client receives a useful error/return path.
- Failed/invalid/expired codes and failed peer connections have useful UI states.
- Test passes using two real browsers on separate networks.

## Out of scope for MVP

- TURN relay fallback / guaranteed connectivity through restrictive NAT or CGNAT.
- Public matchmaking / lobby browser.
- Accounts, friends, invites, persistence, reconnection.
- Voice chat.
- Dedicated game servers.
- More than two players.
