# TableCore v2 — Architecture Principles

## The engine is authoritative. Game packs conform to it, not the other way around.

This is the standing rule for every future change to this codebase, established after the immer/structural-sharing work in this project's history: **the engine defines the contract; game packs are written to satisfy it.** The engine does not grow special cases, opt-out flags, or dual code paths to accommodate however an existing game pack happens to be written.

This is not a new idea introduced here — it is the same principle the engine already applies in several places, and every future capability should follow the same shape:

| Constraint | Enforced by | What happens if a pack violates it |
|---|---|---|
| Rule code must be synchronous | `pack-linter`'s `ASYNC_IN_RULE_CODE`/`AWAIT_IN_RULE_CODE` static checks | Blocked at lint time (best-effort; see the `pack-linter` limitations note below for what it can't catch, and `runAction.js`'s `GAME_EXECUTION_ERROR` fail-closed path as the runtime backstop) |
| Rule code must not read `Math.random()`/`Date.now()`/wall-clock time | `pack-linter`'s `MATH_RANDOM_IN_RULE_CODE`/`WALL_CLOCK_*` checks | Blocked at lint time; replay/determinism silently breaks if it slips through |
| `applyActionInPlace` receives a live immer draft, not a plain object — never call `structuredClone()`/`clone()` on a value read from `state` inside it | `pack-linter`'s `STRUCTURED_CLONE_ON_DRAFT_IN_APPLY_ACTION_IN_PLACE` check, plus `runAction()`'s fail-closed `GAME_EXECUTION_ERROR` at runtime | Blocked at lint time where the static check can see it; fails closed (state untouched) at runtime otherwise |
| A game declaring `manifest.hiddenInformation: true` must implement `getPlayerView` | `pack-linter`'s `HIDDEN_INFORMATION_WITHOUT_PLAYER_VIEW` check | Blocked at lint time |
| Private events must set `audience`, not rely on `getPlayerView` alone | `pack-linter`'s `HIDDEN_INFORMATION_WITHOUT_EVENT_AUDIENCE` warning, `filterEventsForViewer()` at the protocol layer | Warned at lint time (heuristic, not a hard block); actually enforced at the transport boundary regardless of whether a pack got this right |

When a new engine-level capability is added and an existing game pack turns out to be incompatible with it, the default response is: **fix the game pack**, add or extend a static check so the same mistake is caught before it ships again, and only fall back to an opt-out/compatibility flag if fixing every affected pack is genuinely not possible. An opt-in escape hatch that most future packs will silently inherit by never knowing it exists is the wrong default — see the immer/structural-sharing decision below for a concrete example of this being corrected after initially getting it backwards.

### Case study: why this rule exists (immer / structural sharing)

`packages/core/src/runAction.js`'s `applyActionInPlace` path was changed to use immer's draft-based structural sharing instead of a full `structuredClone()` per action (see `ARCHITECTURE_RESEARCH.md` for the performance rationale and measured numbers). The first version of this change made it opt-in (`useStructuralSharing`, default `false`) specifically to avoid touching existing game code. That was the wrong call: it meant the faster, correct-by-construction path would only ever be used by a pack author who happened to know the flag existed, while every pack written without that knowledge silently kept paying the full-clone cost forever — the opposite of what "the engine should have good defaults" means in practice.

The fix was to invert it: structural sharing became the *only* path for `applyActionInPlace`, the one genuinely incompatible pattern in the shipped games (`structuredClone()` called on a value read from the draft) was fixed at the source, and a static check was added so the same mistake can't ship again unnoticed. This is the model for how every future engine-level change like this should be handled.

### What this does *not* mean

This principle is about the shape of the *engine's contract* — not an excuse to make the contract needlessly rigid, undocumented, or hard to satisfy. Every constraint in the table above ships with:
- a clear, specific reason (usually: determinism, or a privacy boundary that would otherwise be silently violated);
- a static check that catches the violation as early as possible;
- a runtime fail-closed backstop for what the static check can't catch;
- an honest note about what the static check *can't* catch (see below) rather than a false sense of completeness.

"The engine is authoritative" means pack authors get a small, explicit, growing list of rules to follow — not that the engine is free to change behavior underneath them without a documented contract and a way to verify compliance.

### Known limitation of the static-check approach

The `pack-linter` checks above are `Function.prototype.toString()`-based regex heuristics over a single function's own source text, not a real AST/whole-module analysis. They have confirmed false negatives: a game can bypass `STRUCTURED_CLONE_ON_DRAFT_IN_APPLY_ACTION_IN_PLACE`, for instance, by aliasing `structuredClone` through `globalThis[...]`, or by calling a helper function declared elsewhere in the module that itself calls `structuredClone()` (the linter only ever sees `applyActionInPlace`'s own source text, not the body of anything it calls). This is an accepted, documented trade-off — a lightweight regex-based linter is deliberately simple and fast rather than a full static analyzer — but it means **the runtime fail-closed behavior in `runAction.js`, not the linter, is the actual guarantee.** The linter is a best-effort early warning, not a security boundary on its own.
