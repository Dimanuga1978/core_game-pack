import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetricsRegistry, buildStructuredMetrics } from '../src/index.js';

test('createMetricsRegistry: inc() accumulates, defaulting missing counters to 0', () => {
  const m = createMetricsRegistry();
  m.inc('foo');
  m.inc('foo', 5);
  assert.equal(m.get('foo'), 6);
});

test('createMetricsRegistry: set() supports gauges that can go up and down, unlike inc()', () => {
  const m = createMetricsRegistry();
  m.set('activeThings', 3);
  m.set('activeThings', 1);
  assert.equal(m.get('activeThings'), 1);
});

test('createMetricsRegistry: initialValues seeds a predictable key set from the first snapshot', () => {
  const m = createMetricsRegistry({ a: 0, b: 0 });
  assert.deepEqual(m.snapshot(), { a: 0, b: 0 });
});

test('createMetricsRegistry: snapshot() is frozen and independent of later mutation', () => {
  const m = createMetricsRegistry({ a: 0 });
  const snap = m.snapshot();
  m.inc('a');
  assert.equal(snap.a, 0, 'a previously-taken snapshot must not reflect later changes');
  assert.throws(() => { snap.a = 99; }, TypeError, 'snapshot() results must be frozen');
});

test('buildStructuredMetrics: combines server/game/network into the four documented categories, resource computed live', () => {
  const startedAt = Date.now() - 5000;
  const result = buildStructuredMetrics({
    server: { customField: 1 },
    game: { matchesCreated: 3, activeMatches: 2 },
    network: { connectionsOpened: 10 },
    startedAt,
  });
  assert.ok(result.server.uptimeSeconds >= 4.9, 'uptimeSeconds derived from startedAt');
  assert.equal(result.server.customField, 1);
  assert.equal(result.game.matchesCreated, 3);
  assert.equal(result.game.activeMatches, 2);
  assert.equal(result.network.connectionsOpened, 10);
  assert.equal(typeof result.resource.memory.heapUsed, 'number', 'resource.memory is real process.memoryUsage() data, not a placeholder');
});

test('buildStructuredMetrics: uptimeSeconds is null when startedAt is not supplied, not a fabricated 0', () => {
  const result = buildStructuredMetrics({ server: {}, game: {}, network: {} });
  assert.equal(result.server.uptimeSeconds, null);
});

test('buildStructuredMetrics: every category is frozen', () => {
  const result = buildStructuredMetrics({ game: { x: 1 } });
  assert.throws(() => { result.game.x = 99; }, TypeError);
  assert.throws(() => { result.newCategory = {}; }, TypeError);
});
