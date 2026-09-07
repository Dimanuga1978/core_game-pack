import crypto from 'node:crypto';
import { PLAYER_ID_RE } from '@tablecore/core';

const b64 = value => Buffer.from(value).toString('base64url');
const unb64 = value => Buffer.from(value, 'base64url').toString('utf8');

// Nothing anywhere upstream of this validated playerId format: any
// non-empty string was accepted and signed into a token, then flowed
// through ServerHost/protocol untouched into `connection.playerId`, which
// reference UIs (and, plausibly, real integrators' clients) interpolate
// into HTML. An id like `<img src=x onerror=...>` becoming a *signed,
// verifiably-authentic* token claim is a stored-XSS vector for every
// client that ever renders it, not a rendering-layer-only problem -- so
// the fix belongs here, at the one place every playerId is minted,
// not only in each individual renderer.
//
// Re-exported from core/createMatch.js rather than declared separately:
// two independent copies of "what a valid player id looks like" is
// exactly how a cache-key collision slipped through PLAYER_ID_RE's own
// blind spot (see ServerHost.getSnapshot's viewerKey prefixing fix) --
// createMatch() is the single place that actually decides what player
// ids a match can have, so it is the canonical source, not this file.
export const SAFE_PLAYER_ID_RE = PLAYER_ID_RE;

// --- Session model (P1-SESSION) -----------------------------------------
//
// Before this, a token was a bare `{sub, role, exp}` claim: no per-token
// identity distinct from the player id (two tokens for the same player
// are indistinguishable), no issuer, no notion of "this specific token,
// not just this player, is no longer trusted". A stolen or leaked token
// could only ever be invalidated by rotating the shared secret --
// which invalidates EVERY token for EVERY player, not just the one that
// leaked.
//
// `jti` (JWT terminology, kept because it is the standard, recognizable
// name for this concept -- a unique id for this specific token/session,
// independent of the player it belongs to) is what makes per-token
// revocation possible: `revoke(jti)` invalidates exactly one session,
// `verifyToken()` checks the revocation store on every call. The default
// store is a simple in-memory Set with lazy expiry-based cleanup --
// adequate for a single process and for tests; a real multi-process
// deployment would inject a shared store (Redis, a database) via the
// same three-method interface (`has`/`add`/`prune`) rather than needing
// any change to this file.
function createInMemoryRevocationStore() {
  const revoked = new Map(); // jti -> expiresAt (seconds), so entries can be pruned once their token would have expired anyway regardless of revocation
  return {
    has(jti) { return revoked.has(jti); },
    add(jti, expiresAt) { revoked.set(jti, expiresAt); },
    prune(nowSeconds = Math.floor(Date.now() / 1000)) {
      for (const [jti, expiresAt] of revoked) if (expiresAt < nowSeconds) revoked.delete(jti);
    },
    size() { return revoked.size; },
  };
}

export function createTokenAuth({ secret, ttlSeconds = 3600, issuer = 'tablecore', revocationStore = null, allowedRoles = ['player', 'spectator'] } = {}) {
  if (typeof secret !== 'string' || secret.length < 32) throw new TypeError('Auth secret must be at least 32 characters');
  const store = revocationStore ?? createInMemoryRevocationStore();
  // `allowedRoles` is an explicit opt-in, not a silently-permissive
  // "accept any string" -- default is unchanged from before
  // (player/spectator only), matching this codebase's established
  // pattern for capability flags (spectatorPolicy, resourceLimits, ...):
  // a deployment that wants a non-player, non-generic-spectator role (a
  // TV/broadcast presentation client, say -- see visibility.js's
  // `role:X` audience targeting, which this exists to make actually
  // reachable end-to-end) has to say so explicitly, rather than any
  // string in a token's `role` claim silently being trusted. This gap
  // was found directly while wiring up a real TV connection end-to-end
  // through the actual auth+transport stack: `role:X` event targeting
  // and the fail-closed non-player ACL gate both already existed and
  // worked, but nothing had ever extended token issuance to let a
  // connection legitimately claim a role other than player/spectator in
  // the first place, so the mechanism was unreachable in practice.
  const roles = new Set(allowedRoles);
  if (!roles.has('player')) throw new TypeError('allowedRoles must include "player"');
  const sign = payload => b64(crypto.createHmac('sha256', secret).update(payload).digest());
  return {
    issueToken({ playerId = null, role = playerId ? 'player' : 'spectator', ttl = ttlSeconds } = {}) {
      if (!roles.has(role)) throw new TypeError(`Invalid role: ${role}. Allowed: ${[...roles].join(', ')}`);
      if (role === 'player' && (typeof playerId !== 'string' || !SAFE_PLAYER_ID_RE.test(playerId))) throw new TypeError(`playerId must match ${SAFE_PLAYER_ID_RE}`);
      const now = Math.floor(Date.now() / 1000);
      const jti = crypto.randomUUID();
      const body = b64(JSON.stringify({ jti, sub:playerId, role, iss:issuer, iat:now, exp:now+ttl }));
      return `${body}.${sign(body)}`;
    },
    verifyToken(token) {
      if (typeof token !== 'string') return null;
      const parts = token.split('.'); if (parts.length !== 2) return null;
      const [body, signature] = parts;
      let expected; try { expected = sign(body); } catch { return null; }
      const a=Buffer.from(signature), b=Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a,b)) return null;
      // Symmetric with issueToken: a syntactically-signed token whose claim
      // would never have been issued in the first place (e.g. minted by
      // some other/older code path against the same secret) is rejected
      // rather than trusted just because the signature checks out.
      try {
        const claims=JSON.parse(unb64(body));
        if (!claims || !roles.has(claims.role)) return null;
        if (typeof claims.exp !== 'number' || claims.exp < Math.floor(Date.now()/1000)) return null;
        if (claims.role==='player' && (typeof claims.sub!=='string' || !SAFE_PLAYER_ID_RE.test(claims.sub))) return null;
        // Tokens minted before this change (or by any code path that
        // doesn't set jti) have no session identity to check for
        // revocation against -- they verify as before, just without
        // revocation support, rather than being rejected outright for a
        // field that didn't exist when they were designed.
        if (typeof claims.jti === 'string' && store.has(claims.jti)) return null;
        return Object.freeze({
          playerId: claims.sub ?? null,
          role: claims.role,
          expiresAt: claims.exp,
          sessionId: claims.jti ?? null,
          issuedAt: claims.iat ?? null,
          issuer: claims.iss ?? null,
        });
      } catch { return null; }
    },
    /** Invalidates exactly this one session (this one token), not every token for this player, and not the shared secret. */
    revoke(sessionId) {
      if (typeof sessionId !== 'string' || !sessionId) return false;
      // Store until the token would have expired anyway -- no reason to
      // remember a revocation forever once verifyToken()'s own exp check
      // would already reject it for being expired.
      store.add(sessionId, Math.floor(Date.now() / 1000) + ttlSeconds);
      return true;
    },
    isRevoked(sessionId) { return store.has(sessionId); },
  };
}
