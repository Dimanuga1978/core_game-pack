import { createGamePack, PACK_API_VERSION } from '@tablecore/game-pack';
import { coinRace } from './game.js';
export { coinRace } from './game.js';
export const coinRacePack = createGamePack({
  manifest:{id:'coin-race',name:'Coin Race',version:'1.0.0',apiVersion:PACK_API_VERSION,minPlayers:2,maxPlayers:4},
  game:coinRace,
  presentation:{kind:'score-race',boardless:true},
  bots:{randomLegal:({legalActions,rng=Math.random})=>legalActions[Math.floor(rng()*legalActions.length)] ?? null}
});
