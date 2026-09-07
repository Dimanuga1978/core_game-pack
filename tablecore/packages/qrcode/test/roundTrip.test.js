import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeQr } from '../src/encoder.js';
import { decodeQr } from '../src/decoder.js';

test('round trip: a real, realistic join-code URL', () => {
  const text = 'http://192.168.1.42:4170/j/Ab3Fk9';
  const decoded = decodeQr(encodeQr(text));
  assert.equal(decoded.text, text);
  assert.equal(decoded.formatValid, true);
});

test('round trip: shortest realistic payload', () => {
  const text = 'http://x/j/A';
  const decoded = decodeQr(encodeQr(text));
  assert.equal(decoded.text, text);
});

test('round trip: a range of lengths spanning multiple version boundaries', () => {
  for (const length of [1, 5, 10, 14, 15, 17, 20, 26, 30, 40, 50, 60, 80, 100, 120]) {
    const text = 'x'.repeat(length);
    let decoded;
    try {
      decoded = decodeQr(encodeQr(text));
    } catch (error) {
      assert.fail(`length ${length} failed: ${error.message}`);
    }
    assert.equal(decoded.text, text, `length ${length}`);
  }
});

test('round trip: text using the full printable ASCII range a URL might contain', () => {
  const text = 'http://192.168.1.100:4170/j/AbC123?x=y&z=w#frag-_.~';
  const decoded = decodeQr(encodeQr(text));
  assert.equal(decoded.text, text);
});

test('every supported version (1-6) individually produces a valid, round-trippable code at its approximate capacity', () => {
  const capacities = { 1: 17, 2: 30, 3: 51, 4: 74, 5: 100, 6: 120 };
  let previousVersion = 0;
  for (const [expectedVersion, byteCount] of Object.entries(capacities)) {
    const text = 'a'.repeat(byteCount);
    const encoded = encodeQr(text);
    assert.ok(encoded.version >= previousVersion, `version must not decrease as payload grows (got ${encoded.version} after ${previousVersion})`);
    previousVersion = encoded.version;
    const decoded = decodeQr(encoded);
    assert.equal(decoded.text, text, `version ${encoded.version}`);
    assert.equal(decoded.formatValid, true);
  }
  assert.equal(previousVersion, 6, 'the largest test payload must actually reach version 6, or this test is not exercising the full supported range');
});

test('decoded ecLevelBits and maskPattern always match what the encoder actually used (M=00, mask 0)', () => {
  const decoded = decodeQr(encodeQr('http://example/j/test123'));
  assert.equal(decoded.ecLevelBits, 0b00, 'EC level M');
  assert.equal(decoded.maskPattern, 0);
});

test('a payload too long for version 6 throws a clear RangeError instead of silently truncating or corrupting', () => {
  const tooLong = 'x'.repeat(200);
  assert.throws(() => encodeQr(tooLong), RangeError);
});

test('the modules grid is square and matches the expected size for the chosen version', () => {
  const encoded = encodeQr('http://192.168.1.1:4170/j/xyz');
  assert.equal(encoded.modules.length, encoded.size);
  for (const row of encoded.modules) assert.equal(row.length, encoded.size);
});

test('two different payloads produce different module grids (not a degenerate/constant encoder)', () => {
  const a = encodeQr('http://a/j/aaaaaa');
  const b = encodeQr('http://a/j/bbbbbb');
  assert.notDeepEqual(a.modules, b.modules);
});

test('encoding the same text twice is fully deterministic', () => {
  const text = 'http://192.168.1.42:4170/j/deterministic';
  const a = encodeQr(text);
  const b = encodeQr(text);
  assert.deepEqual(a.modules, b.modules);
  assert.equal(a.version, b.version);
});
