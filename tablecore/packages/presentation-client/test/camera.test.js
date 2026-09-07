import test from 'node:test';
import assert from 'node:assert/strict';
import { PresentationCamera } from '../src/camera.js';
import { createFakeElement } from './fakeDom.js';

test('PresentationCamera requires a target at construction', () => {
  assert.throws(() => new PresentationCamera({}), TypeError);
});

test('choreograph() runs shots in order, applying transform for each, and resolves after the last one\'s duration', async () => {
  const target = createFakeElement();
  const resolvePoint = coord => ({ x: coord === 'A' ? 20 : 80, y: 50 });
  const camera = new PresentationCamera({ target, resolvePoint });
  const start = Date.now();
  await camera.choreograph([{ point: 'A', scale: 1.2, duration: 10 }, { point: 'B', scale: 1.4, duration: 10 }]);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 15, `must wait for both shots' durations, took ${elapsed}ms`);
  assert.equal(camera.current.scale, 1.4, 'the FINAL applied transform must reflect the last shot');
  assert.equal(camera.current.x, 80);
});

test('reset() returns to the default centered/unscaled view', async () => {
  const target = createFakeElement();
  const camera = new PresentationCamera({ target, resolvePoint: () => ({ x: 20, y: 20 }) });
  await camera.choreograph([{ point: 'anything', scale: 2, duration: 5 }]);
  assert.notEqual(camera.current.scale, 1);
  await camera.reset({ duration: 5 });
  assert.deepEqual(camera.current, { x: 50, y: 50, scale: 1 });
});

test('choreograph() with an empty or missing shots array resolves immediately without touching the target', async () => {
  const target = createFakeElement();
  const camera = new PresentationCamera({ target });
  const before = { ...camera.current };
  await camera.choreograph([]);
  await camera.choreograph(undefined);
  assert.deepEqual(camera.current, before);
});

test('the actual CSS transform written to the target reflects the resolved point (sanity check on the real formula, not just internal state)', async () => {
  const target = createFakeElement();
  const camera = new PresentationCamera({ target, resolvePoint: () => ({ x: 30, y: 70 }) });
  await camera.choreograph([{ point: 'x', scale: 1.5, duration: 5 }]);
  const transform = target.style._props['transform'];
  assert.match(transform, /scale\(1\.5\)/);
  assert.match(transform, /translate\(20%, -20%\)/, `expected translate(50-30=20%, 50-70=-20%), got: ${transform}`);
});
