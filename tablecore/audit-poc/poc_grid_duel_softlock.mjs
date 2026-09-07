import { ServerHost } from '../packages/server/src/index.js';
import { gridDuel } from '../games/grid-duel/src/index.js';

const host = new ServerHost();
host.createMatch({ id:'m', game: gridDuel, players:['X','Y'] });
host.startMatch({ matchId:'m', actor:'X' });
const snap = host.getSnapshot('m','X');
console.log('match.players:', snap.snapshot.players);
console.log('state.players keys:', Object.keys(snap.snapshot.state.players));
const result = host.submitAction({ matchId:'m', connectionPlayerId:'X', actor:'X', expectedVersion:snap.snapshot.version, action:{type:'MOVE', direction:'E'} });
console.log('result:', JSON.stringify(result.ok ? { ok:true } : result.error));
console.log('=> the match is permanently unplayable by its own registered participants.');
