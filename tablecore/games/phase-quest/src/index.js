import { createGamePack, PACK_API_VERSION } from '@tablecore/game-pack';
import { phaseQuest } from './game.js';
export { phaseQuest } from './game.js';
export const phaseQuestPack=createGamePack({
 manifest:{id:'phase-quest',name:'Phase Quest',version:'1.0.0',apiVersion:PACK_API_VERSION,minPlayers:2,maxPlayers:4},
 game:phaseQuest,
 presentation:{kind:'phase-quest'},
 flow:{initial:'prepare',phases:['prepare','play','finished']}
});
