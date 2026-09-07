# TableCore v2 — B21 Hardening Verification

P0/P1 remediation verification against the B20 red-team findings.

## PASS gates

- WebSocket identity is derived from verified signed claims, not HELLO playerId.
- Static pack linting does not execute JavaScript modules.
- `runAction()` fails closed on rejection, exception, invalid result, or ACTION_REJECTED event.
- Public snapshots exclude RNG seed/state.
- ClientSession rejects cross-match snapshots after binding.
- WebSocket parser supports RFC 6455 16-bit and 64-bit payload lengths within configured resource limits.
- Fragmented text messages and interleaved control frames are supported.
- Client-to-server masking is enforced; server-to-client masking is rejected.
- RSV bits and reserved opcodes are rejected without negotiated extensions.
- Close frames validate payload length, close code, and UTF-8 reason.
- Message and receive-buffer resource limits are bounded.
- Per-connection message rate limiting is present.
- Runtime metrics are exposed for connections/messages/actions/bytes.
- Graceful server close sends close frames and has a bounded shutdown timeout.
- TLS-capable HTTPS server construction is supported through `tlsOptions`.
- Authoring mutations are schema validated and atomic.
- Protocol envelopes are validated before dispatch.
- Third-party pack descriptors support Ed25519 signatures and capability allowlists.

## Verification result

108 tests passed, 0 failed, 0 skipped.
Node syntax checks pass for all JavaScript sources.
ZIP integrity check passes on the release archive.
