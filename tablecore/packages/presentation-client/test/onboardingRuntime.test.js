import test from 'node:test';
import assert from 'node:assert/strict';
import { OnboardingRuntime } from '../src/onboarding-runtime.js';

test('start() emits the first step', () => {
  const emitted = [];
  const runtime = new OnboardingRuntime({ steps: ['a', 'b', 'c'], onStep: (step, index, total) => emitted.push({ step, index, total }) });
  runtime.start();
  assert.deepEqual(emitted, [{ step: 'a', index: 0, total: 3 }]);
});

test('next() advances through steps in order', () => {
  const emitted = [];
  const runtime = new OnboardingRuntime({ steps: ['a', 'b', 'c'], onStep: step => emitted.push(step) });
  runtime.start();
  runtime.next();
  runtime.next();
  assert.deepEqual(emitted, ['a', 'b', 'c']);
});

test('next() on the LAST step completes instead of going out of bounds', () => {
  let completed = false;
  const runtime = new OnboardingRuntime({ steps: ['a', 'b'], onComplete: () => { completed = true; } });
  runtime.start();
  runtime.next();
  assert.equal(completed, false, 'reaching the last step is not yet complete');
  runtime.next();
  assert.equal(completed, true, 'advancing past the last step completes the tutorial');
});

test('prev() goes back a step, and does nothing at the first step', () => {
  const emitted = [];
  const runtime = new OnboardingRuntime({ steps: ['a', 'b', 'c'], onStep: step => emitted.push(step) });
  runtime.start();
  runtime.next();
  runtime.prev();
  runtime.prev(); // already at index 0 -- must be a no-op, must NOT re-emit
  assert.deepEqual(emitted, ['a', 'b', 'a'], 'the second prev() at index 0 is a no-op and must not fire onStep again');
  assert.equal(runtime.index, 0);
});

test('skip() completes immediately regardless of current step', () => {
  let completed = false;
  const runtime = new OnboardingRuntime({ steps: ['a', 'b', 'c'], onComplete: () => { completed = true; } });
  runtime.start();
  runtime.skip();
  assert.equal(completed, true);
});

test('onComplete fires exactly once even if next()/skip() are called again afterward', () => {
  let completions = 0;
  const runtime = new OnboardingRuntime({ steps: ['a'], onComplete: () => { completions++; } });
  runtime.start();
  runtime.next(); // completes (only step, advancing past it)
  runtime.next();
  runtime.skip();
  assert.equal(completions, 1);
});

test('an empty steps array completes immediately on start()', () => {
  let completed = false;
  const runtime = new OnboardingRuntime({ steps: [], onComplete: () => { completed = true; } });
  runtime.start();
  assert.equal(completed, true);
});

test('currentStep and isComplete reflect real state', () => {
  const runtime = new OnboardingRuntime({ steps: ['a', 'b'] });
  assert.equal(runtime.isComplete, false);
  runtime.start();
  assert.equal(runtime.currentStep, 'a');
  runtime.skip();
  assert.equal(runtime.isComplete, true);
  assert.equal(runtime.currentStep, 'a', 'currentStep still reflects the last active step, not null, after completion');
});

test('no callbacks supplied at all does not throw', () => {
  const runtime = new OnboardingRuntime({ steps: ['a', 'b'] });
  assert.doesNotThrow(() => { runtime.start(); runtime.next(); runtime.prev(); runtime.skip(); });
});
