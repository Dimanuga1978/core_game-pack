import test from 'node:test';
import assert from 'node:assert/strict';
import { PresentationSequenceRuntime } from '../src/sequence-runtime.js';

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// A real, minimal mock of FxRuntime's actual interface -- play() returns
// {promise, cancel}, matching fx-runtime.js exactly (not a bare Promise),
// with cancel() actually stopping the fake "animation" immediately. This
// is what makes the interruption tests below meaningful: they exercise
// the SAME cancel() plumbing the real FxRuntime provides, not a
// simplified stand-in that would hide a real interruption bug (this is
// exactly how the first version of these tests caught one).
function createMockFxRuntime(order) {
  return {
    play(d) {
      order.push(`start:${d.id}`);
      let settle, cancelled = false;
      const promise = new Promise(resolve => { settle = resolve; });
      const timer = setTimeout(() => { if (!cancelled) { order.push(`end:${d.id}`); settle(); } }, d.delay ?? 10);
      return { promise, cancel: () => { if (cancelled) return; cancelled = true; clearTimeout(timer); settle(); } };
    },
  };
}

test('a single sequence runs its steps in order and resolves when done', async () => {
  const order = [];
  const fxRuntime = createMockFxRuntime(order);
  const runtime = new PresentationSequenceRuntime({ fxRuntime });
  await runtime.run({ lane: 'a', steps: [{ descriptor: { id: 1, delay: 3 } }, { descriptor: { id: 2, delay: 3 } }] });
  assert.deepEqual(order, ['start:1', 'end:1', 'start:2', 'end:2']);
});

test('two DIFFERENT lanes run fully in parallel, not blocking each other', async () => {
  const order = [];
  const fxRuntime = createMockFxRuntime(order);
  const runtime = new PresentationSequenceRuntime({ fxRuntime });
  const a = runtime.run({ lane: 'ship', steps: [{ descriptor: { id: 'A', delay: 20 } }] });
  const b = runtime.run({ lane: 'combat', steps: [{ descriptor: { id: 'B', delay: 5 } }] });
  await Promise.all([a, b]);
  // B (shorter, different lane) must finish before A, proving they ran
  // concurrently rather than B waiting for A's lane to free up.
  assert.deepEqual(order, ['start:A', 'start:B', 'end:B', 'end:A']);
});

test('within ONE lane, a second sequence queues and runs only after the first finishes (sequential, not parallel)', async () => {
  const order = [];
  const fxRuntime = createMockFxRuntime(order);
  const runtime = new PresentationSequenceRuntime({ fxRuntime });
  const a = runtime.run({ lane: 'ship', steps: [{ descriptor: { id: 1, delay: 10 } }] });
  const b = runtime.run({ lane: 'ship', steps: [{ descriptor: { id: 2, delay: 10 } }] });
  await Promise.all([a, b]);
  assert.deepEqual(order, ['start:1', 'end:1', 'start:2', 'end:2']);
});

test('a higher-or-equal-priority replace:true sequence REALLY interrupts what is currently playing -- the old effect is cancelled immediately, not left to finish underneath', async () => {
  const order = [];
  const fxRuntime = createMockFxRuntime(order);
  const runtime = new PresentationSequenceRuntime({ fxRuntime });
  const low = runtime.run({ lane: 'combat', priority: 10, steps: [{ descriptor: { id: 'low', delay: 200 } }, { descriptor: { id: 'low-step2', delay: 5 } }] });
  await wait(10); // let "low" actually start and be mid-flight
  const high = runtime.run({ lane: 'combat', priority: 50, replace: true, steps: [{ descriptor: { id: 'high', delay: 5 } }] });
  const start = Date.now();
  await Promise.all([low, high]);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 100, `interruption must be near-instant, not wait out "low"'s 200ms delay, took ${elapsed}ms`);
  assert.ok(order.includes('start:low'));
  assert.ok(!order.includes('end:low'), 'the interrupted effect must be CANCELLED, never reach its natural end -- this is the real fix, not just skipping ahead');
  assert.ok(!order.includes('start:low-step2'), 'a cancelled sequence must not proceed to its next step');
  assert.ok(order.includes('start:high') && order.includes('end:high'), 'the higher-priority replacement must run to completion');
});

