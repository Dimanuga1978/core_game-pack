# TableCore v2 — B21 Red-Team Audit #2

Date: 2026-08-28
Baseline: `tablecore-v2-b21-p0-p1-hardened-full-engine.zip`
Verdict: **NO-GO for production**

## Scope

- Core action execution and match lifecycle
- Deterministic RNG and replay
- ServerHost authoritative boundary
- Protocol and player/spectator authorization
- WebSocket framing, authentication, resource limits, shutdown
- Content/authoring/pack validation
- Pack trust/signature boundary
- Reference game mechanics
- Dependency architecture and separation

## Reference review

Reviewed current public implementations / documentation relevant to the attacked layers:

- boardgame.io — authoritative Master, auth hook, transport/storage separation, sync/update flow.
- Bevy — explicit systems/resources/schedules and change detection; used as an architectural comparison, not a dependency target.
- Godot — multiplayer/server-authoritative boundaries and dedicated-server/runtime separation.
- openage — explicit separation of simulation, networking, game-data database and presentation.
- Valve GameNetworkingSockets — robust framing/fragmentation, message limits, encryption and statistics as transport concerns.
- Colyseus — Room/connection/session separation, reconnection token and state/message separation.
- Nakama — authentication/session model and authoritative match lifecycle.
- Tiled — editor/data model, hex maps and undo/selection robustness.

## Confirmed adversarial findings

### P1-1 — RNG seed still leaks through `GameState`

`ServerHost.getSnapshot()` strips `match.seed` and `match.rngState`, but `games/sector-expedition/src/game.js` stores `seed` inside the public `state` at creation. Therefore `getSnapshot(...).snapshot.state.seed` reveals it.

Reproduction:

```text
ServerHost.createMatch(seed=0x12345678)
startMatch()
getSnapshot('m','A').snapshot.state.seed
=> 0x12345678
```

Impact:
- future random outcomes may become predictable;
- client can correlate replay/RNG behavior;
- violates the intended "server-private RNG" contract.

Reference comparison: authoritative servers in boardgame.io/Nakama treat server-side match state separately from credential/session data; RNG secrets are not a presentation concern.

Required remediation: remove secret RNG material from authoritative game-visible state, or provide a game capability that marks specific state fields private and guarantees projection removes them.

### P1-2 — Spectator authorization is not fail-closed

`packages/protocol/src/index.js` allows a spectator to `SYNC_REQUEST` any match when `connection.allowedMatches` is absent. The participant check applies only to `role === 'player'`.

Reproduction:

```text
connection = { role: 'spectator', playerId: null }
SYNC_REQUEST(private-match)
=> SYNC
```

Impact:
- any authenticated spectator token can enumerate known match IDs and receive state;
- if spectator views are full/public, this is an information-disclosure boundary.

Required remediation: make match access explicit for spectators (`public=true` or an ACL). Default must be deny.

### P1-3 — Events are not viewer-projected

`buildUpdate()` projects the snapshot for the receiving connection but copies `events` verbatim. A Game Pack can therefore emit private event payloads that are revealed to every subscribed player.

Reproduction used a Game Pack whose event contained `privateInfo='SECRET-A'`; the B-view `UPDATE` retained that value.

Impact:
- hidden-information leakage;
- private cards/resources/choices can escape even though `getPlayerView()` correctly hides state.

Required remediation: introduce `game.getPlayerEventView(event, viewer, state)` or an equivalent event-privacy contract. Events must be projected per recipient, not just snapshots.

Reference comparison: boardgame.io transport data is transformed for each individual player; Colyseus separates state synchronization from message handling and makes per-room state explicit.

### P1-4 — Authentication timeout is disabled after HTTP upgrade

`AUTH_TIMEOUT_MS` exists but is unused. The socket has a timeout before upgrade, then `socket.setTimeout(0)` immediately after upgrade. A peer can therefore complete WebSocket upgrade and never send `HELLO`, retaining a socket indefinitely.

