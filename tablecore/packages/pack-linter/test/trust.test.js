import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { lintGamePack, signPackDescriptor, verifyTrustedPackDescriptor } from '../src/index.js';

test('trusted pack descriptor verifies with Ed25519 key', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const base = { manifest: { id: 'signed-pack', version: '1.0.0' }, contentHash: 'abc123' };
  const signature = signPackDescriptor(base, privateKey.export({ type:'pkcs8', format:'pem' }));
  const descriptor = { ...base, trust: { keyId:'test-key', signature } };
  const result = verifyTrustedPackDescriptor(descriptor, {'test-key':publicKey.export({type:'spki',format:'pem'})});
  assert.equal(result.ok, true);
  assert.equal(result.keyId, 'test-key');
  assert.deepEqual(result.capabilities, []);
  // No `artifact` field on this descriptor -- the signature never
  // committed to specific file bytes, so this must say so explicitly
  // rather than silently reporting success as if bytes were checked.
  assert.equal(result.artifactVerified, 'not-declared');
});

test('trusted pack rejects tampering and unknown keys', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const base = { manifest: { id:'signed-pack', version:'1.0.0' }, contentHash:'abc123' };
  const signature = signPackDescriptor(base, privateKey.export({type:'pkcs8',format:'pem'}));
  const key = publicKey.export({type:'spki',format:'pem'});
  assert.equal(verifyTrustedPackDescriptor({...base,contentHash:'tampered',trust:{keyId:'k',signature}}, {k:key}).ok, false);
  assert.equal(verifyTrustedPackDescriptor({...base,trust:{keyId:'missing',signature}}, {}).code, 'UNKNOWN_TRUST_KEY');
});

test('linter can require a trusted signature for third-party descriptors', () => {
  const descriptor = { manifest:{id:'signed-pack',name:'Signed Pack',version:'1.0.0',apiVersion:'1.0.0'} };
  const diagnostics = lintGamePack({pack:descriptor,staticOnly:true,requireSignature:true,trustStore:{}});
  assert.equal(diagnostics.some(d=>d.code==='PACK_SIGNATURE_REQUIRED'), true);
});


test('trusted key capability policy blocks undeclared permissions', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const base = { manifest:{id:'signed-pack',version:'1.0.0'}, capabilities:['network'] };
  const signature = signPackDescriptor(base, privateKey.export({type:'pkcs8',format:'pem'}));
  const descriptor = {...base, trust:{keyId:'k',signature}};
  const key = publicKey.export({type:'spki',format:'pem'});
  const result = verifyTrustedPackDescriptor(descriptor, {k:{publicKey:key,capabilities:['local-content']}});
  assert.equal(result.code,'PACK_CAPABILITY_DENIED');
});
