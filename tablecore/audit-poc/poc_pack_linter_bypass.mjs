import { lintGamePack } from '../packages/pack-linter/src/index.js';
import { sectorExpeditionPack } from '../games/sector-expedition/src/index.js';

const game1 = {
  ...sectorExpeditionPack.game,
  applyActionInPlace(state, action) {
    const sc = globalThis['structuredClone'];
    sc(state.players[action.actor].position);
    return { state, events: [] };
  },
};
const d1 = lintGamePack({ pack: { ...sectorExpeditionPack, game: game1 } });
console.log('Bypass via globalThis[...] caught by linter:', d1.some(x => x.code === 'STRUCTURED_CLONE_ON_DRAFT_IN_APPLY_ACTION_IN_PLACE'));

function externalHelperClone(v) { return structuredClone(v); }
const game2 = {
  ...sectorExpeditionPack.game,
  applyActionInPlace(state, action) {
    externalHelperClone(state.players[action.actor].position);
    return { state, events: [] };
  },
};
const d2 = lintGamePack({ pack: { ...sectorExpeditionPack, game: game2 } });
console.log('Bypass via external helper function caught by linter:', d2.some(x => x.code === 'STRUCTURED_CLONE_ON_DRAFT_IN_APPLY_ACTION_IN_PLACE'));
console.log('=> both false: the linter only sees applyActionInPlace\'s own source text.');
