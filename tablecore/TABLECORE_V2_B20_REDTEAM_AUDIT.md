# TableCore v2 — B20 Red-Team Technical Audit

Date: 2026-08-28
Scope: `tablecore-v2-b20-rules-editor-full-engine.zip`
Baseline SHA-256: `6e0e0610d3f7377abab4cc7a5c1eee754eebb26e8ff5137fd3f3a7c102fe2cdc`

## Executive verdict

**RELEASE STATUS: NO-GO.**

The codebase is a strong architectural prototype, but it is not yet safe to expose as a real multiplayer server or as a mechanism for installing third-party Game Packs. The current test suite is green (84/84), but adversarial testing uncovered multiple trust-boundary failures and several correctness gaps that the current tests do not exercise.

The biggest problems are:

- **P0 — WebSocket identity is unauthenticated.** The current server can derive player identity directly from the client's first `HELLO` message. A remote client can therefore impersonate a legitimate player.
- **P0 — External pack linting/import is not sandboxed.** The CLI dynamically imports a pack module, which executes arbitrary JavaScript before validation. For an external pack ecosystem this is arbitrary code execution by design.
- **P1 — Game action acceptance is semantically unsafe.** `runAction()` validates only the action type returned by `getLegalActions()`. A Game Pack that lacks `validateAction()` can return an `ACTION_REJECTED` event from `applyAction()` and still be treated by the engine as `ok: true`.
- **P1 — Server snapshots expose the match seed to clients.** For hidden-information/random-event games, this can reveal future RNG outcomes or make them predictable.
- **P1 — ClientSession has no match identity boundary.** A higher-version SYNC/UPDATE for another match can replace the client's current snapshot.
- **P1 — Custom WebSocket implementation is incomplete as a production WebSocket implementation.** It ignores opcodes/control frames/fragmentation requirements, permits unmasked client frames, has unbounded handshake/buffer growth, and has no message-size/backpressure policy beyond a 64 KiB frame threshold.
- **P1 — Authoring Tool and Authoring Studio produce different entity shapes.** One writes fields under `fields`, the other spreads `initial` into the entity. This can silently create incompatible authoring data.
- **P1 — Authoring schemas are not enforced against authored field values.** Editor operations can write values that violate the declared field type/range/ref contract; validation is mostly structural.
- **P1 — Content linting is incomplete as a pack trust boundary.** It checks some references but does not establish a complete schema/type/semantic contract between content and authoring definitions.
- **P2 — Match lifecycle is in-memory only.** Process restart loses matches and reconnect state.
- **P2 — Replay format contains only actions plus seed/state, but does not bind to an executable game implementation or verify compatibility beyond a free-form `gameVersion` string.
- **P2 — No bounded action/event history, connection rate limits, observability, or backpressure controls are present.**

## Verification performed

### Baseline tests

`npm test` completed successfully:

- 84 tests passed
- 0 failed
- 0 skipped

All JavaScript files passed `node --check`.

The test count is useful, but it is **not evidence of security or production readiness**. Most tests are functional happy-path tests and do not model malicious clients, malformed protocol frames, untrusted packs, or pathological resource usage.

### Dynamic adversarial probes

Confirmed directly against the current code:

1. **Player impersonation succeeds**: a connection object declaring `{ role: 'player', playerId: 'A' }` receives SYNC and can submit an ACTION as A. This is expected from the current trust model, but it is a release-blocking flaw if the WebSocket layer is exposed to untrusted clients.
2. **Seed is exposed**: `ServerHost.getSnapshot()` includes `seed` in the public snapshot.
3. **Cross-match snapshot replacement succeeds at the client-session layer**: a `ClientSession` accepted a SYNC for `m2` after holding `m1`, solely because the incoming version was higher.
4. **Grid Duel accepts malformed MOVE payloads through `runAction()`**: a `MOVE` without a valid direction is returned as `ok: true` with an `ACTION_REJECTED` event because `gridDuel` does not implement `validateAction()` and `runAction()` only checks the action type.

