import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTHORING_API_VERSION } from '@tablecore/authoring-sdk';
import { AuthoringStudioModel } from '../src/index.js';

function demoBundle() {
  return {
    manifest: { id: 'studio-demo', name: 'Studio Demo', version: '1.0.0', authoringApiVersion: AUTHORING_API_VERSION },
    editor: { categories: ['objects', 'maps', 'rules'] },
    schemas: {
      objects: { object: { fields: [
        { id: 'collectible', type: 'boolean', default: false },
        { id: 'value', type: 'integer', min: 0, max: 99, default: 1 },
        { id: 'terrain', type: 'ref', group: 'terrains' },
      ] } },
      terrains: { terrain: { fields: [{ id: 'fuel_cost', type: 'integer', min: 0, max: 9, default: 1 }] } },
      maps: { map: { fields: [{ id: 'radius', type: 'integer', min: 1, max: 20, default: 2 }] } },
      rules: { rule: { fields: [{ id: 'value', type: 'number', required: true }] } },
    },
    content: { objects: {}, terrains: {}, maps: {}, rules: {} },
  };
}

test('studio creates and selects a data entity through declared schema', () => {
  const studio = new AuthoringStudioModel(demoBundle());
  const entity = studio.create('objects', 'object', 'crate', { collectible: true, value: 5, terrain: 'plain' });
  assert.equal(entity.id, 'crate');
  assert.equal(entity.fields.value, 5);
  assert.equal(studio.getSchema('objects').fields[1].id, 'value');
});

test('studio edits data without changing schema', () => {
  const studio = new AuthoringStudioModel(demoBundle());
  studio.create('objects', 'object', 'crate');
  studio.setField('objects', 'crate', 'value', 7);
  assert.equal(studio.getSchema('objects').fields[1].type, 'integer');
  assert.equal(studio.getSelection().fields.value, 7);
});

test('studio rejects undeclared editor fields', () => {
  const studio = new AuthoringStudioModel(demoBundle());
  studio.create('objects', 'object', 'crate');
  assert.throws(() => studio.setField('objects', 'crate', 'unknown', 1));
});

test('studio validation uses the authoring SDK validator', () => {
  const studio = new AuthoringStudioModel(demoBundle());
  studio.create('objects', 'object', 'crate');
  assert.deepEqual(studio.validate(), []);
});

// Regression test for a real, confirmed crash found via manual code
// review (not a failing test): lintAuthoringBundle() returns
// Object.freeze(...) (see @tablecore/authoring-sdk's own return
// value), but validate() used to push additional diagnostics directly
// onto that same frozen array -- a real TypeError ("Cannot add
// property 0, object is not extensible") in strict mode, precisely
// whenever there was at least one real entity-value validation failure
// to report -- the exact scenario this method exists to detect and
// surface gracefully, not the exact opposite.
test('validate() returns a real diagnostic instead of crashing when an entity has an invalid field value', () => {
  const studio = new AuthoringStudioModel(demoBundle());
  // create() with a value violating the field's own declared max (99) --
  // bypassing create()'s own schema-name check but still producing a
  // real, invalid field VALUE that only validate()'s own deeper check
  // (validateEntityAgainstSchema) can catch.
  studio.bundle.content.objects.crate = { type: 'object', fields: { value: 'not a number' } };
  let diagnostics;
  assert.doesNotThrow(() => { diagnostics = studio.validate(); }, 'validate() must never crash, even when it has real problems to report');
  assert.ok(diagnostics.some(d => d.code === 'INVALID_ENTITY_VALUE' && d.message.includes('crate')), 'the real, specific validation failure must actually be reported, not swallowed');
  // Now that @tablecore/authoring-sdk's own fail() attaches a real
  // `.path` property (a related fix made alongside this one), the
  // structured `path` field should be populated too, not just the
  // prose message.
  assert.ok(diagnostics.some(d => d.code === 'INVALID_ENTITY_VALUE' && d.path.includes('crate')), 'the structured path field should also be populated, not left empty when the underlying error genuinely has one');
});
