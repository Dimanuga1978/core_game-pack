import { validateAuthoringBundle, lintAuthoringBundle, validateEntityAgainstSchema, mutateAuthoringEntity } from '@tablecore/authoring-sdk';

const clone = (value) => structuredClone(value);
const ID_RE = /^[a-z][a-z0-9._-]*$/;

function assertId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new TypeError(`Invalid entity id: ${id}`);
}

export class AuthoringStudioModel {
  constructor(bundle) {
    validateAuthoringBundle(bundle);
    this.bundle = clone(bundle);
    this.selectedGroup = 'objects';
    this.selectedId = null;
  }

  selectGroup(group) {
    if (!['terrains', 'objects', 'maps', 'rules'].includes(group)) throw new TypeError(`Unknown group: ${group}`);
    this.selectedGroup = group;
    this.selectedId = Object.keys(this.bundle.content?.[group] ?? {})[0] ?? null;
    return this.getSelection();
  }

  list(group = this.selectedGroup) {
    return Object.entries(this.bundle.content?.[group] ?? {}).map(([id, value]) => ({ id, ...clone(value) }));
  }

  create(group, definitionId, id, fields = {}) {
    if (!this.bundle.content) this.bundle.content = {};
    if (!this.bundle.content[group]) this.bundle.content[group] = {};
    assertId(id);
    if (!this.bundle.schemas?.[group]?.[definitionId]) throw new TypeError(`Unknown ${group} definition: ${definitionId}`);
    if (this.bundle.content[group][id]) throw new TypeError(`Entity already exists: ${group}.${id}`);
    this.bundle = mutateAuthoringEntity(this.bundle, { group, id, type: definitionId, set: fields });
    this.selectedGroup = group;
    this.selectedId = id;
    return this.getSelection();
  }

  delete(group, id) {
    const items = this.bundle.content?.[group];
    if (!items?.[id]) return false;
    delete items[id];
    if (this.selectedGroup === group && this.selectedId === id) {
      this.selectedId = Object.keys(items)[0] ?? null;
    }
    return true;
  }

  setField(group, id, fieldId, value) {
    const entity = this.bundle.content?.[group]?.[id];
    if (!entity) throw new TypeError(`Unknown entity: ${group}.${id}`);
    const schema = this.bundle.schemas?.[group]?.[entity.type];
    const field = schema?.fields?.find((item) => item.id === fieldId);
    if (!field) throw new TypeError(`Unknown field: ${group}.${entity.type}.${fieldId}`);
    this.bundle = mutateAuthoringEntity(this.bundle, { group, id, set: { [fieldId]: value } });
    this.selectedGroup = group;
    this.selectedId = id;
    return this.getSelection();
  }

  getSelection() {
    if (!this.selectedId) return null;
    const value = this.bundle.content?.[this.selectedGroup]?.[this.selectedId];
    return value == null ? null : { id: this.selectedId, group: this.selectedGroup, ...clone(value) };
  }

  getSchema(group, definitionId = this.getSelection()?.type) {
    return clone(this.bundle.schemas?.[group]?.[definitionId] ?? null);
  }

  validate() {
    // Found via a manual code review, not a failing test:
    // lintAuthoringBundle() returns Object.freeze(...) (see
    // @tablecore/authoring-sdk's own return value) -- pushing onto it
    // directly threw a real, confirmed TypeError ("Cannot add property
    // 0, object is not extensible") in strict mode (ES modules always
    // run in strict mode), precisely whenever there was at least one
    // real entity-value validation failure to report -- the exact
    // scenario this method exists to detect and surface gracefully.
    // Fixed by copying into a genuinely mutable array before appending
    // further diagnostics.
    const diagnostics = [...lintAuthoringBundle(this.bundle)];
    for (const group of ['terrains','objects','maps']) {
      for (const [id, entity] of Object.entries(this.bundle.content?.[group] ?? {})) {
        try { validateEntityAgainstSchema(this.bundle, group, id, entity); } catch (e) { diagnostics.push({severity:'error',code:'INVALID_ENTITY_VALUE',path:e.path??'',message:e.message}); }
      }
    }
    return diagnostics;
  }

  snapshot() {
    return clone(this.bundle);
  }
}

export function createStudioModel(bundle) {
  return new AuthoringStudioModel(bundle);
}