## Detailed findings

### P0-1 — Unauthenticated player identity / actor impersonation

**Location:** `packages/transport-ws/src/index.js`, `packages/protocol/src/index.js`

The WebSocket server creates a connection using `resolveConnection(f.value)` on the first application frame. The example test resolver maps the client-provided `playerId` directly to a player identity. There is no proof that the client owns that identity.

The subsequent server authorization is internally consistent but starts from an untrusted identity:

`connectionPlayerId -> actor -> ServerHost membership check`

Therefore the chain proves only that the client is consistent with its own claim.

**Impact:** account/player impersonation, unauthorized actions, state access.

**Required fix:** authenticated handshake/session token, server-side identity resolution, credential validation before a connection becomes a player, and separation of authentication identity from requested seat/role.

This is materially different from the authoritative-state property itself: authoritative simulation does not protect an unauthenticated identity boundary.

Nakama's match registry and Colyseus room model both treat a joined connection as a server-side session/presence with explicit join/reconnect semantics, rather than trusting an arbitrary player ID embedded in an application message. citeturn782124search0turn147735search2turn147735search4

### P0-2 — Untrusted Game Pack import is code execution

**Location:** `tools/tablecore-pack-lint.js`

The linter does:

`await import(pathToFileURL(resolve(process.cwd(), moduleArg)).href)`

This means a pack is executed before it is linted.

For first-party packs this is acceptable as a developer tool. For the planned external Game Pack ecosystem it becomes a direct code-execution surface. A malicious pack can run arbitrary Node code during "validation".

**Impact:** host compromise of any machine used to inspect/install an untrusted pack.

**Required fix:** define a trust model before external packs are supported. Options include:

- signed/trusted developer packs only;
- declarative packaged content separated from executable runtime modules;
- isolated worker/process/container execution with strict filesystem/network permissions;
- manifest allowlist and capability model.

This needs to be resolved before a Pack Manager is allowed to auto-discover/install arbitrary packs.

### P1-1 — `runAction()` can accept a rejected game action

**Location:** `packages/core/src/runAction.js:4-16`

The current logic checks only whether an action **type** appears in `getLegalActions()`:

`legal.some(a => a.type === action.type)`

If the pack does not implement `validateAction()`, `applyAction()` can reject an action and return an `ACTION_REJECTED` event, but `runAction()` still returns `ok: true`.

We reproduced this with Grid Duel:

- `MOVE` with no direction → `ok: true`
- `MOVE` with `direction: BAD` → `ok: true`
- `ATTACK` without adjacency → `ok: true`

The state was not mutated in these specific cases, but the engine reports success and the match layer can increment version/history based on a rejected operation.

**Required fix:** make rejection explicit in the core contract. `applyAction()` must either be guaranteed never to reject after validation or return a discriminated result (`ok:false`) that the core recognizes. Do not encode rejection only as an ordinary game event.

boardgame.io's master path performs action processing in the authoritative core and treats the state transition/logging machinery as part of the authoritative operation, which is a stronger semantic boundary than the current type-only pre-check. citeturn815076search6turn815076search3

### P1-2 — Public seed disclosure

**Location:** `packages/server/src/ServerHost.js:27-31`

`getSnapshot()` returns `seed` to viewers.

For a game whose random outcomes are generated deterministically from that seed, a client that knows the rules and observed actions can potentially predict future random events. This is especially problematic for hidden information or random outcomes intended to remain uncertain.

**Required fix:** seed is server-authoritative/private by default. Public snapshots should expose only a public match identifier/version and, if needed, a non-predictive commitment/hash. Replays may contain the seed but must not expose it to live players unless the game explicitly opts in.

### P1-3 — `ClientSession` lacks a match binding

**Location:** `packages/protocol/src/index.js:35-40` (ClientSession receive path)

The client compares only snapshot version. It does not bind the session to `matchId`.

