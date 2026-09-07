import { ServerHost } from '../packages/server/src/index.js';
import { sectorExpedition } from '../games/sector-expedition/src/index.js';

const host = new ServerHost();
host.createMatch({ id:'m', game: sectorExpedition, players:['A','B'], options:{ seed: 0x12345678 } });
host.startMatch({ matchId:'m', actor:'A' });

console.log('A sees state.seed:', host.getSnapshot('m', 'A').snapshot.state.seed);
console.log('spectator sees state.seed:', host.getSnapshot('m', null).snapshot.state.seed);
console.log('=> expected 0 (or field absent) for both. Currently both leak the raw seed.');
