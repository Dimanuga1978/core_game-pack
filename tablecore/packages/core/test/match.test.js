import test from 'node:test';
import assert from 'node:assert/strict';
import { gridDuel } from '@tablecore/game-grid-duel';
import { createMatch, startMatch, dispatchMatchAction, abortMatch, MATCH_ID_RE } from '../src/match/createMatch.js';

test('match starts from lobby and owns lifecycle state', () => {
  const lobby = createMatch({ id:'m1', game:gridDuel, players:['A','B'] });
  assert.equal(lobby.status, 'lobby');
  const started = startMatch({ match:lobby, game:gridDuel });
  assert.equal(started.ok, true); assert.equal(started.match.status, 'running');
  assert.equal(started.match.state.activePlayer, 'A');
  assert.equal(started.match.version, 1);
});

test('actions are rejected before match starts', () => {
  const match = createMatch({ game:gridDuel, players:['A','B'] });
  const r = dispatchMatchAction({ match, game:gridDuel, action:{type:'MOVE',actor:'A',direction:'E'} });
  assert.equal(r.ok, false); assert.equal(r.error.code, 'MATCH_NOT_RUNNING');
});

test('finished game closes match and blocks future actions', () => {
  let match = startMatch({ match:createMatch({game:gridDuel,players:['A','B']}), game:gridDuel }).match;
  // Put players adjacent and one hit from defeat; lifecycle layer must not contain game rules.
  match = structuredClone(match); match.state.players.A.position={x:0,y:0}; match.state.players.B.position={x:1,y:0}; match.state.players.B.hp=1;
  const r = dispatchMatchAction({ match, game:gridDuel, action:{type:'ATTACK',actor:'A'} });
  assert.equal(r.ok, true); assert.equal(r.match.status, 'finished'); assert.equal(r.match.result.winner, 'A');
  assert.ok(r.events.some(e=>e.type==='MATCH_FINISHED'));
  const blocked = dispatchMatchAction({ match:r.match, game:gridDuel, action:{type:'MOVE',actor:'A',direction:'E'} });
  assert.equal(blocked.ok, false); assert.equal(blocked.error.code, 'MATCH_NOT_RUNNING');
});

test('abort is explicit and does not mutate finished matches', () => {
  const match = startMatch({ match:createMatch({game:gridDuel,players:['A','B']}), game:gridDuel }).match;
  const r = abortMatch({ match, reason:'HOST_STOPPED' }); assert.equal(r.ok, true); assert.equal(r.match.status,'aborted');
  const again = abortMatch({ match:{...r.match,status:'finished'} }); assert.equal(again.ok,false);
});

// Regression tests: createMatch() used to accept any array of players
// with no format, uniqueness, or count validation at all -- duplicate
// ids, empty strings, non-string values, and unbounded participant counts
// all passed silently. This is directly what enabled the ServerHost
// cache-key collision (a player id equal to '__spectator__') and left
// every downstream assumption ("participants are unique stable
// identities") unenforced.
test('createMatch rejects duplicate player ids', () => {
  assert.throws(() => createMatch({ game:gridDuel, players:['A','A'] }), TypeError);
});

test('createMatch rejects empty-string, non-string, and malformed player ids', () => {
  assert.throws(() => createMatch({ game:gridDuel, players:['A',''] }), TypeError);
  assert.throws(() => createMatch({ game:gridDuel, players:['A', 123] }), TypeError);
  assert.throws(() => createMatch({ game:gridDuel, players:['A', null] }), TypeError);
  assert.throws(() => createMatch({ game:gridDuel, players:['A', '<script>'] }), TypeError);
});

test('createMatch rejects an excessive player count', () => {
  const players = Array.from({ length: 17 }, (_, i) => `p${i}`);
  assert.throws(() => createMatch({ game:gridDuel, players }), TypeError);
});

test('createMatch accepts well-formed, unique player ids including edge-case-looking-but-valid ones', () => {
  // '__spectator__' is a syntactically valid id under the format rule --
  // the fix for the collision it caused lives in ServerHost's cache key
  // prefixing, not in rejecting this specific string here, since the
  // format rule can't enumerate every reserved-looking string a future
  // internal sentinel might use.
  assert.doesNotThrow(() => createMatch({ game:gridDuel, players:['__spectator__','B'] }));
});