A higher-version snapshot from another match is accepted and replaces the current snapshot.

**Impact:** stale/wrong-match UI state, cross-match confusion, unsafe reconnect behavior.

**Required fix:** maintain an explicit `currentMatchId`; reject or reset on match changes using a controlled transition. Every `SYNC`/`UPDATE` must be validated against that identity.

### P1-4 — Custom WebSocket framing is not production-complete

**Location:** `packages/transport-ws/src/index.js`

The current implementation is a small test transport, not a complete WebSocket implementation.

Problems:

- frame opcode is ignored;
- ping/pong/close control frames are not implemented;
- continuation/fragmentation is not implemented;
- server accepts unmasked client frames even though browser clients are required to mask;
- handshake validation does not verify method/Upgrade/Connection/version semantics;
- handshake header accumulation is unbounded;
- receive buffer can grow without a hard cap;
- malformed JSON/frame state destroys the socket rather than producing controlled protocol errors;
- no heartbeat/idle timeout;
- no outbound queue/backpressure policy;
- no connection/message rate limiting;
- no TLS boundary in the transport itself;
- maximum payload is tied to one frame and therefore does not define a protocol-level message limit.

Colyseus and Valve's GameNetworkingSockets show a much more explicit separation between connection lifecycle, message framing, reconnection, and transport concerns. Valve additionally treats encryption/authentication as transport-level concerns for a real game networking stack. citeturn147735search1turn147735search10turn782124search1turn782124search2

**Recommendation:** use a maintained WebSocket implementation for production rather than expanding this hand-rolled parser, or isolate the current implementation as a test-only transport.

### P1-5 — Authoring Tool shape mismatch

`tools/authoring/index.js:createEntity()` creates:

`{ type, ...initial }`

while `packages/authoring-studio/src/index.js:create()` creates:

`{ type, fields: {...} }`

The two authoring tools can therefore emit structurally different entities for the same logical schema.

**Impact:** silent incompatibility between headless tooling and GUI tooling.

**Required fix:** define one canonical authoring entity envelope and use the same SDK mutation functions from both tools. Direct mutation of bundle internals should be prohibited.

### P1-6 — Schema type enforcement is incomplete

Authoring SDK validates schema declarations but does not fully validate authored values against those declarations. `setField()` locates a declared field, then stores any cloneable value.

For example a field declared `integer` can receive a string/object through the model API unless a later lint catches it; range, enum membership, requiredness and ref existence are not enforced at mutation time.

**Required fix:** centralize `validateValueAgainstFieldSchema()` and call it from mutation, load, lint and export paths. The GUI should never need its own coercion/validation logic.

### P1-7 — Content/authoring schema linkage is incomplete

The linter validates that some map object/terrain references exist, but it does not prove that a content entity conforms to the authoring schema chosen by its `type`, nor that all declared refs resolve according to the declared target group.

This makes "validated" authoring data weaker than the name suggests.

**Required fix:** establish a canonical content-definition schema and perform full graph validation before pack readiness.

### P2-1 — In-memory-only match registry

A process restart loses all matches. Reconnect currently means reconnecting to a still-live in-memory process.

Nakama and Colyseus explicitly model room/match disposal, reconnection and shutdown/resource cleanup. Nakama's registry has explicit stop semantics and controlled match removal. citeturn782124search0turn782124search5turn147735search4

This is acceptable for the prototype, not for a production server.

### P2-2 — Replay compatibility is weak

`Replay.gameVersion` is metadata, not a binding to an actual executable game implementation/version hash. A replay can be fed to a different implementation that happens to accept the same actions.

**Required fix:** record pack ID, pack version, ruleset/content hash, protocol/runtime compatibility, RNG algorithm/version and optionally a canonical initial-state hash.

### P2-3 — No bounded history/observability

Match events grow indefinitely in memory. There is no cap, persistence policy, metrics, structured logging, action latency tracking, per-match resource accounting, or connection budget.