Impact:
- unauthenticated connection exhaustion / low-cost resource DoS.

Required remediation: arm a dedicated authentication timer after `101 Switching Protocols`, clear it only after verified HELLO; additionally cap unauthenticated concurrent sockets separately from authenticated `maxClients`.

### P1-5 — Ping/control-frame floods bypass the message rate limiter

Rate limiting is applied only after `item.control` handling. Ping frames increment metrics and receive pong responses without consuming the limiter budget.

Impact:
- CPU and bandwidth amplification;
- large numbers of control frames can bypass the application message limit.

Required remediation: separate rate/budget accounting for control frames, bytes, and application messages; preferably use token buckets or leaky buckets with connection + IP/global budgets.

### P1-6 — Replay is not valid for mid-match RNG continuation

`playReplay()` always creates RNG from `replay.seed`, even when `replay.initialState` represents a mid-match state containing a previously advanced RNG state.

Reproduction:

```text
initialState.rngState = 999
replay.seed = 123
playReplay(...)
=> rng starts at 123, not 999
```

Impact:
- replay divergence;
- bug reports from resumed matches cannot be reproduced reliably;
- dangerous for deterministic audit trails.

Required remediation: replay format must include explicit simulation/RNG checkpoint state; replay runner must use it when provided.

### P1-7 — Public WebSocket API still has no explicit match/session ACL model

`allowedMatches` is optional and injected ad hoc through `resolveConnection`. This is too easy to misconfigure. Security-sensitive authorization currently depends on an optional property being present.

Required remediation: make authorization policy mandatory at the protocol boundary and return explicit `ALLOW/DENY` decisions. Default deny.

## P1-8 — Graceful shutdown is not actually graceful

`close()` writes a WebSocket Close frame and then immediately destroys sockets. It does not wait for peer close acknowledgement, drain outgoing buffers, or distinguish active connection drain from hard termination.

Impact:
- clients can lose final updates;
- in-flight state publication can be interrupted;
- shutdown semantics are weaker than claimed.

Reference comparison: mature networking stacks separate close signaling, drain and final termination; GameNetworkingSockets exposes explicit connection state and detailed stats.

Required remediation: implement close state machine: stop accepting → stop new actions → send close → drain with deadline → destroy remaining sockets → close listener.

## P1-9 — WebSocket backpressure is ignored

All sends use `socket.write()` without checking the return value or waiting for `drain`.

Impact:
- slow spectators/clients can create unbounded kernel/userland buffering;
- a single slow receiver can consume memory during broadcast-heavy matches.

Required remediation: per-connection bounded outbound queue + byte budget + backpressure policy; drop/coalesce spectator updates if safe, or terminate slow clients with a defined close code.

Reference comparison: Valve GameNetworkingSockets explicitly treats bandwidth, lanes and queueing as first-class transport concerns.

## P1-10 — Unauthenticated sockets are not bounded by `maxClients`

`maxClients` is checked only after token verification and connection object creation. An attacker can open many upgraded-but-unauthed sockets, subject to process/OS limits.

Required remediation: separate `maxPendingAuthConnections`, ideally per IP and globally, with authentication timeout and admission control.

## P1-11 — Pack signature authenticates a descriptor, not the actual package bytes

`verifyTrustedPackDescriptor()` signs/verifies the canonical descriptor. `readAndVerifyTrustedPack()` reads a descriptor file, but there is no enforcement that the executable pack files/assets exactly match a signed archive/content hash.

Impact:
- a signed descriptor can remain valid while package contents are changed if the content hash itself is not independently computed and checked against actual bytes;
- signature policy is therefore not yet a complete supply-chain trust boundary.

Required remediation: sign a manifest that includes immutable hashes of every pack file (or a Merkle root/archive digest) and verify those bytes before installation/load.

## P1-12 — Trusted pack capabilities are policy-declared but not enforced by a runtime capability sandbox

The trust layer checks declared capabilities against a trust-store allowlist, but there is no runtime capability broker/sandbox in this codebase. A trusted executable Game Pack still has normal JS process privileges when imported by an application.