// MIG-03 (external migration-derived review request): "hold a reference to
// createMatch/dispatchMatchAction/abortMatch result, mutate it after
// return, and verify the internal authoritative match did not change."
// `.players` used to be the exact same array reference across every
// lifecycle transition (never copied after the initial createMatch()
// call) -- a caller mutating ANY one returned match object's `.players`
// silently corrupted every match snapshot ever derived from it, past and
// future, since they all aliased one array. Now frozen: the mutation
// attempt throws instead of silently succeeding.
test('mutating .players on any returned match object throws instead of silently corrupting every other match snapshot', () => {
  const original = createMatch({ game:gridDuel, players:['A','B'] });
  const started = startMatch({ match:original, game:gridDuel });
  const dispatched = dispatchMatchAction({ match:started.match, game:gridDuel, action:{type:'MOVE',actor:'A',direction:'E'} });

  assert.throws(() => { dispatched.match.players.push('INJECTED'); }, TypeError);
  assert.deepEqual(original.players, ['A','B'], 'the original match object must be completely unaffected by the throwing mutation attempt');
  assert.deepEqual(started.match.players, ['A','B']);
  assert.deepEqual(dispatched.match.players, ['A','B']);
});

test('mutating .options on any returned match object throws instead of silently corrupting every other match snapshot', () => {
  const original = createMatch({ game:gridDuel, players:['A','B'], options:{ seed:1, mode:'ranked' } });
  const started = startMatch({ match:original, game:gridDuel });
  assert.throws(() => { started.match.options.mode = 'casual'; }, TypeError);
  assert.equal(original.options.mode, 'ranked');
});

// MIG-03's other required case: a failed action transition must not
// partially mutate the old match. dispatchMatchAction already returns
// `{ ...result, match }` (the ORIGINAL match, unchanged) on failure --
// this asserts that explicitly, plus that the original object's own
// fields are untouched.
test('a rejected action does not mutate the authoritative match object at all', () => {
  const original = createMatch({ game:gridDuel, players:['A','B'] });
  const started = startMatch({ match:original, game:gridDuel });
  const before = structuredClone(started.match);
  const rejected = dispatchMatchAction({ match:started.match, game:gridDuel, action:{type:'MOVE',actor:'B',direction:'E'} }); // B is not the active player
  assert.equal(rejected.ok, false);
  assert.equal(rejected.match, started.match, 'on rejection, the exact same match reference is returned, not a mutated copy');
  assert.deepEqual(started.match, before, 'the match object itself must be byte-for-byte unchanged after a rejected action');
});

// Regression tests: createMatch() used to have no concept of a spectator
// policy at all -- access control for anonymous viewers lived entirely
// at the protocol layer's optional `connection.allowedMatches`, which
// defaulted to "allow" when unset. `spectatorPolicy` makes the match
// itself the source of truth, defaulting to deny.
test('createMatch defaults spectatorPolicy to deny', () => {
  const match = createMatch({ game:gridDuel, players:['A','B'] });
  assert.equal(match.spectatorPolicy, 'deny');
});

test('createMatch rejects an invalid spectatorPolicy value', () => {
  assert.throws(() => createMatch({ game:gridDuel, players:['A','B'], spectatorPolicy:'yes-please' }), TypeError);
});

test('createMatch accepts an explicit public spectatorPolicy', () => {
  const match = createMatch({ game:gridDuel, players:['A','B'], spectatorPolicy:'public' });
  assert.equal(match.spectatorPolicy, 'public');
});

// Regression tests for a real, previously-unvalidated gap found via
// research into how mature game-server engines handle this class of
// thing: a caller-supplied match id was never checked against any
// safe-character pattern anywhere in the engine. Not yet exploitable in
// this codebase today (matchId is never used to build a filesystem path
// currently), but latent -- the exact kind of gap that becomes a real
// path-traversal vulnerability the moment something DOES use a match id
// to build a path (e.g. a persistence layer saving one file per match).

test('createMatch rejects an unsafe explicit match id (e.g. path-traversal characters) rather than accepting anything', () => {
  assert.throws(() => createMatch({ id: '../../../etc/passwd', game: gridDuel, players: ['A', 'B'] }), TypeError);
  assert.throws(() => createMatch({ id: '../evil', game: gridDuel, players: ['A', 'B'] }), TypeError);
  assert.throws(() => createMatch({ id: 'a/b', game: gridDuel, players: ['A', 'B'] }), TypeError);
  assert.throws(() => createMatch({ id: '', game: gridDuel, players: ['A', 'B'] }), TypeError);
});

