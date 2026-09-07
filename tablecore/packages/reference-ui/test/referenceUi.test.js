import test from 'node:test'; import assert from 'node:assert/strict';
import { renderBoard, renderView, formatEvent } from '../src/index.js';
const snapshot={version:3,state:{phase:'playing',activePlayer:'A',players:{A:{id:'A',hp:3,position:{x:0,y:0}},B:{id:'B',hp:2,position:{x:4,y:4}}}}};
test('reference UI renders a complete 5x5 board from public state',()=>{const html=renderBoard(snapshot.state);assert.equal((html.match(/data-x=/g)||[]).length,25);});
test('reference UI consumes presentation view without engine internals',()=>{const html=renderView({frame:{version:3,state:snapshot.state,events:[{type:'TURN_CHANGED',data:{activePlayer:'A'}}]},local:{connection:'synced'}});assert.match(html,/Grid Duel/);assert.match(html,/v3/);assert.doesNotMatch(html,/ServerHost/);});
test('reference UI formats public events',()=>assert.equal(formatEvent({type:'PLAYER_ATTACKED',data:{actor:'A',target:'B'}}),'A attacked B'));
