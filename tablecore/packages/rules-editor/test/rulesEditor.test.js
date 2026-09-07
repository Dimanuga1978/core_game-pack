import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuleSet, createRulesEditor, RULES_EDITOR_API_VERSION, validateRuleDefinition, validateRuleSet } from '../src/index.js';

const rule = {
  id: 'collect-salvage',
  name: 'Collect Salvage',
  enabled: true,
  when: { type: 'all', conditions: [
    { type: 'phase', name: 'playing' },
    { type: 'compare', path: 'player.salvage', operator: 'lt', value: 3 },
  ] },
  then: [
    { type: 'add', path: 'player.salvage', value: 1 },
    { type: 'emit', event: 'SALVAGE_COLLECTED', payload: { amount: 1 } },
  ],
};

const ruleSet = { apiVersion: RULES_EDITOR_API_VERSION, id: 'sector-rules', name: 'Sector Rules', parameters: { salvage_goal: 3 }, rules: [rule] };

test('rule definition and rule set validate as data', () => {
  assert.equal(validateRuleDefinition(rule), true);
  assert.equal(validateRuleSet(ruleSet), true);
  assert.deepEqual(createRuleSet(ruleSet).parameters, { salvage_goal: 3 });
});

test('rules editor creates, updates and removes declarative rules', () => {
  const editor = createRulesEditor(ruleSet);
  editor.setParameter('fuel_cost', 1);
  editor.createRule({
    id: 'fuel-purchase',
    when: { type: 'has', path: 'player.credits' },
    then: [{ type: 'subtract', path: 'player.credits', value: 500 }],
  });
  editor.updateRule('fuel-purchase', { enabled: false });
  assert.equal(editor.getRule('fuel-purchase').enabled, false);
  assert.equal(editor.removeRule('fuel-purchase'), true);
  assert.equal(editor.getRule('fuel-purchase'), null);
  assert.deepEqual(editor.snapshot().parameters, { salvage_goal: 3, fuel_cost: 1 });
});

test('invalid rule nodes are rejected without execution', () => {
  assert.throws(() => validateRuleDefinition({
    id: 'bad-rule',
    when: { type: 'compare', path: 'x', operator: 'execute', value: 1 },
    then: [{ type: 'set', path: 'x', value: 2 }],
  }), /unsupported operator/);
  const editor = createRulesEditor(ruleSet);
  assert.deepEqual(editor.validate(), []);
});

test('editor snapshots are clone-safe', () => {
  const editor = createRulesEditor(ruleSet);
  const snapshot = editor.snapshot();
  snapshot.rules[0].then[0].value = 999;
  assert.equal(editor.getRule('collect-salvage').then[0].value, 1);
});
