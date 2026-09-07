import test from 'node:test';
import assert from 'node:assert/strict';
import { FieldVisibility, projectFields, projectPlayerMap } from '../src/stateVisibility.js';

test('projectFields: PUBLIC fields are always visible', () => {
  const out = projectFields({ hp: 3 }, 'B', 'A', { hp: FieldVisibility.PUBLIC });
  assert.equal(out.hp, 3);
});

test('projectFields: fields default to OWNER_ONLY when not classified -- fails closed, not open', () => {
  const rules = { hp: FieldVisibility.PUBLIC }; // credits is NOT classified
  const asOwner = projectFields({ hp: 3, credits: 500 }, 'A', 'A', rules);
  const asOther = projectFields({ hp: 3, credits: 500 }, 'B', 'A', rules);
  assert.equal(asOwner.credits, 500, 'the owner sees their own unclassified field');
  assert.equal('credits' in asOther, false, 'a non-owner never sees an unclassified field -- the fail-closed default');
});

test('projectFields: HIDDEN fields are never visible to anyone, including the owner', () => {
  const out = projectFields({ serverNote: 'internal' }, 'A', 'A', { serverNote: FieldVisibility.HIDDEN });
  assert.equal('serverNote' in out, false);
});

test('projectFields: OWNER_ONLY fields on an ownerless object are visible to nobody', () => {
  const out = projectFields({ secret: 1 }, 'A', null, { secret: FieldVisibility.OWNER_ONLY });
  assert.equal('secret' in out, false);
});

test('projectFields: a custom predicate rule receives (value, viewer, owner) and decides per-call', () => {
  const rules = { hp: (value, viewer, owner) => value > 0 || viewer === owner }; // hide a dead unit's hp from opponents, but the owner can always see it
  const alive = projectFields({ hp: 5 }, 'B', 'A', rules);
  const dead = projectFields({ hp: 0 }, 'B', 'A', rules);
  const deadOwner = projectFields({ hp: 0 }, 'A', 'A', rules);
  assert.equal(alive.hp, 5);
  assert.equal('hp' in dead, false);
  assert.equal(deadOwner.hp, 0);
});

test('projectFields: non-object values pass through unchanged', () => {
  assert.equal(projectFields(null, 'A', 'A', {}), null);
  assert.equal(projectFields(5, 'A', 'A', {}), 5);
});

test('projectPlayerMap: projects each player slice using its own id as owner', () => {
  const rules = { hp: FieldVisibility.PUBLIC, credits: FieldVisibility.OWNER_ONLY };
  const players = { A: { hp: 3, credits: 100 }, B: { hp: 2, credits: 50 } };
  const viewA = projectPlayerMap(players, 'A', rules);
  assert.equal(viewA.A.credits, 100, 'A sees their own credits');
  assert.equal('credits' in viewA.B, false, 'A does not see B\'s credits');
  assert.equal(viewA.A.hp, 3);
  assert.equal(viewA.B.hp, 2, 'hp is public for both');
});

test('projectPlayerMap: a spectator (viewer=null) sees only PUBLIC fields for every player', () => {
  const rules = { hp: FieldVisibility.PUBLIC, credits: FieldVisibility.OWNER_ONLY };
  const players = { A: { hp: 3, credits: 100 }, B: { hp: 2, credits: 50 } };
  const spectatorView = projectPlayerMap(players, null, rules);
  assert.equal('credits' in spectatorView.A, false);
  assert.equal('credits' in spectatorView.B, false);
  assert.equal(spectatorView.A.hp, 3);
});
