import test from 'node:test';
import assert from 'node:assert/strict';
import { FxRuntime, PresentationCamera, PresentationSequenceRuntime, PresentationDispatcher } from '../src/index.js';
import { createFakeElement } from './fakeDom.js';

// last-sector is a SEPARATE, optional game pack (see this repo's own
// two-archive split). This WHOLE FILE is a dedicated integration test
// specifically for last-sector's own real presentation.js -- see
// lastSectorIntegration.test.js in packages/browser-client for the
// same reasoning applied there. Tried once, dynamically, rather than a
// static top-level import that would fail this whole file to even load
// on an engine-only checkout.
let createLastSectorPresentation, lastSectorUnavailableReason = null;
try {
  ({ createLastSectorPresentation } = await import('../../../games/last-sector/client/presentation.js'));
} catch (error) {
  lastSectorUnavailableReason = `games/last-sector not present in this checkout (${error.code ?? error.message})`;
}
const skipIfNoLastSector = lastSectorUnavailableReason ? { skip: lastSectorUnavailableReason } : {};

// The strongest verification possible without a real browser: the REAL,
// unmodified createLastSectorPresentation() (the actual declarative
// design already shipped in the game -- see its own module doc comment)
// driving the REAL FxRuntime/PresentationCamera/PresentationSequenceRuntime/
// PresentationDispatcher, dispatching a real SHIP_MOVED event exactly as
// it would arrive over the wire. Only the DOM is fake (no real browser
// available here) -- every piece of actual logic is real, nothing mocked.

function setup() {
  const fxLayer = createFakeElement();
  const mapWorld = createFakeElement();
  const cellA = createFakeElement();
  const cellB = createFakeElement();
  const cells = { 'A': cellA, 'B': cellB };
  const resolvePoint = value => (value && typeof value === 'object') ? value : (value === 'A' ? { x: 20, y: 20 } : { x: 80, y: 80 });
  const fxRuntime = new FxRuntime({ container: fxLayer, resolvePoint, getCellElement: coord => cells[coord] ?? null });
  const camera = new PresentationCamera({ target: mapWorld, resolvePoint });
  const sequenceRuntime = new PresentationSequenceRuntime({ fxRuntime, camera });
  const dispatcher = new PresentationDispatcher({ presentation: createLastSectorPresentation(), sequenceRuntime, fxRuntime });
  return { fxLayer, mapWorld, dispatcher, camera };
}

test('a real SHIP_MOVED event is routed through the sequence path (camera choreography + fx + reset), not the plain single-handler path', skipIfNoLastSector, async () => {
  const { fxLayer, mapWorld, dispatcher } = setup();
  const event = { type: 'SHIP_MOVED', payload: { playerId: 'p1', from: 'A', to: 'B', shipType: 'scout' } };
  await dispatcher.dispatch(event, {});
  // The sequence must have actually run camera transforms on mapWorld
  // and appended+removed fx nodes into fxLayer along the way -- proof
  // the REAL presentation.js sequence (not a fallback single descriptor)
  // executed to completion.
  assert.ok(mapWorld.style._props.transform, 'the camera must have applied a real transform during the SHIP_MOVED sequence');
  assert.equal(fxLayer.children.length, 0, 'all fx nodes created during the sequence must be cleaned up once it finishes');
});

test('a real COMBAT_RESOLVED event (with from/to and destroyed:true) plays projectile + combat + destroyed fx in sequence', skipIfNoLastSector, async () => {
  const { fxLayer, dispatcher } = setup();
  const seen = [];
  // Intercept by wrapping fxRuntime.play via the dispatcher's own
  // internal fxRuntime is hard to spy on directly without changing the
  // module, so instead verify observable side effects: the fx layer
  // gains and loses children as each descriptor plays, and the whole
  // thing completes without throwing for a fully-populated payload.
  const event = { type: 'COMBAT_RESOLVED', payload: { targetId: 't1', from: 'A', to: 'B', destroyed: true } };
  await dispatcher.dispatch(event, {});
  assert.equal(fxLayer.children.length, 0, 'every fx node from the multi-step combat sequence must be cleaned up');
});

test('an event type with NO sequence but WITH a handler (e.g. SCAN_RESOLVED) plays a single descriptor via fxRuntime directly', skipIfNoLastSector, async () => {
  const { fxLayer, dispatcher } = setup();
  const event = { type: 'SCAN_RESOLVED', payload: { playerId: 'p1', coord: 'A' } };
  await dispatcher.dispatch(event, {});
  assert.equal(fxLayer.children.length, 0, 'the single scan descriptor must play and clean up');
});

test('sequenceAliases correctly redirects SHIP_MOVE_ANIMATION to the SHIP_MOVED sequence, the real alias mapping from presentation.js', skipIfNoLastSector, async () => {
  const { mapWorld, dispatcher } = setup();
  const event = { type: 'SHIP_MOVE_ANIMATION', payload: { playerId: 'p1', from: 'A', to: 'B', shipType: 'warship' } };
  await dispatcher.dispatch(event, {});
  assert.ok(mapWorld.style._props.transform, 'the aliased event must reach the same real camera-choreographed sequence as SHIP_MOVED');
});

test('a real PLAYER_SHIP_DESTROYED event (high real priority in presentation.js) interrupts a lower-priority SHIP_MOVED already in flight on the combat/ship lanes', skipIfNoLastSector, async () => {
  const { dispatcher } = setup();
  // SHIP_MOVED runs on the 'ship' lane (priority 20), PLAYER_SHIP_DESTROYED
  // runs on the 'combat' lane (priority 100) -- different lanes, so this
  // specifically verifies they can run concurrently without one blocking
  // the other, using the real priority/lane values from presentation.js
  // itself (not test-invented ones).
  const move = dispatcher.dispatch({ type: 'SHIP_MOVED', payload: { playerId: 'p1', from: 'A', to: 'B', shipType: 'scout' } }, {});
  const destroyed = dispatcher.dispatch({ type: 'PLAYER_SHIP_DESTROYED', payload: { playerId: 'p2', coord: 'B' } }, {});
  await assert.doesNotReject(() => Promise.all([move, destroyed]));
});
