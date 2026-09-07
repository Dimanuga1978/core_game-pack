/**
 * Data-only authoring/validation contract for Game Packs.
 * This layer is intentionally independent from runtime simulation and networking.
 */

export const AUTHORING_API_VERSION = '1.0.0';

const ID_RE = /^[a-z][a-z0-9._-]*$/;
const clone = (value) => structuredClone(value);

// Found via a manual code review, not a failing test: `fail()` only
// ever declared/accepted ONE parameter (`message`), but
// `validateValueAgainstField()`'s own 7 call sites all passed a SECOND
// argument (`path`) -- silently dropped by ordinary JS argument
// handling, since extra arguments beyond a function's own declared
// parameters are simply ignored, not an error. Confirmed directly:
// `validateEntityAgainstSchema(bundle, 'units', 'unit1', {type:'soldier',
// fields:{health:'not a number'}})` threw the bare message "must be
// finite number" -- zero indication of which field, entity, or group
// actually failed, unlike every OTHER validation error in this file
// (which all correctly embed full path context via a single template-
// literal argument). Fixed at the source (`fail()` itself now accepts
// an optional second `path` argument and folds it into the thrown
// message) rather than only patching the 7 call sites that happened to
// already need it -- this also protects any future caller who makes
// the exact same mistake.
function fail(message, path) {
  const error = new TypeError(path ? `${path}: ${message}` : message);
  // A real, related gap found alongside this same function's own
  // path-in-message fix: callers that want to report the failing path
  // STRUCTURALLY (not by re-parsing prose out of the message string --
  // see @tablecore/authoring-studio's own validate(), which needed
  // exactly this) had no way to, since a thrown Error/TypeError has no
  // `.path` property by default. Attached here, alongside the embedded
  // message, so both forms are available to whichever a caller needs.
  if (path) error.path = path;
  throw error;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
}

function assertId(value, label) {
  if (typeof value !== 'string' || !ID_RE.test(value)) fail(`Invalid ${label} id: ${value}`);
}

function validateFieldSchema(field, path) {
  assertPlainObject(field, path);
  if (typeof field.id !== 'string' || !ID_RE.test(field.id)) fail(`${path}.id must be a valid identifier`);
  if (typeof field.type !== 'string') fail(`${path}.type is required`);
  const allowed = new Set(['string', 'number', 'integer', 'boolean', 'enum', 'ref', 'color']);
  if (!allowed.has(field.type)) fail(`${path}.type is unsupported: ${field.type}`);
  if (field.label != null && typeof field.label !== 'string') fail(`${path}.label must be a string`);
  if (field.required != null && typeof field.required !== 'boolean') fail(`${path}.required must be boolean`);
  if (field.min != null && typeof field.min !== 'number') fail(`${path}.min must be number`);
  if (field.max != null && typeof field.max !== 'number') fail(`${path}.max must be number`);
  if (field.type === 'enum') {
    if (!Array.isArray(field.values) || field.values.length === 0) fail(`${path}.values is required for enum`);
    for (const value of field.values) if (typeof value !== 'string') fail(`${path}.values must contain strings`);
  }
  if (field.type === 'ref') {
    if (typeof field.group !== 'string' || !ID_RE.test(field.group)) fail(`${path}.group is required for ref`);
  }
  if (field.default !== undefined && field.type === 'number' && typeof field.default !== 'number') fail(`${path}.default must be number`);
  if (field.default !== undefined && field.type === 'integer' && !Number.isInteger(field.default)) fail(`${path}.default must be integer`);
  if (field.default !== undefined && field.type === 'boolean' && typeof field.default !== 'boolean') fail(`${path}.default must be boolean`);
}

function validateDefinitionSchema(group, definitions) {
  if (definitions == null) return;
  assertPlainObject(definitions, `${group} schemas`);
  for (const [id, schema] of Object.entries(definitions)) {
    assertId(id, `${group} schema`);
    assertPlainObject(schema, `${group}.${id}`);
    if (!Array.isArray(schema.fields)) fail(`${group}.${id}.fields must be an array`);
    for (let index = 0; index < schema.fields.length; index += 1) validateFieldSchema(schema.fields[index], `${group}.${id}.fields[${index}]`);
  }
}