test('createMatch still accepts every real match id format already used throughout this project (letters, digits, hyphens, underscores, dots, colons)', () => {
  assert.doesNotThrow(() => createMatch({ id: 'match-1788115932206-e5x5uo', game: gridDuel, players: ['A', 'B'] }));
  assert.doesNotThrow(() => createMatch({ id: 'ls-tv', game: gridDuel, players: ['A', 'B'] }));
  assert.doesNotThrow(() => createMatch({ id: 'lobby-1788112953012-d19f54', game: gridDuel, players: ['A', 'B'] }));
});

test('createMatch auto-generates a safe, collision-resistant default id when none is explicitly provided', () => {
  const match = createMatch({ game: gridDuel, players: ['A', 'B'] });
  assert.match(match.id, /^match-\d+-[a-z0-9]+$/);
});

// Regression test for a real bug found via manual code review (not
// testing): the previous default (`match-${Date.now()}` alone, no
// random suffix) had zero collision resistance -- confirmed directly:
// 1000 rapid createMatch() calls with no explicit id produced only 7
// unique ids (993 collisions), since Date.now()'s millisecond
// resolution is far coarser than how fast a tight loop (or any
// reasonably fast real usage) actually runs.
test('createMatch\'s auto-generated default id is genuinely collision-resistant under real, rapid, repeated calls', () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i++) {
    const match = createMatch({ game: gridDuel, players: ['A', 'B'] });
    ids.add(match.id);
  }
  assert.equal(ids.size, 1000, 'every one of 1000 rapid createMatch() calls with no explicit id must produce a genuinely unique id');
});

test('createMatch\'s auto-generated default id still satisfies MATCH_ID_RE, the same format constraint an explicit id must satisfy', () => {
  const match = createMatch({ game: gridDuel, players: ['A', 'B'] });
  assert.ok(MATCH_ID_RE.test(match.id));
});

// Regression test for a real external audit finding (E-06): startMatch()'s
// own `context` parameter used to be merged LAST into createInitialState()'s
// options ({players, ...match.options, ...context}), meaning a caller-
// supplied context could silently override even `players` itself -- a
// genuine confused-deputy primitive, even though NO real caller in this
// codebase currently passes a non-empty context to startMatch() at all
// (confirmed directly while investigating this). Fixed by stripping
// reserved fields from context before merging, and putting the real,
// authoritative `players` LAST regardless.
test('startMatch() context can never override reserved fields like players, even if a caller explicitly tries to', () => {
  const match = createMatch({ id: 'm', game: gridDuel, players: ['A', 'B'] });
  const result = startMatch({ match, game: gridDuel, context: { players: ['EVIL', 'HACKED'] } });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.match.state.players).sort(), ['A', 'B'], 'the real, authoritative player list must be used regardless of what a caller-supplied context claims');
});

test('startMatch() context can still supply genuinely non-reserved, additional fields (the legitimate extensibility this parameter exists for)', () => {
  const gameWithExtraOption = {
    ...gridDuel,
    createInitialState(options) {
      const state = gridDuel.createInitialState(options);
      state.customFlag = options.customFlag;
      return state;
    },
  };
  const match = createMatch({ id: 'm2', game: gameWithExtraOption, players: ['A', 'B'] });
  const result = startMatch({ match, game: gameWithExtraOption, context: { customFlag: 'hello' } });
  assert.equal(result.ok, true);
  assert.equal(result.match.state.customFlag, 'hello', 'a genuinely non-reserved context field must still pass through -- this fix narrows the primitive, it does not remove its real extensibility');
});

// Regression tests for a real external audit finding (E-04): match.events
// used to grow completely unbounded, appended on every single action via
// `[...match.events, ...events]` (an O(current length) copy cost on
// EVERY action, O(n^2) total over a match's full lifetime, plus
// genuinely unbounded memory growth). Confirmed directly before fixing:
// nothing in this codebase's production code ever actually reads the
// accumulated match.events array -- playReplay() reconstructs a match
// from its own, separately-recorded action log, not from this field --
// so bounding it to a recent window breaks no real functionality.
test('match.events never exceeds its bounded recent-history window, even across many real actions', () => {
  let match = createMatch({ id: 'm', game: gridDuel, players: ['A', 'B'] });
  match = startMatch({ match, game: gridDuel }).match;
  for (let i = 0; i < 150; i++) {
    const actor = match.activePlayer ?? match.state.activePlayer;
    const result = dispatchMatchAction({ match, game: gridDuel, action: { type: 'MOVE', actor, direction: i % 2 === 0 ? 'E' : 'W' } });
    if (result.ok) match = result.match;
  }
  assert.ok(match.events.length <= 100, `match.events must stay bounded regardless of how many real actions have been dispatched, got ${match.events.length}`);
});

