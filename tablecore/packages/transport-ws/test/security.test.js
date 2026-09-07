import test from 'node:test';
import assert from 'node:assert/strict';
import { createTokenAuth } from '@tablecore/protocol';
import { createWsServer, createWsClient } from '../src/index.js';
import { createProtocolServer } from '@tablecore/protocol';
import { ServerHost } from '@tablecore/server';
import { gridDuel } from '@tablecore/game-grid-duel';

const wait=async(fn,ms=1000)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return true;await new Promise(r=>setTimeout(r,10));}return false;};

test('token authentication derives identity from verified claims, not HELLO playerId', async()=>{
 const host=new ServerHost();host.createMatch({id:'m',game:gridDuel,players:['A','B']});host.startMatch({matchId:'m',actor:'A'});
 const auth=createTokenAuth({secret:'01234567890123456789012345678901'}); const tokenA=auth.issueToken({playerId:'A'});
 const ws=createWsServer({protocol:createProtocolServer(host),auth,resolveConnection:({claims})=>({role:claims.role,playerId:claims.playerId})}); const port=await ws.listen();
 const c=await createWsClient({port,hello:{type:'HELLO',protocolVersion:1,token:tokenA,playerId:'B'}});
 assert.equal(await wait(()=>c.messages.some(m=>m.type==='WELCOME')),true);
 const welcome=c.messages.find(m=>m.type==='WELCOME'); assert.equal(welcome.playerId,'A'); assert.equal(welcome.role,'player');
 c.close(); await ws.close();
});

test('invalid auth token is rejected', async()=>{
 const auth=createTokenAuth({secret:'01234567890123456789012345678901'}); const ws=createWsServer({protocol:createProtocolServer(new ServerHost()),auth,resolveConnection:({claims})=>claims}); const port=await ws.listen();
 const c=await createWsClient({port,hello:{type:'HELLO',protocolVersion:1,token:'forged.token',playerId:'A'}});
 assert.equal(await wait(()=>c.messages.some(m=>m.type==='ACTION_REJECTED')),true); assert.equal(c.messages.find(m=>m.type==='ACTION_REJECTED').error.code,'UNAUTHORIZED');
 c.close(); await ws.close();
});