Impact:
- a trusted third-party pack remains arbitrary code execution by design;
- signature means "trusted signer", not "safe capability isolation".

Required remediation: separate the static/content-only pack format from executable packs. Default marketplace/installed packs should be data-only; executable code should run in a constrained worker/process with an explicit API surface if ever supported.

Reference comparison: openage separates scripting/data from core simulation; Tiled treats extensions/plugins as a separate trust boundary; this strongly argues for not equating signed content with sandboxed code.

## P1-13 — `startMatch()` permits caller context to override protected initialization inputs

`startMatch()` calls:

```js
createInitialState({ players: match.players, ...match.options, ...context })
```

so `context.players` can override authoritative match participants, and `context.seed` can override the state's seed while the Match RNG still uses `match.seed`.

Impact:
- state/player identity mismatch;
- deterministic state/RNG divergence;
- hard-to-debug security bugs when integrating new hosts/tools.

Required remediation: never spread untrusted/ambient context over reserved authoritative fields. Use a namespaced `context.game` or explicit allowlist.

## P1-14 — Match participant validation is incomplete at creation

`createMatch()` accepts duplicate, empty, non-string or otherwise malformed player IDs. This weakens every downstream assumption that participants are unique stable identities.

Required remediation: canonical player-ID schema, uniqueness, maximum count and normalization at match creation.

## P1-15 — Reference Grid Duel ignores match participants

`games/grid-duel/src/game.js` hard-codes players `A` and `B`, while the Match Lifecycle supplies arbitrary `match.players`.

This caused a direct contract mismatch: a match created for `X/Y` cannot be coherently played by its authorized participants.

Impact:
- Pack Contract does not actually guarantee participant injection;
- a second Game Pack can silently violate authoritative identity assumptions.

Required remediation: strengthen Game Pack contract with a standardized `players` input/result contract and add contract tests that instantiate every pack with non-default player IDs.

## P2 findings

- Unbounded `match.events` growth; events accumulate forever.
- Broadcast target lookup is O(N) inside an O(N) client loop.
- No global/IP byte/message budget.
- No protocol field-size schema beyond coarse frame/message caps.
- No durable match/session persistence.
- No replay format version/schema migration policy beyond `gameVersion`.
- Client session accepts `UPDATE` at equal version without checking `previousVersion`, allowing semantic overwrite if transport/order bugs occur.
- Token auth has no revocation/session ID/audience and is bearer-replayable until expiry.
- TLS support is configuration-based, but there is no hardened deployment policy (minimum TLS/ciphers, proxy headers, certificate rotation, etc.).
- Authoring Studio browser code still maintains its own lightweight validation/rendering logic instead of calling the SDK mutation/validation path for every UI operation.

## Positive findings

The audit also confirms that several important boundaries are now sound:

- no dependency cycles were found in the JavaScript import graph;
- `runAction()` clones state and fails closed on contract violations/rejections;
- actor spoofing is blocked at ServerHost;
- ClientSession is match-bound;
- player-state projection works for the tested Sector Expedition case;
- RFC-style 16/64-bit lengths and message fragmentation are implemented and tested;
- default linter path does not execute arbitrary pack JS;
- signature verification uses Ed25519 and capability allowlists;
- Content/Authoring/Presentation remain architecturally separated from Core.

## Final verdict

**B21 is still NO-GO for production.**

The most important next hardening pass should not add new game features. It should close the newly confirmed P1 set in this order:

1. private RNG + private event projection;
2. spectator/match ACL and mandatory authorization policy;
3. post-upgrade authentication timeout + pending-auth limits;
4. control-frame/byte/IP rate limiting + outbound backpressure;
5. replay checkpoint/RNG correctness;
6. strict Match/Game Pack participant contract;
7. context namespace / protected initialization fields;
8. complete pack-byte integrity/signature verification and executable-pack isolation;
9. graceful shutdown state machine.
