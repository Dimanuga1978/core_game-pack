import test from 'node:test';
import assert from 'node:assert/strict';
import { diffValues, applyPatch } from '../src/patch.js';

function roundTrip(a, b) {
  const patch = diffValues(a, b);
  const result = applyPatch(a, patch);
  assert.deepEqual(result, b, `applyPatch(diffValues(a,b)) must reconstruct b exactly. patch=${JSON.stringify(patch)}`);
  return patch;
}

test('diffValues/applyPatch round-trip: primitive change', () => {
  roundTrip({ x: 1 }, { x: 2 });
});

test('diffValues/applyPatch round-trip: added and removed keys', () => {
  const patch = roundTrip({ a: 1, b: 2 }, { a: 1, c: 3 });
  assert.ok(patch.some(op => op.op === 'remove' && op.path === '/b'));
  assert.ok(patch.some(op => op.op === 'add' && op.path === '/c' && op.value === 3));
});

test('diffValues/applyPatch round-trip: nested object change produces a minimal, path-scoped op', () => {
  const patch = roundTrip({ player: { hp: 3, pos: { x: 0, y: 0 } } }, { player: { hp: 3, pos: { x: 1, y: 0 } } });
  assert.deepEqual(patch, [{ op: 'replace', path: '/player/pos/x', value: 1 }]);
});

test('diffValues/applyPatch round-trip: same-length array diffs element-wise', () => {
  const patch = roundTrip({ list: [1, 2, 3] }, { list: [1, 9, 3] });
  assert.deepEqual(patch, [{ op: 'replace', path: '/list/1', value: 9 }]);
});

test('diffValues/applyPatch round-trip: array length change replaces the whole array (avoids index-shift bugs)', () => {
  const patch = roundTrip({ list: [1, 2, 3] }, { list: [1, 2] });
  assert.deepEqual(patch, [{ op: 'replace', path: '/list', value: [1, 2] }]);
});

test('diffValues: identical values produce an empty patch', () => {
  assert.deepEqual(diffValues({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }), []);
});

test('diffValues/applyPatch round-trip: type change (object -> primitive) is a single replace, not a crash', () => {
  roundTrip({ x: { nested: 1 } }, { x: 5 });
});

test('diffValues/applyPatch round-trip: whole-document replace at the root when types are incompatible', () => {
  roundTrip({ a: 1 }, [1, 2, 3]);
});

test('diffValues: keys containing "/" and "~" are JSON-Pointer-escaped correctly', () => {
  const patch = roundTrip({ 'a/b': 1, 'c~d': 2 }, { 'a/b': 9, 'c~d': 2 });
  assert.deepEqual(patch, [{ op: 'replace', path: '/a~1b', value: 9 }]);
});

test('applyPatch does not mutate the original value', () => {
  const original = { player: { hp: 3 } };
  const patch = diffValues(original, { player: { hp: 5 } });
  applyPatch(original, patch);
  assert.equal(original.player.hp, 3, 'the base value passed to applyPatch must be left untouched');
});

test('a realistic projected-snapshot-shaped diff round-trips correctly', () => {
  const before = {
    id: 'm', status: 'running', players: ['A', 'B'], version: 3,
    state: { turn: 2, activePlayer: 'A', players: { A: { id: 'A', hp: 3, position: { x: 0, y: 0 } }, B: { id: 'B', hp: 3, position: { x: 4, y: 4 } } } },
  };
  const after = {
    id: 'm', status: 'running', players: ['A', 'B'], version: 4,
    state: { turn: 3, activePlayer: 'B', players: { A: { id: 'A', hp: 3, position: { x: 1, y: 0 } }, B: { id: 'B', hp: 3, position: { x: 4, y: 4 } } } },
  };
  const patch = roundTrip(before, after);
  // Only what actually changed -- version, turn, activePlayer, A's position -- not the whole document.
  assert.equal(patch.length, 4);
});
