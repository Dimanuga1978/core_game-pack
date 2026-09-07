// A deliberately different reference game: first player to reach 5 wins; no grid, HP or attacks.
import { synthesizeApplyAction } from '@tablecore/core';
const rules = {
  createInitialState({ players = ['A','B'] } = {}) { const ids = players.map(p => typeof p === 'string' ? p : p.id); return { activePlayer: ids[0], scores: Object.fromEntries(ids.map(id=>[id,0])), target:5, phase:'playing', winner:null }; },
  getLegalActions(state, actor) { return state.phase === 'playing' && actor === state.activePlayer ? [{ type:'ADVANCE' }] : []; },
  applyActionInPlace(state, action) { const s=state; if(action.type!=='ADVANCE') return {state:s,events:[{type:'ACTION_REJECTED',code:'UNKNOWN_ACTION'}]}; s.scores[action.actor]++; const events=[{type:'PLAYER_ADVANCED',actor:action.actor,score:s.scores[action.actor]}]; if(s.scores[action.actor]>=s.target){s.phase='finished';s.winner=action.actor;events.push({type:'GAME_FINISHED',winner:action.actor});return {state:s,events};} const ids=Object.keys(s.scores);s.activePlayer=ids[(ids.indexOf(action.actor)+1)%ids.length];events.push({type:'TURN_CHANGED',activePlayer:s.activePlayer});return {state:s,events}; },
  getGameStatus(state){return {finished:state.phase==='finished',winner:state.winner};}
};
// applyAction synthesized from the shared, correct implementation in
// @tablecore/core -- see games/grid-duel/src/game.js's own comment for
// the full reasoning.
export const coinRace = { ...rules, applyAction: synthesizeApplyAction(rules.applyActionInPlace) };