test('a LOWER-priority replace:true sequence does NOT interrupt a higher-priority one already playing', async () => {
  const order = [];
  const fxRuntime = createMockFxRuntime(order);
  const runtime = new PresentationSequenceRuntime({ fxRuntime });
  const high = runtime.run({ lane: 'combat', priority: 100, steps: [{ descriptor: { id: 'high', delay: 20 } }] });
  await wait(5);
  const low = runtime.run({ lane: 'combat', priority: 1, replace: true, steps: [{ descriptor: { id: 'low', delay: 5 } }] });
  await Promise.all([high, low]);
  assert.ok(order.includes('end:high'), 'the important sequence must be allowed to finish, not preempted by a routine low-priority one');
  assert.ok(order.indexOf('end:high') < order.indexOf('start:low'));
});

test('when several sequences queue up for the same lane, the highest-priority one runs next regardless of arrival order', async () => {
  const order = [];
  const fxRuntime = createMockFxRuntime(order);
  const runtime = new PresentationSequenceRuntime({ fxRuntime });
  const first = runtime.run({ lane: 'ship', priority: 0, steps: [{ descriptor: { id: 'first', delay: 5 } }] });
  await wait(1);
  const lowPriorityLater = runtime.run({ lane: 'ship', priority: 1, steps: [{ descriptor: { id: 'low', delay: 3 } }] });
  const highPriorityLater = runtime.run({ lane: 'ship', priority: 10, steps: [{ descriptor: { id: 'high', delay: 3 } }] });
  await Promise.all([first, lowPriorityLater, highPriorityLater]);
  const starts = order.filter(e => e.startsWith('start:')).map(e => e.slice(6));
  assert.deepEqual(starts, ['first', 'high', 'low'], 'both queued after "first" finishes, but "high" must run before "low" despite arriving second');
});

test('camera steps run before their descriptor step within a sequence, in the order given', async () => {
  const order = [];
  const camera = { choreograph: async shots => { order.push(`camera:${shots[0].label}`); await wait(3); }, reset: async () => { order.push('camera:reset'); await wait(3); } };
  const fxRuntime = createMockFxRuntime(order);
  const runtime = new PresentationSequenceRuntime({ fxRuntime, camera });
  await runtime.run({ lane: 'ship', steps: [
    { camera: { choreograph: true, shots: [{ label: 'pan-in' }] } },
    { descriptor: { id: 'move', delay: 3 } },
    { camera: { reset: true } },
  ] });
  assert.deepEqual(order, ['camera:pan-in', 'start:move', 'end:move', 'camera:reset']);
});

test('a hold step waits the given duration without calling fx/camera', async () => {
  const order = [];
  const fxRuntime = createMockFxRuntime(order);
  const runtime = new PresentationSequenceRuntime({ fxRuntime });
  const start = Date.now();
  await runtime.run({ lane: 'ship', steps: [{ descriptor: { id: 1, delay: 3 } }, { hold: 15 }, { descriptor: { id: 2, delay: 3 } }] });
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 15);
  assert.deepEqual(order, ['start:1', 'end:1', 'start:2', 'end:2']);
});

test('run() with no steps array or a null spec resolves immediately, never throws', async () => {
  const runtime = new PresentationSequenceRuntime({});
  await assert.doesNotReject(() => runtime.run(null));
  await assert.doesNotReject(() => runtime.run({ lane: 'x' }));
});

test('a lane with no camera/fxRuntime configured still resolves correctly for steps that need them (no-op, not a crash)', async () => {
  const runtime = new PresentationSequenceRuntime({}); // no fxRuntime, no camera at all
  await assert.doesNotReject(() => runtime.run({ lane: 'ship', steps: [{ descriptor: { id: 1 } }, { camera: { reset: true } }] }));
});
