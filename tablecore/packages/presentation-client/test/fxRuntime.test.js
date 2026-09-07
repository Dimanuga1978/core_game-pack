import test from 'node:test';
import assert from 'node:assert/strict';
import { FxRuntime } from '../src/fx-runtime.js';
import { createFakeElement } from './fakeDom.js';

test('FxRuntime.play(null) resolves immediately without touching the container', async () => {
  const container = createFakeElement();
  const fx = new FxRuntime({ container });
  await fx.play(null).promise;
  assert.equal(container.children.length, 0);
});

test('keyframe-based descriptor: creates a node, applies className/style, animates, removes itself when finished', async () => {
  const container = createFakeElement();
  const fx = new FxRuntime({ container });
  const descriptor = { className: 'ls-fx-burst', duration: 20, style: { '--ls-fx-x': '30%', '--ls-fx-y': '40%' }, keyframes: [{ opacity: 0 }, { opacity: 1 }] };
  const { promise: playPromise } = fx.play(descriptor);
  assert.equal(container.children.length, 1, 'the node must be appended synchronously, not deferred');
  const node = container.children[0];
  assert.ok(node.classList.contains('ls-fx-burst'));
  assert.equal(node.style._props['--ls-fx-x'], '30%');
  await playPromise;
  assert.equal(container.children.length, 0, 'the node must be removed once the animation finishes');
});

test('from/to tween descriptor: builds a 3-keyframe move animation between resolved points, resolves after duration', async () => {
  const container = createFakeElement();
  const resolvePoint = coord => coord === 'A' ? { x: 10, y: 10 } : { x: 90, y: 90 };
  const fx = new FxRuntime({ container, resolvePoint });
  const descriptor = { className: 'ls-fx-motion', duration: 15, from: 'A', to: 'B', startOpacity: 0.1, peakOpacity: 1, startScale: 0.7, endScale: 1 };
  const start = Date.now();
  await fx.play(descriptor).promise;
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 10, `must actually wait for the animation duration, took ${elapsed}ms`);
  assert.equal(container.children.length, 0, 'the tween node must be removed after finishing');
});

test('path-based descriptor: highlights real cell elements via CSS classes, matching the game\'s own stylesheet classes', async () => {
  const container = createFakeElement();
  const cells = { '0,0': createFakeElement(), '1,0': createFakeElement(), '2,0': createFakeElement() };
  const fx = new FxRuntime({ container, getCellElement: coord => cells[coord] });
  const descriptor = { path: ['0,0', '1,0', '2,0'], duration: 15 };
  const { promise: playPromise } = fx.play(descriptor);
  assert.ok(cells['0,0'].classList.contains('route-active'));
  assert.ok(cells['1,0'].classList.contains('route-active'));
  assert.ok(cells['2,0'].classList.contains('route-active'));
  assert.ok(cells['2,0'].classList.contains('route-end'), 'only the LAST cell in the path gets the "end" marker');
  assert.equal(cells['0,0'].classList.contains('route-end'), false);
  await playPromise;
  assert.equal(cells['0,0'].classList.contains('route-active'), false, 'highlight classes must be removed once the path animation finishes');
  assert.equal(cells['2,0'].classList.contains('route-end'), false);
});

test('path-based descriptor: coordinates with no real cell element are silently skipped, not a crash', async () => {
  const container = createFakeElement();
  const cells = { '0,0': createFakeElement() };
  const fx = new FxRuntime({ container, getCellElement: coord => cells[coord] ?? null });
  await fx.play({ path: ['0,0', 'nonexistent', '1,0'], duration: 5 }).promise;
});

test('an unsupported/malformed descriptor never rejects', async () => {
  const container = createFakeElement();
  const fx = new FxRuntime({ container });
  await assert.doesNotReject(() => fx.play({ someRandomField: true }).promise);
});

test('FxRuntime requires a container at construction', () => {
  assert.throws(() => new FxRuntime({}), TypeError);
});

test('cancel() stops a keyframe animation IMMEDIATELY -- the node is removed right away, not after its full duration', async () => {
  const container = createFakeElement();
  const fx = new FxRuntime({ container });
  const { promise, cancel } = fx.play({ className: 'x', duration: 500, keyframes: [{ opacity: 0 }, { opacity: 1 }] });
  assert.equal(container.children.length, 1);
  const start = Date.now();
  cancel();
  await promise;
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 50, `cancel() must resolve near-instantly, not wait out the 500ms duration, took ${elapsed}ms`);
  assert.equal(container.children.length, 0, 'the node must be removed immediately on cancel');
});

test('cancel() stops a from/to tween immediately too', async () => {
  const container = createFakeElement();
  const fx = new FxRuntime({ container, resolvePoint: () => ({ x: 0, y: 0 }) });
  const { promise, cancel } = fx.play({ from: 'A', to: 'B', duration: 500 });
  const start = Date.now();
  cancel();
  await promise;
  assert.ok(Date.now() - start < 50);
  assert.equal(container.children.length, 0);
});

test('cancel() on a path-based route highlight removes the highlight classes immediately', async () => {
  const container = createFakeElement();
  const cell = createFakeElement();
  const fx = new FxRuntime({ container, getCellElement: () => cell });
  const { promise, cancel } = fx.play({ path: ['0,0'], duration: 500 });
  assert.ok(cell.classList.contains('route-active'));
  cancel();
  await promise;
  assert.equal(cell.classList.contains('route-active'), false);
});

test('calling cancel() twice, or after natural completion, is safe (no double-resolve, no crash)', async () => {
  const container = createFakeElement();
  const fx = new FxRuntime({ container });
  const { promise, cancel } = fx.play({ className: 'x', duration: 5, keyframes: [{ opacity: 0 }] });
  await promise;
  assert.doesNotThrow(() => cancel());
  assert.doesNotThrow(() => cancel());
});
