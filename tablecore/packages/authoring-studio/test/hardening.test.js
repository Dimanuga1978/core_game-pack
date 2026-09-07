import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioModel } from '../src/index.js';
const base={manifest:{id:'demo',name:'Demo',version:'1',authoringApiVersion:'1.0.0'},schemas:{objects:{crate:{fields:[{id:'hp',type:'integer',min:1,max:5,required:true},{id:'kind',type:'enum',values:['wood','metal'],required:true}]}}},content:{objects:{}}};
test('studio mutation rejects values outside declared schema',()=>{const s=createStudioModel(base); assert.throws(()=>s.create('objects','crate','box',{hp:99,kind:'wood'}),/must be <= 5/); const good=s.create('objects','crate','box',{hp:3,kind:'wood'}); assert.equal(good.id,'box'); assert.throws(()=>s.setField('objects','box','kind','stone'),/enum values/);});
