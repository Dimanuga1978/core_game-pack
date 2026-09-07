# TableCore v2 — External Audit Handoff

## Candidate
B23 Performance Hardened

## Purpose
Independent hostile review of a small authoritative turn-based multiplayer engine and its authoring/content tooling.

## Audit scope
- deterministic simulation and RNG ownership
- action validation / fail-closed semantics
- replay correctness
- match lifecycle
- authoritative server boundaries
- authentication and actor binding
- protocol validation
- WebSocket RFC 6455 framing and resource limits
- spectator/player authorization
- per-view state and event privacy
- Game Pack trust/signature policy
- Content and Authoring schemas
- Map/Rules/Authoring editors
- performance regressions and allocation hotspots
- dependency boundaries and cyclic imports

## Known security model
Signed third-party pack descriptors are accepted only through a configured trust store and capability policy. Executable third-party Game Packs are NOT considered sandboxed merely by signature; process/OS isolation is outside this candidate's trust boundary.

## Reproducibility
Environment requires Node.js with native `structuredClone` and ES module support.

Run the full suite:

    npm test

Run the focused performance benchmark:

    node tools/performance/benchmark.mjs

Run syntax checks (example):

    node --check packages/core/src/runAction.js

## Expected baseline
- npm test: 109 passing, 0 failing
- benchmark: optimized path should be materially faster than the legacy comparison path

## Auditor should actively attempt
1. Actor/session spoofing and seat confusion.
2. Cross-match reads/writes.
3. Private state/event disclosure.
4. Replay divergence and RNG checkpoint misuse.
5. Malformed/oversized/fragmented WebSocket frames.
6. Control-frame and connection exhaustion attacks.
7. Game Pack signature bypass and descriptor/content mismatch.
8. Authoring schema bypasses.
9. Mutation of input state through Game Pack APIs.
10. Infinite or pathological action loops.
11. Memory growth from histories, snapshots, buffers, and sessions.
12. Performance collapse from cloning/projection/serialization.
13. Error-path state corruption.
14. Reconnect races and stale-version handling.

## Reference implementations to use as comparison points
boardgame.io, Bevy, Godot, openage, Colyseus, Nakama, Valve GameNetworkingSockets, Gaffer on Games, and Tiled.

## Deliverables requested from external auditor
- severity-ranked findings (P0/P1/P2/P3)
- minimal reproduction for each finding
- affected file/function
- exploitability / preconditions
- recommended remediation
- confirmation of clean regressions after fixes
