import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { ClientSession, createTokenAuth, PROTOCOL_VERSION, validateProtocolMessage } from '../src/index.js';

test('ClientSession cannot switch matches after binding', () => {
  const c=new ClientSession();
  assert.equal(c.receive({type:'SYNC',protocolVersion:PROTOCOL_VERSION,matchId:'m1',snapshot:{id:'m1',version:1}}).applied,true);
  assert.equal(c.receive({type:'SYNC',protocolVersion:PROTOCOL_VERSION,matchId:'m2',snapshot:{id:'m2',version:999}}).reason,'MATCH_MISMATCH');
  assert.equal(c.snapshot.id,'m1');
});

test('public protocol rejects invalid action envelopes', () => {
  assert.equal(validateProtocolMessage({type:'ACTION',protocolVersion:1,matchId:'m',expectedVersion:-1,action:{type:'MOVE'}}).ok,false);
  assert.equal(validateProtocolMessage({type:'ACTION',protocolVersion:1,matchId:'m',expectedVersion:1,action:null}).ok,false);
});

test('auth token cannot be forged by changing player claims', () => {
  const auth=createTokenAuth({secret:'01234567890123456789012345678901'});
  const token=auth.issueToken({playerId:'A'}); const [body,sig]=token.split('.');
  const forged=`${body}.${sig.slice(0,-1)}${sig.endsWith('A')?'B':'A'}`;
  assert.equal(auth.verifyToken(forged),null);
});

// Regression test: nothing validated playerId format anywhere in the
// pipeline, so a signed, verifiably-authentic token could carry an HTML/
// script-bearing playerId straight into any client that renders it
// (e.g. packages/reference-ui/public/main.js's innerHTML templates).
test('issueToken refuses an HTML/script-bearing playerId (stored-XSS prevention)', () => {
  const auth=createTokenAuth({secret:'01234567890123456789012345678901'});
  assert.throws(() => auth.issueToken({playerId:'<img src=x onerror=alert(1)>'}), TypeError);
  assert.throws(() => auth.issueToken({playerId:'"><script>alert(1)</script>'}), TypeError);
  // Ordinary application ids used throughout this codebase's own games
  // must keep working.
  for (const id of ['A','B','player-42','user.name_1','a1b2c3d4-uuid-style']) {
    assert.doesNotThrow(() => auth.issueToken({playerId:id}));
  }
});

test('verifyToken rejects a token whose claim would never have passed issueToken, even with a valid signature', () => {
  const auth=createTokenAuth({secret:'01234567890123456789012345678901'});
  // Simulate a token minted by some other/older code path against the same
  // secret, bypassing issueToken's own validation.
  const b64 = v => Buffer.from(v).toString('base64url');
  const body = b64(JSON.stringify({ sub:'<script>alert(1)</script>', role:'player', exp: Math.floor(Date.now()/1000)+3600 }));
  const sig = b64(crypto.createHmac('sha256','01234567890123456789012345678901').update(body).digest());
  assert.equal(auth.verifyToken(`${body}.${sig}`), null);
});
