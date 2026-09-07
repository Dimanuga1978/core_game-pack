import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuthoringTool } from '../index.js';
import { AUTHORING_API_VERSION } from '../../../packages/authoring-sdk/src/index.js';

function bundle() {
  return {
    manifest: { id: 'demo', name: 'Demo', version: '1.0.0', authoringApiVersion: AUTHORING_API_VERSION },
    schemas: { objects: { object: { fields: [{ id: 'hp', type: 'integer', min: 0, max: 99, default: 10 }] } } }
  };
}

test('createEntity creates stable content entity', () => {
  const tool = new AuthoringTool(bundle());
  const entity = tool.createEntity('objects', 'object', 'crate');
  assert.equal(entity.type, 'object');
});

test('setField uses declared schema field', () => {
  const tool = new AuthoringTool(bundle());
  tool.createEntity('objects', 'object', 'crate');
  tool.setField('objects', 'crate', 'hp', 25);
  assert.equal(tool.snapshot().content.objects.crate.fields.hp, 25);
});

test('undeclared field is rejected', () => {
  const tool = new AuthoringTool(bundle());
  tool.createEntity('objects', 'object', 'crate');
  assert.throws(() => tool.setField('objects', 'crate', 'unknown', 1));
});

test('removeEntity removes only selected entity', () => {
  const tool = new AuthoringTool(bundle());
  tool.createEntity('objects', 'object', 'crate');
  tool.createEntity('objects', 'object', 'beacon');
  assert.equal(tool.removeEntity('objects', 'crate'), true);
  assert.equal(tool.snapshot().content.objects.beacon.type, 'object');
  assert.equal(tool.snapshot().content.objects.crate, undefined);
});

test('save/load round-trip preserves authored data', async () => {
  const tool = new AuthoringTool(bundle());
  tool.createEntity('objects', 'object', 'crate');
  tool.setField('objects', 'crate', 'hp', 25);
  assert.deepEqual(tool.validate(), []);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tablecore-authoring-'));
  const file = path.join(dir, 'bundle.json');
  await tool.save(file);
  const reloaded = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(reloaded.content.objects.crate.fields.hp, 25);
});
