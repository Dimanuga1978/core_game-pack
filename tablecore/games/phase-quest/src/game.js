import { createFlow, getPhaseActions, resolveFlow } from '@tablecore/game-pack';
import { synthesizeApplyAction } from '@tablecore/core';

const flow = createFlow({
  initial: 'prepare',
  phases: {
    prepare: { actions: ['READY'], endIf: (s) => Object.values(s.ready).every(Boolean), next: 'play' },
    play: { actions: ['CLAIM'], endIf: (s) => Object.values(s.claims).some(v => v >= 3), next: 'finished' },
    finished: { actions: [] }
  }
});
const ids = (players) => players.map(p => typeof p === 'string' ? p : p.id);
const rules = {
  createInitialState({ players=['A','B'] }={}) { const ps=ids(players); return { phase:flow.initial, activePlayer:ps[0], players:ps, ready:Object.fromEntries(ps.map(p=>[p,false])), claims:Object.fromEntries(ps.map(p=>[p,0])), winner:null }; },
  getLegalActions(state, actor) {
    const allowed=getPhaseActions(flow,state.phase);
    if(state.phase==='prepare') return !state.ready[actor] && allowed.includes('READY') ? [{type:'READY'}] : [];
    if(state.phase==='play') return actor===state.activePlayer && allowed.includes('CLAIM') ? [{type:'CLAIM'}] : [];
    return [];
  },
  applyActionInPlace(state, action) {
    const s=state, events=[];
    if(s.phase==='prepare' && action.type==='READY') { s.ready[action.actor]=true; events.push({type:'PLAYER_READY',actor:action.actor}); }
    else if(s.phase==='play' && action.type==='CLAIM') {
      s.claims[action.actor]++; events.push({type:'CLAIM_MADE',actor:action.actor,total:s.claims[action.actor]});
      const winner=Object.entries(s.claims).find(([,v])=>v>=3)?.[0]; if(winner) s.winner=winner;
      else { const i=s.players.indexOf(action.actor); s.activePlayer=s.players[(i+1)%s.players.length]; events.push({type:'TURN_CHANGED',activePlayer:s.activePlayer}); }
    } else return {state:s,events:[{type:'ACTION_REJECTED',code:'UNKNOWN_ACTION'}]};
    const resolved=resolveFlow(flow,s); events.push(...resolved.events);
    if(s.phase==='finished' && s.winner) events.push({type:'GAME_FINISHED',winner:s.winner});
    return {state:s,events};
  },
  getGameStatus(state){return {finished:state.phase==='finished',winner:state.winner};}
};
// applyAction synthesized from the shared, correct implementation in
// @tablecore/core -- see games/grid-duel/src/game.js's own comment for
// the full reasoning.
export const phaseQuest = { ...rules, applyAction: synthesizeApplyAction(rules.applyActionInPlace) };
