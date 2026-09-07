import test from 'node:test';
import assert from 'node:assert/strict';
import { PresentationDispatcher } from '../src/dispatcher.js';

test('an event whose type has a sequence factory is routed through sequenceRuntime, not fxRuntime', async () => {
  const calls = [];
  const sequenceRuntime = { run: spec => { calls.push(['sequence', spec.id]); return Promise.resolve(); } };
  const fxRuntime = { play: () => { calls.push(['fx']); return { promise: Promise.resolve(), cancel() {} }; } };
  const presentation = { handlers: { MOVE: () => ({ id: 'wrong-path' }) }, sequences: { MOVE: () => ({ id: 'right-path', steps: [] }) }, sequenceAliases: {} };
  const dispatcher = new PresentationDispatcher({ presentation, sequenceRuntime, fxRuntime });
  await dispatcher.dispatch({ type: 'MOVE' });
  assert.deepEqual(calls, [['sequence', 'right-path']], 'a sequence must take priority over a single-shot handler for the same event type');
});

test('an event whose type has only a handler (no sequence) is routed through fxRuntime', async () => {
  const calls = [];
  const fxRuntime = { play: d => { calls.push(d.id); return { promise: Promise.resolve(), cancel() {} }; } };
  const presentation = { handlers: { SCAN: () => ({ id: 'scan-fx' }) }, sequences: {}, sequenceAliases: {} };
  const dispatcher = new PresentationDispatcher({ presentation, fxRuntime });
  await dispatcher.dispatch({ type: 'SCAN' });
  assert.deepEqual(calls, ['scan-fx']);
});

test('sequenceAliases redirects an event type to a differently-named sequence', async () => {
  const calls = [];
  const sequenceRuntime = { run: spec => { calls.push(spec.id); return Promise.resolve(); } };
  const presentation = { handlers: {}, sequences: { SHIP_MOVED: () => ({ id: 'ship-moved-sequence', steps: [] }) }, sequenceAliases: { SHIP_MOVE_ANIMATION: 'SHIP_MOVED' } };
  const dispatcher = new PresentationDispatcher({ presentation, sequenceRuntime });
  await dispatcher.dispatch({ type: 'SHIP_MOVE_ANIMATION' });
  assert.deepEqual(calls, ['ship-moved-sequence']);
});

test('an event type with no matching sequence or handler resolves with no error', async () => {
  const dispatcher = new PresentationDispatcher({ presentation: { handlers: {}, sequences: {} } });
  await assert.doesNotReject(() => dispatcher.dispatch({ type: 'SOME_UNKNOWN_EVENT' }));
});

test('an event with no type at all resolves with no error', async () => {
  const dispatcher = new PresentationDispatcher({});
  await assert.doesNotReject(() => dispatcher.dispatch({}));
  await assert.doesNotReject(() => dispatcher.dispatch(null));
});

test('a handler/sequence factory that throws does not crash the dispatcher', async () => {
  const presentation = { handlers: { BAD: () => { throw new Error('broken handler'); } }, sequences: {} };
  const fxRuntime = { play: () => { throw new Error('should never be reached'); } };
  const dispatcher = new PresentationDispatcher({ presentation, fxRuntime });
  await assert.doesNotReject(() => dispatcher.dispatch({ type: 'BAD' }));
});

test('the "default" handler is used as a fallback for an event type with no specific handler', async () => {
  const calls = [];
  const fxRuntime = { play: d => { calls.push(d.id); return { promise: Promise.resolve(), cancel() {} }; } };
  const presentation = { handlers: { default: () => ({ id: 'fallback' }) }, sequences: {} };
  const dispatcher = new PresentationDispatcher({ presentation, fxRuntime });
  await dispatcher.dispatch({ type: 'SOMETHING_WITH_NO_SPECIFIC_HANDLER' });
  assert.deepEqual(calls, ['fallback']);
});

test('event and ctx are passed through to the factory function unchanged', async () => {
  let receivedEvent, receivedCtx;
  const presentation = { handlers: { X: (event, ctx) => { receivedEvent = event; receivedCtx = ctx; return null; } }, sequences: {} };
  const fxRuntime = { play: () => ({ promise: Promise.resolve(), cancel() {} }) };
  const dispatcher = new PresentationDispatcher({ presentation, fxRuntime });
  const event = { type: 'X', payload: { foo: 1 } };
  const ctx = { resolvePoint: () => {} };
  await dispatcher.dispatch(event, ctx);
  assert.equal(receivedEvent, event);
  assert.equal(receivedCtx, ctx);
});
