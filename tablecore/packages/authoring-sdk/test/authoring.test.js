import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTHORING_API_VERSION,
  createAuthoringBundle,
  lintAuthoringBundle,
  validateAuthoringBundle,
  validateAuthoringManifest,
  validateEntityAgainstSchema,
  mutateAuthoringEntity,
} from '../src/index.js';

test('valid authoring manifest passes', () => {
  assert.equal(validateAuthoringManifest({
    id: 'sector-expedition', name: 'Sector Expedition', version: '0.1.0',
    authoringApiVersion: AUTHORING_API_VERSION, gamePackApiVersion: '1.0.0', contentApiVersion: '1.0.0'
  }), true);
});

test('authoring bundle validates editor field schemas and references', () => {
  const bundle = {
    manifest: { id: 'demo', name: 'Demo', version: '1.0.0', authoringApiVersion: AUTHORING_API_VERSION },
    editor: { categories: ['objects', 'maps'] },
    schemas: {
      objects: {
        station: { fields: [
          { id: 'collectible', type: 'boolean', label: 'Collectible', default: false },
          { id: 'terrain', type: 'ref', group: 'terrains', required: true },
        ] }
      },
      maps: {
        map: { fields: [
          { id: 'radius', type: 'integer', min: 1, max: 10, default: 2 },
          { id: 'theme', type: 'enum', values: ['desert', 'space'], default: 'space' },
        ] }
      }
    }
  };
  assert.equal(validateAuthoringBundle(bundle), true);
  assert.deepEqual(lintAuthoringBundle(bundle), []);
});

test('lint returns structured diagnostic instead of throwing', () => {
  const diagnostics = lintAuthoringBundle({
    manifest: { id: 'bad', name: 'Bad', version: '1.0.0', authoringApiVersion: '999.0.0' }
  });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].severity, 'error');
  assert.equal(diagnostics[0].code, 'INVALID_AUTHORING_BUNDLE');
});

test('created bundle is clone-safe', () => {
  const source = {
    manifest: { id: 'demo', name: 'Demo', version: '1.0.0', authoringApiVersion: AUTHORING_API_VERSION },
    fields: [{ id: 'title', type: 'string', default: 'hello' }]
  };
  const bundle = createAuthoringBundle(source);
  source.fields[0].default = 'changed';
  assert.equal(bundle.fields[0].default, 'hello');
});

test('entity values obey declared field schema', () => {
  const bundle={manifest:{id:'demo',name:'Demo',version:'1',authoringApiVersion:'1.0.0'},schemas:{objects:{crate:{fields:[{id:'hp',type:'integer',min:1,max:5,required:true},{id:'kind',type:'enum',values:['wood','metal'],required:true}]}}},content:{}};
  assert.equal(validateEntityAgainstSchema(bundle,'objects','crate',{type:'crate',fields:{hp:3,kind:'wood'}}),true);
  assert.throws(()=>validateEntityAgainstSchema(bundle,'objects','bad',{type:'crate',fields:{hp:9,kind:'wood'}}),/<= 5/);
});

test('canonical mutation API validates and updates entities atomically',()=>{ const b={manifest:{id:'demo',name:'Demo',version:'1',authoringApiVersion:AUTHORING_API_VERSION},schemas:{objects:{crate:{fields:[{id:'hp',type:'integer',min:1,max:5,required:true}]}}},content:{objects:{}}}; const n=mutateAuthoringEntity(b,{group:'objects',id:'crate1',type:'crate',set:{hp:4}}); assert.equal(n.content.objects.crate1.fields.hp,4); assert.equal(b.content.objects.crate1,undefined); assert.throws(()=>mutateAuthoringEntity(n,{group:'objects',id:'crate1',set:{hp:9}}),/must be <= 5/); });

// Regression test for a real bug found via manual code review (not a
// failing test): `fail()` only ever declared/accepted ONE parameter
// (`message`), but validateValueAgainstField()'s own call sites all
// passed a SECOND argument (`path`) -- silently dropped by ordinary JS
// argument handling. Confirmed directly before this fix: a field
// value-type mismatch threw the bare message "must be finite number",
// with zero indication of which field/entity/group actually failed,
// unlike every OTHER validation error in this file.
test('a field value-type validation failure includes the full path context in its error message, not a bare, context-free message', () => {
  const bundle = { schemas: { units: { soldier: { fields: [{ id: 'health', type: 'number' }] } } } };
  assert.throws(
    () => validateEntityAgainstSchema(bundle, 'units', 'unit1', { type: 'soldier', fields: { health: 'not a number' } }),
    /units\.unit1\.fields\.health.*must be finite number/,
  );
});

test('a field min/max range validation failure also includes the full path context', () => {
  const bundle = { schemas: { units: { soldier: { fields: [{ id: 'health', type: 'number', max: 100 }] } } } };
  assert.throws(
    () => validateEntityAgainstSchema(bundle, 'units', 'unit1', { type: 'soldier', fields: { health: 999 } }),
    /units\.unit1\.fields\.health.*must be <= 100/,
  );
});
