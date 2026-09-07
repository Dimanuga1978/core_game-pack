import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresentationFrame, createUiIntent, getCapabilities, isAuthoritativeAction } from '../src/index.js';

const snapshot = { version:7, state:{ activePlayer:'A', players:{ A:{hp:3}, B:{hp:2} } } };
const events = [{ type:'PLAYER_ATTACKED', actor:'A', target:'B', damage:1 }];

test('same authoritative facts produce client-specific presentation without changing facts', () => {
  const pc = createPresentationFrame({ snapshot, events, client:'pc' });
  const mobile = createPresentationFrame({ snapshot, events, client:'mobile' });
  const tv = createPresentationFrame({ snapshot, events, client:'tv' });
  assert.deepEqual(pc.state, mobile.state);
  assert.deepEqual(pc.state, tv.state);
  assert.equal(pc.events[0].type, mobile.events[0].type);
  assert.equal(tv.events[0].data.damage, 1);
  assert.equal(pc.capabilities.effects, 'standard');
  assert.equal(mobile.capabilities.effects, 'reduced');
  assert.equal(tv.capabilities.effects, 'cinematic');
  assert.equal(tv.capabilities.input, false);
});

test('presentation frame is detached from authoritative snapshot and events', () => {
  const frame = createPresentationFrame({ snapshot, events, client:'pc' });
  snapshot.state.players.A.hp = 0;
  events[0].damage = 99;
  assert.equal(frame.state.players.A.hp, 3);
  assert.equal(frame.events[0].data.damage, 1);
});

test('local UI intents are explicitly local and cannot masquerade as actions', () => {
  const intent = createUiIntent('UI_SELECT_OBJECT', { id:'A' });
  assert.equal(intent.localOnly, true);
  assert.equal(isAuthoritativeAction(intent), false);
  assert.equal(isAuthoritativeAction({ type:'ACTION' }), true);
  assert.throws(() => createUiIntent('SELECT_OBJECT'), /UI_/);
});

test('client capabilities do not expose input for TV', () => {
  assert.equal(getCapabilities('tv').input, false);
  assert.equal(getCapabilities('pc').interactive, true);
  assert.throws(() => getCapabilities('unknown'));
});
