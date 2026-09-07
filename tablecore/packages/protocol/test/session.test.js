import test from 'node:test';
import assert from 'node:assert/strict';
import { createTokenAuth } from '../src/index.js';

// P1-SESSION (external remediation request): "session identity ... does
// not include session revocation, distinct session ids, or issuer/
// audience claims." These tests cover exactly that gap.

test('issueToken/verifyToken expose a distinct sessionId per token, plus issuedAt/issuer', () => {
  const auth = createTokenAuth({ secret: '01234567890123456789012345678901' });
  const token = auth.issueToken({ playerId: 'A' });
  const claims = auth.verifyToken(token);
  assert.equal(typeof claims.sessionId, 'string');
  assert.ok(claims.sessionId.length > 0);
  assert.equal(typeof claims.issuedAt, 'number');
  assert.equal(claims.issuer, 'tablecore');
});

test('two tokens issued for the SAME player have DIFFERENT sessionIds', () => {
  const auth = createTokenAuth({ secret: '01234567890123456789012345678901' });
  const t1 = auth.verifyToken(auth.issueToken({ playerId: 'A' }));
  const t2 = auth.verifyToken(auth.issueToken({ playerId: 'A' }));
  assert.notEqual(t1.sessionId, t2.sessionId);
});

test('a custom issuer is recorded and returned on verification', () => {
  const auth = createTokenAuth({ secret: '01234567890123456789012345678901', issuer: 'my-game-server' });
  const claims = auth.verifyToken(auth.issueToken({ playerId: 'A' }));
  assert.equal(claims.issuer, 'my-game-server');
});

test('revoke() invalidates exactly one session, not every token for that player', () => {
  const auth = createTokenAuth({ secret: '01234567890123456789012345678901' });
  const tokenA = auth.issueToken({ playerId: 'A' });
  const tokenB = auth.issueToken({ playerId: 'A' }); // same player, different session
  const sessionA = auth.verifyToken(tokenA).sessionId;

  assert.equal(auth.revoke(sessionA), true);

  assert.equal(auth.verifyToken(tokenA), null, 'the revoked session must be rejected');
  assert.notEqual(auth.verifyToken(tokenB), null, 'a DIFFERENT session for the same player must be completely unaffected');
});

test('isRevoked reflects revocation state without needing the original token', () => {
  const auth = createTokenAuth({ secret: '01234567890123456789012345678901' });
  const claims = auth.verifyToken(auth.issueToken({ playerId: 'A' }));
  assert.equal(auth.isRevoked(claims.sessionId), false);
  auth.revoke(claims.sessionId);
  assert.equal(auth.isRevoked(claims.sessionId), true);
});

test('revoking a session for one player does not affect a different player\'s session', () => {
  const auth = createTokenAuth({ secret: '01234567890123456789012345678901' });
  const tokenA = auth.issueToken({ playerId: 'A' });
  const tokenB = auth.issueToken({ playerId: 'B' });
  auth.revoke(auth.verifyToken(tokenA).sessionId);
  assert.equal(auth.verifyToken(tokenA), null);
  assert.notEqual(auth.verifyToken(tokenB), null);
});

test('revoke() on an unknown/malformed sessionId is a safe no-op, not a throw', () => {
  const auth = createTokenAuth({ secret: '01234567890123456789012345678901' });
  assert.equal(auth.revoke('does-not-exist'), true); // recording a revocation for an id that never existed is harmless
  assert.equal(auth.revoke(null), false);
  assert.equal(auth.revoke(''), false);
});

test('a pluggable revocationStore is honored instead of the default in-memory one', () => {
  const calls = [];
  const store = {
    has(jti) { calls.push(['has', jti]); return jti === 'blocked-externally'; },
    add(jti, exp) { calls.push(['add', jti, exp]); },
  };
  const auth = createTokenAuth({ secret: '01234567890123456789012345678901', revocationStore: store });
  const token = auth.issueToken({ playerId: 'A' });
  auth.verifyToken(token);
  assert.ok(calls.some(c => c[0] === 'has'), 'verifyToken must consult the injected store');
});

test('tokens verify correctly even without revocation support being exercised (backward-compatible default path)', () => {
  const auth = createTokenAuth({ secret: '01234567890123456789012345678901' });
  const claims = auth.verifyToken(auth.issueToken({ playerId: 'A', role: 'player' }));
  assert.equal(claims.playerId, 'A');
  assert.equal(claims.role, 'player');
  assert.equal(typeof claims.expiresAt, 'number');
});
