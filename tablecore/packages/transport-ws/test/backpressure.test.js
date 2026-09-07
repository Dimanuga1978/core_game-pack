import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutboundGuard } from '../src/index.js';

// P1-BP (external remediation request, section 10/41): outbound writes
// never checked socket.write()'s return value or enforced any ceiling on
// queued-but-unflushed bytes. This tests the enforcement POLICY
// (createOutboundGuard) directly against a mock socket with a fully
// controllable `writableLength`, rather than an end-to-end test racing
// real OS/kernel TCP buffers on loopback -- for small messages those
// drain fast enough that genuinely reproducing backpressure is slow and
// environment-dependent. The wiring into the real socket layer
// (`net.Socket.writableLength`/`.write()`) is exactly what `net.Socket`
// itself already guarantees; what needed testing is the policy built on
// top of it, which is what this covers deterministically.

function mockConnection({ writable = true, destroyed = false, writeReturns = true, writableLength = 0 } = {}) {
  let closed = null;
  const socket = { writable, destroyed, writableLength, write: () => writeReturns };
  return {
    socket,
    forceClose: (code, reason) => { closed = { code, reason }; },
    get closed() { return closed; },
  };
}

function metricsSpy() {
  const values = {};
  return { inc: (name, n = 1) => { values[name] = (values[name] ?? 0) + n; }, values };
}

test('writes normally and does not disconnect when the queue stays under the ceiling', () => {
  const metrics = metricsSpy();
  const write = createOutboundGuard({ metrics, maxQueuedBytes: 1000 });
  const conn = mockConnection({ writableLength: 100 });
  write(conn, Buffer.from('hello'));
  assert.equal(conn.closed, null);
  assert.equal(metrics.values.bytesSent, 5);
  assert.equal(metrics.values.backpressureDisconnects, undefined);
});

test('force-closes the connection once writableLength exceeds maxQueuedBytes', () => {
  const metrics = metricsSpy();
  const write = createOutboundGuard({ metrics, maxQueuedBytes: 1000 });
  const conn = mockConnection({ writableLength: 5000 }); // already over the ceiling by the time this write happens
  write(conn, Buffer.from('x'));
  assert.deepEqual(conn.closed, { code: 1013, reason: 'outbound backpressure limit exceeded' });
  assert.equal(metrics.values.backpressureDisconnects, 1);
});

test('a write() returning false (socket internal buffer over its own highWaterMark) is tracked but does not by itself force-close', () => {
  const metrics = metricsSpy();
  const write = createOutboundGuard({ metrics, maxQueuedBytes: 1000 });
  const conn = mockConnection({ writeReturns: false, writableLength: 100 }); // under the hard ceiling
  write(conn, Buffer.from('x'));
  assert.equal(conn.closed, null, 'write() returning false alone is a soft signal, not the hard ceiling');
  assert.equal(metrics.values.backpressureEvents, 1);
});

test('does nothing (no throw) for a destroyed or non-writable socket', () => {
  const metrics = metricsSpy();
  const write = createOutboundGuard({ metrics, maxQueuedBytes: 1000 });
  assert.doesNotThrow(() => write(mockConnection({ destroyed: true }), Buffer.from('x')));
  assert.doesNotThrow(() => write(mockConnection({ writable: false }), Buffer.from('x')));
  assert.doesNotThrow(() => write({ socket: null }, Buffer.from('x')));
  assert.equal(metrics.values.bytesSent, undefined, 'no write should have been attempted on an unwritable/destroyed/missing socket');
});

test('one connection exceeding the ceiling does not affect writes to a separate, healthy connection', () => {
  const metrics = metricsSpy();
  const write = createOutboundGuard({ metrics, maxQueuedBytes: 1000 });
  const slow = mockConnection({ writableLength: 5000 });
  const fast = mockConnection({ writableLength: 10 });
  write(slow, Buffer.from('x'));
  write(fast, Buffer.from('hello'));
  assert.ok(slow.closed, 'the slow connection is force-closed');
  assert.equal(fast.closed, null, 'the fast connection is completely unaffected');
  assert.equal(metrics.values.bytesSent, 6, 'both writes were still attempted -- the slow one is not skipped, only flagged for disconnect after the fact');
});
