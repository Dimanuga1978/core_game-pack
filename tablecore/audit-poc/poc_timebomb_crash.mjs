import { runAction } from '../packages/core/src/runAction.js';

const timeBombGame = {
  createInitialState: () => ({ value: 1 }),
  getLegalActions: () => [{ type:'TOUCH' }],
  applyActionInPlace(state) {
    setTimeout(() => { state.value = 999; }, 50); // ordinary buggy game code, no malice needed
    return { state, events: [] };
  },
};

const s = timeBombGame.createInitialState();
const result = runAction({ game: timeBombGame, state: s, action: { type:'TOUCH', actor:'A' } });
console.log('immediate result.ok:', result.ok, '-- server considers this action successful');
console.log('process still running, waiting for the time bomb...');
// No process.on('uncaughtException') handler here on purpose: this is what
// a real deployment looks like unless the integrator adds one themselves.