test('match.events keeps the MOST RECENT events when bounded, not the oldest ones (a truncated tail, not a truncated head)', () => {
  let match = createMatch({ id: 'm2', game: gridDuel, players: ['A', 'B'] });
  match = startMatch({ match, game: gridDuel }).match;
  const lastRealEvents = [];
  for (let i = 0; i < 150; i++) {
    const actor = match.activePlayer ?? match.state.activePlayer;
    const result = dispatchMatchAction({ match, game: gridDuel, action: { type: 'MOVE', actor, direction: i % 2 === 0 ? 'E' : 'W' } });
    if (result.ok) { match = result.match; lastRealEvents.push(...result.events); }
  }
  // The last event this loop actually produced must still be present in
  // the (bounded) match.events -- proving the window slides forward
  // (keeps recent history), rather than just silently capping and
  // discarding all NEW events once the bound is first hit.
  const veryLastEvent = lastRealEvents[lastRealEvents.length - 1];
  assert.deepEqual(match.events[match.events.length - 1], veryLastEvent, 'the most recent real event must survive bounding -- an unbounded-looking window that actually discards new events would be a worse bug than the one being fixed');
});

test('match.events stays well under its bound for a short, realistic match -- bounding never truncates a normal, real game', () => {
  let match = createMatch({ id: 'm3', game: gridDuel, players: ['A', 'B'] });
  match = startMatch({ match, game: gridDuel }).match;
  assert.ok(match.events.length < 100, 'a freshly-started match must be nowhere near the bound');
  assert.deepEqual(match.events.map(e => e.type), ['MATCH_CREATED', 'MATCH_STARTED'], 'a normal, short match sees its real, complete event history unmodified -- the bound only ever matters for genuinely long-running matches');
});

// Regression tests for real audit findings (both audit.md and
// audit_last-sector.md independently raised this class of concern):
// the raw seed value, if a caller happens to pass one inside `options`
// (a realistic, real pattern -- see games/last-sector's own
// `createMatch({..., options: {seed: 42, ...}})` usage), used to flow
// unstripped through `match.options` into createInitialState()'s own
// argument object, and `match.seed` was separately spread into
// dispatchMatchAction()'s own context as `context.seed`. Confirmed
// directly before fixing: none of this engine's five real games
// actually leak the raw seed value into their returned state today, so
// this closes a latent, not-yet-exploited structural gap rather than
// an active one -- the primitive was simply too permissive to leave as
// is, the same principle already applied to `context`'s own reserved
// fields.
test('the raw seed value passed via options never reaches createInitialState()\'s own argument object, even when a caller explicitly includes it there', () => {
  const gameCapturingOptions = {
    createInitialState(options) { return { receivedOptions: options }; },
    getLegalActions: () => [],
    applyActionInPlace: (s) => ({ state: s, events: [] }),
    getGameStatus: () => ({ finished: false }),
  };
  const match = createMatch({ id: 'm', game: gameCapturingOptions, players: ['A', 'B'], options: { seed: 424242, customFlag: 'hello' } });
  const started = startMatch({ match, game: gameCapturingOptions }).match;
  assert.equal('seed' in started.state.receivedOptions, false, 'seed must be stripped from options before reaching createInitialState, even though the caller explicitly included it');
  assert.equal(started.state.receivedOptions.customFlag, 'hello', 'a genuinely non-reserved option must still pass through correctly -- this fix narrows the primitive, it does not break real options');
});

test('dispatchMatchAction() never includes the raw seed value in the context passed to the game -- only the real rng object', () => {
  const gameCapturingContext = {
    createInitialState: () => ({ value: 0 }),
    getLegalActions: () => [{ type: 'X' }],
    applyActionInPlace(state, action, context) { state.receivedContext = { hasRng: typeof context.rng?.next === 'function', hasSeed: 'seed' in context }; return { state, events: [] }; },
    getGameStatus: () => ({ finished: false }),
  };
  let match = createMatch({ id: 'm2', game: gameCapturingContext, players: ['A', 'B'], options: { seed: 999 } });
  match = startMatch({ match, game: gameCapturingContext }).match;
  const result = dispatchMatchAction({ match, game: gameCapturingContext, action: { type: 'X', actor: 'A' } });
  assert.equal(result.ok, true);
  assert.equal(result.match.state.receivedContext.hasRng, true, 'the real rng object must still be present -- this fix only removes the raw seed, not randomness itself');
  assert.equal(result.match.state.receivedContext.hasSeed, false, 'the raw seed value must never be included in the context a game\'s own rule code receives');
});
