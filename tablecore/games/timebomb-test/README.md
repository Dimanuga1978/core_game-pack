# timebomb-test

This is **not a game**. It is a minimal test fixture used exclusively by
`packages/worker-pool/test/MatchWorkerPool.test.js` to demonstrate real
worker-crash isolation, built on a real, previously-confirmed engine bug
class (a rule that schedules a deferred mutation of its own draft state
via `setTimeout`, which throws once the timer fires because the immer
draft is already finalized/revoked by then).

It is not registered as a game pack, has no manifest, no content, no
capabilities, and is not discovered or loaded by anything except that one
test file's explicit `import()` by file URL. Kept under `games/` only so
it can be a real, importable ES module reachable from a worker thread,
the same way any other game in this repo is.

(See also `games/memory-hog-test/` and `games/infinite-loop-test/` --
same rationale, used by the resourceLimits/rpcTimeoutMs tests in the same
test file.)
