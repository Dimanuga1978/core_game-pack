import test from 'node:test';
import assert from 'node:assert/strict';
import { websocketTestCodec } from '../src/index.js';

function concat(...xs) { return Buffer.concat(xs); }

test('RFC6455 codec encodes and parses 64-bit payload length', () => {
  const payload = Buffer.alloc(70000, 7);
  const frame = websocketTestCodec.encodeFrame(payload, 1, false, true);
  assert.equal(frame[1] & 0x7f, 127);
  const parsed = websocketTestCodec.parseFrame(frame, false);
  assert.equal(parsed.payload.length, payload.length);
  assert.deepEqual(parsed.payload, payload);
});

test('RFC6455 parser reassembles fragmented text messages', () => {
  const payload = Buffer.from('{"type":"ACTION","matchId":"m","action":{"type":"MOVE"}}');
  const a = websocketTestCodec.encodeFrame(payload.subarray(0, 17), 1, true, false);
  const b = websocketTestCodec.encodeFrame(payload.subarray(17), 0, true, true);
  const stream = concat(a, b);
  const result = websocketTestCodec.parseMessageStream(stream, new (class {
    constructor(){ this.opcode=null; this.parts=[]; this.total=0; }
    push(frame){
      if(frame.opcode===1){this.opcode=1;this.parts=[frame.payload];this.total=frame.payload.length;}
      else {this.parts.push(frame.payload);this.total+=frame.payload.length;}
      if(!frame.fin)return null; const out={opcode:this.opcode,payload:Buffer.concat(this.parts,this.total)}; this.opcode=null;this.parts=[];this.total=0;return out;
    }
  })(), true);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].message.payload.toString(), payload.toString());
});

test('RFC6455 parser rejects non-minimal 64-bit lengths', () => {
  const buf = Buffer.alloc(2 + 8);
  buf[0] = 0x81; buf[1] = 127; buf.writeBigUInt64BE(10n, 2);
  assert.throws(() => websocketTestCodec.parseFrame(buf, false), /Non-minimal/);
});

test('RFC6455 parser rejects reserved opcodes', () => {
  const buf = Buffer.from([0x8b, 0]);
  assert.throws(() => websocketTestCodec.parseFrame(buf, false), /Unsupported WebSocket opcode/);
});


test('RFC6455 parser accepts interleaved control frames during fragmented messages', () => {
  const a = websocketTestCodec.encodeFrame(Buffer.from('hello '), 1, true, false);
  const ping = websocketTestCodec.encodeFrame(Buffer.from('x'), 9, true, true);
  const b = websocketTestCodec.encodeFrame(Buffer.from('world'), 0, true, true);
  const stream = Buffer.concat([a,ping,b]);
  const assembler = new (class { constructor(){this.opcode=null;this.parts=[];this.total=0;} push(f){ if(f.opcode===1){this.opcode=1;this.parts=[f.payload];this.total=f.payload.length;} else {this.parts.push(f.payload);this.total+=f.payload.length;} if(!f.fin)return null;const m={opcode:this.opcode,payload:Buffer.concat(this.parts)};this.opcode=null;this.parts=[];this.total=0;return m;} })();
  const result=websocketTestCodec.parseMessageStream(stream,assembler,true);
  assert.equal(result.messages.length,2);
  assert.equal(result.messages[0].control,true);
  assert.equal(result.messages[1].message.payload.toString(),'hello world');
});

test('RFC6455 parser rejects invalid close payload', () => {
  const frame = websocketTestCodec.encodeFrame(Buffer.from([0x03]), 8, false, true);
  assert.throws(() => websocketTestCodec.parseFrame(frame, false), /Invalid close payload length/);
});