function validateValueAgainstField(field, value, path) {
  if (value === undefined) { if (field.required) fail(`${path} is required`); return; }
  if (field.type === 'string' && typeof value !== 'string') fail('must be string', path);
  if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) fail('must be finite number', path);
  if (field.type === 'integer' && !Number.isInteger(value)) fail('must be integer', path);
  if (field.type === 'boolean' && typeof value !== 'boolean') fail('must be boolean', path);
  if (field.type === 'color' && (typeof value !== 'string' || !/^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value))) fail('must be hex color', path);
  if (field.type === 'enum' && (!field.values.includes(value))) fail('must be one of the declared enum values', path);
  if ((field.type === 'number' || field.type === 'integer') && typeof value === 'number') {
    if (field.min != null && value < field.min) fail(`must be >= ${field.min}`, path);
    if (field.max != null && value > field.max) fail(`must be <= ${field.max}`, path);
  }
  if (field.type === 'ref' && typeof value !== 'string') fail('reference must be a string id', path);
}

export function validateEntityAgainstSchema(bundle, group, entityId, entity) {
  assertId(entityId, `${group} entity`);
  assertPlainObject(entity, `${group}.${entityId}`);
  assertId(entity.type, `${group}.${entityId}.type`);
  const schema = bundle?.schemas?.[group]?.[entity.type];
  if (!schema) fail(`Unknown ${group} definition: ${entity.type}`);
  const fields = entity.fields ?? {};
  assertPlainObject(fields, `${group}.${entityId}.fields`);
  const declared = new Map(schema.fields.map(field => [field.id, field]));
  for (const [fieldId, value] of Object.entries(fields)) {
    if (!declared.has(fieldId)) fail(`Unknown field ${fieldId}`, `${group}.${entityId}.fields.${fieldId}`);
    validateValueAgainstField(declared.get(fieldId), value, `${group}.${entityId}.fields.${fieldId}`);
  }
  for (const field of schema.fields) validateValueAgainstField(field, fields[field.id], `${group}.${entityId}.fields.${field.id}`);
  return true;
}

export function mutateAuthoringEntity(bundle, { group, id, type, set = {}, remove = [] } = {}) {
  const next = clone(bundle);
  assertPlainObject(next, 'authoring bundle');
  assertId(group, 'content group');
  assertId(id, 'entity');
  if (!next.content) next.content = {};
  if (!next.content[group]) next.content[group] = {};
  let entity = next.content[group][id];
  if (!entity) {
    if (!type) fail('type is required when creating an entity', `content.${group}.${id}`);
    entity = { type, fields:{} };
  } else entity = clone(entity);
  if (type !== undefined) entity.type = type;
  const fields = { ...(entity.fields ?? {}) };
  for (const [fieldId, value] of Object.entries(set)) fields[fieldId] = clone(value);
  for (const fieldId of remove) delete fields[fieldId];
  entity.fields = fields;
  validateEntityAgainstSchema(next, group, id, entity);
  next.content[group][id] = entity;
  return next;
}

export function validateAuthoringManifest(manifest) {
  assertPlainObject(manifest, 'authoring manifest');
  for (const key of ['id', 'name', 'version', 'authoringApiVersion']) {
    if (typeof manifest[key] !== 'string' || !manifest[key]) fail(`Invalid manifest.${key}`);
  }
  assertId(manifest.id, 'manifest');
  if (manifest.authoringApiVersion !== AUTHORING_API_VERSION) fail(`Unsupported authoringApiVersion: ${manifest.authoringApiVersion}`);
  if (manifest.gamePackApiVersion != null && typeof manifest.gamePackApiVersion !== 'string') fail('manifest.gamePackApiVersion must be string');
  if (manifest.contentApiVersion != null && typeof manifest.contentApiVersion !== 'string') fail('manifest.contentApiVersion must be string');
  return true;
}

export function validateAuthoringBundle(bundle) {
  assertPlainObject(bundle, 'authoring bundle');
  validateAuthoringManifest(bundle.manifest);
  if (bundle.editor != null) assertPlainObject(bundle.editor, 'editor');
  validateDefinitionSchema('terrains', bundle.schemas?.terrains);
  validateDefinitionSchema('objects', bundle.schemas?.objects);
  validateDefinitionSchema('maps', bundle.schemas?.maps);
  validateDefinitionSchema('rules', bundle.schemas?.rules);
  if (bundle.fields != null) {
    if (!Array.isArray(bundle.fields)) fail('fields must be an array');
    bundle.fields.forEach((field, index) => validateFieldSchema(field, `fields[${index}]`));
  }
  return true;
}

export function lintAuthoringBundle(bundle) {
  const diagnostics = [];
  try {
    validateAuthoringBundle(bundle);
  } catch (error) {
    diagnostics.push({ severity: 'error', code: 'INVALID_AUTHORING_BUNDLE', message: error instanceof Error ? error.message : String(error) });
  }
  return Object.freeze(diagnostics.map(clone));
}

export function createAuthoringBundle(bundle) {
  validateAuthoringBundle(bundle);
  return Object.freeze(clone(bundle));
}
