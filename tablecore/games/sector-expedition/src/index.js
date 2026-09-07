import { sectorExpedition } from './game.js';
import { contentCatalog, buildSectorMap } from './content.js';

const distance=(a,b)=>Math.max(Math.abs(a.q-b.q),Math.abs(a.r-b.r),Math.abs((a.q-a.r)-(b.q-b.r)));
const salvageTargets=(state,player)=>Object.values(state.map).filter(t=>t.object==='salvage' && !t.collectedBy?.includes(player.id)).map(t=>({q:t.q,r:t.r}));
const stepToward=(state,player)=>{
  const targets=player.salvage>=3 ? [{q:0,r:0}] : salvageTargets(state,player);
  if(!targets.length)return null;
  let best=null,bestScore=Infinity;
  for(const d of [[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]]){
    const q=player.position.q+d[0],r=player.position.r+d[1],tile=state.map[`${q},${r}`];
    if(!tile||player.fuel<1||Object.values(state.players).some(p=>p.id!==player.id&&p.position.q===q&&p.position.r===r))continue;
    const score=Math.min(...targets.map(t=>distance({q,r},t)));
    if(score<bestScore){bestScore=score;best={q,r};}
  }
  return best;
};

const randomLegal = (state, actor, { rng }) => {
  const player=state.players[actor];
  const tile=state.map[`${player.position.q},${player.position.r}`];
  if (tile?.object==='salvage' && !tile.collectedBy?.includes(actor)) return {type:'SALVAGE',actor};
  if (player.salvage>=3 && tile?.object==='station') return {type:'END_TURN',actor};
  const candidate=stepToward(state,player);
  const choices=[];
  if(tile?.object==='station')choices.push({type:'SCAN',actor});
  if(candidate)choices.push({type:'MOVE',actor,target:candidate});
  if(tile?.object==='station'&&player.credits>=500&&player.fuel<=1)choices.push({type:'BUY_FUEL',actor});
  choices.push({type:'END_TURN',actor});
  return choices[rng?.int(0,choices.length-1) ?? 0];
};

const aggressive = (state, actor) => {
  const player=state.players[actor];
  const tile=state.map[`${player.position.q},${player.position.r}`];
  if(tile?.object==='salvage' && !tile.collectedBy?.includes(actor)) return {type:'SALVAGE',actor};
  const candidate=stepToward(state,player);
  if(candidate)return {type:'MOVE',actor,target:candidate};
  if(tile?.object==='station'&&player.credits>=500&&player.fuel<3)return {type:'BUY_FUEL',actor};
  return {type:'END_TURN',actor};
};

export const sectorExpeditionPack = Object.freeze({
  manifest:{id:'sector-expedition',name:'Sector Expedition',version:'0.1.0',apiVersion:'1.0.0',hiddenInformation:true},
  game:sectorExpedition,
  presentation:{clients:['pc','mobile','tv'],map:'hex',cinematicEvents:['SECTOR_SCANNED','HAZARD_TRIGGERED','GAME_FINISHED']},
  bots:{randomLegal:randomLegal,aggressive},
});

export { sectorExpedition, contentCatalog, buildSectorMap };
