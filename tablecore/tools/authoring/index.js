import fs from 'node:fs/promises';
import path from 'node:path';
import { createAuthoringBundle, lintAuthoringBundle, validateAuthoringBundle } from '../../packages/authoring-sdk/src/index.js';

function clone(value) { return structuredClone(value); }

export class AuthoringTool {
  constructor(bundle) {
    validateAuthoringBundle(bundle);
    this.bundle = clone(bundle);
  }

  createEntity(group, definitionId, id, initial = {}) {
    if (!this.bundle.content) this.bundle.content = {};
    if (!this.bundle.content[group]) this.bundle.content[group] = {};
    if (typeof id !== 'string' || !/^[a-z][a-z0-9._-]*$/.test(id)) {
      throw new TypeError(`Invalid entity id: ${id}`);
    }
    const definitions = this.bundle.schemas?.[group];
    if (!definitions?.[definitionId]) throw new TypeError(`Unknown ${group} definition: ${definitionId}`);
    if (this.bundle.content[group][id]) throw new TypeError(`Entity already exists: ${group}.${id}`);
    this.bundle.content[group][id] = { type: definitionId, ...clone(initial) };
    return clone(this.bundle.content[group][id]);
  }

  setField(group, id, fieldId, value) {
    const entity = this.bundle.content?.[group]?.[id];
    if (!entity) throw new TypeError(`Unknown entity: ${group}.${id}`);
    const schema = this.bundle.schemas?.[group]?.[entity.type];
    const field = schema?.fields?.find((item) => item.id === fieldId);
    if (!field) throw new TypeError(`Unknown field: ${group}.${entity.type}.${fieldId}`);
    if (!this.bundle.content[group][id].fields) this.bundle.content[group][id].fields = {};
    this.bundle.content[group][id].fields[fieldId] = clone(value);
    return clone(this.bundle.content[group][id]);
  }

  removeEntity(group, id) {
    const entities = this.bundle.content?.[group];
    if (!entities?.[id]) return false;
    delete entities[id];
    return true;
  }

  validate() {
    return lintAuthoringBundle(this.bundle);
  }

  snapshot() {
    return clone(this.bundle);
  }

  async save(filePath) {
    const absolute = path.resolve(filePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, `${JSON.stringify(this.bundle, null, 2)}\n`, 'utf8');
    return absolute;
  }
}

export async function loadAuthoringBundle(filePath) {
  const absolute = path.resolve(filePath);
  const raw = await fs.readFile(absolute, 'utf8');
  const bundle = JSON.parse(raw);
  validateAuthoringBundle(bundle);
  return new AuthoringTool(bundle);
}