Nakama's registry tracks active authoritative match counts and its match handler has explicit stop/cleanup semantics; that is a useful reference for the operational layer we currently lack. citeturn782124search0turn782124search5

### P2-4 — Phase flow callbacks are executable code inside a supposedly declarative capability

`createFlow()` accepts `endIf` and `next` functions. This is not inherently wrong for first-party code, but it means the flow model is not actually data-only and cannot be safely serialized/edited by the Rules Editor.

**Required fix:** either mark flow as executable Game Pack code and keep it out of the declarative Rules Editor, or create a truly declarative flow AST.

## Architecture assessment

### Strong points

- Clear separation between simulation and presentation.
- Authoritative server model is conceptually correct.
- Content, authoring, runtime and transport are separate packages.
- Player-specific views are already considered.
- Deterministic RNG exists and is serialized in the live match.
- Replay and bot simulation are first-class concepts.
- The codebase remains small enough to refactor now.

openage's current architecture is a good confirmation of the value of keeping simulation, networking, rendering/presentation, data conversion and utilities as separate subsystems. citeturn815076search0turn815076search7

### Weak points

- Trust boundaries are not yet first-class architectural objects.
- Protocol schemas are still informal JavaScript object checks rather than a single canonical schema/decoder layer.
- Game Pack runtime code and declarative content are not fully separated for the external-pack use case.
- The hand-written WebSocket layer is too low-level for its current test coverage.
- Authoring currently has multiple mutation paths and therefore multiple opportunities to diverge.
- The engine has good deterministic primitives but insufficient determinism metadata/versioning.

Bevy's explicit system ordering is a useful reminder that once more subsystems are introduced, ordering and lifecycle relationships should be explicit rather than inferred from call order. citeturn815076search4

## Reference-project comparison

| Concern | Reference evidence | B20 assessment |
|---|---|---|
| Authoritative turn-based core | boardgame.io Master/Core | **Conceptually good; validation contract too weak** |
| Simulation/data separation | openage | **Good** |
| System/lifecycle ordering | Bevy | **Good direction, not formalized enough yet** |
| Server lifecycle/shutdown | Nakama | **Missing operational layer** |
| Room/reconnect semantics | Colyseus | **Prototype-level only** |
| Transport/security | Valve GNS / Gaffer principles | **Clearly prototype-level** |
| Authoring/data pipeline | openage + Godot Resource/Inspector patterns | **Good direction, schema enforcement incomplete** |

## Release decision

**NO-GO for:**

- public Internet multiplayer;
- trusted identity/account play;
- third-party Game Pack installation;
- auto-install/auto-lint of untrusted packs;
- production persistence/reconnect guarantees.

**OK for:**

- architecture prototyping;
- local testing;
- first-party trusted development;
- continued engine design and hardening.

## Recommended remediation order

### P0 — must fix before further feature work

1. Authenticated connection identity / seat binding.
2. Remove live seed from public snapshots.
3. Decide external pack trust model and sandbox boundary.
4. Make `Action` acceptance a single, unambiguous core contract.

### P1 — next hardening pass

5. Replace or quarantine hand-written WebSocket framing.
6. Bind ClientSession to match identity.
7. Canonicalize authoring mutations through one SDK.
8. Enforce schema values and references end-to-end.
9. Add protocol schema validation and message size limits.

### P2 — production hardening

10. Persistence and graceful shutdown.
11. Replay compatibility hashes.
12. Event/history bounds.
13. Metrics, logs, rate limits and resource budgets.
14. Declarative vs executable flow distinction.

## Final verdict

The architectural direction is **good enough to continue**, but the current B20 implementation should be treated as a **development prototype, not a production-capable engine**.

The most important positive observation from this audit is that the problems are still localized. We do **not** need a wholesale rewrite. The correct move is a focused security/correctness hardening stage before B21: establish trust boundaries, fix action semantics, close the pack-execution hole, and harden transport/session identity.
