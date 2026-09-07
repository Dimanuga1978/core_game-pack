import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { createMetricsRegistry } from '@tablecore/observability';

const MAX_FRAME_PAYLOAD = 1024 * 1024;
const MAX_MESSAGE_PAYLOAD = 4 * 1024 * 1024;
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_HANDSHAKE = 16 * 1024;
const AUTH_TIMEOUT_MS = 5000;

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const clone = value => structuredClone(value);

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function encodeText(data, masked = false) {
  return encodeFrame(Buffer.from(JSON.stringify(data), 'utf8'), 0x1, masked);
}

function encodeFrame(payload, opcode = 0x1, masked = false, fin = true) {
  if (!Buffer.isBuffer(payload)) payload = Buffer.from(payload);
  if (payload.length > MAX_FRAME_PAYLOAD) throw new Error('Frame too large');
  const first = (fin ? 0x80 : 0) | (opcode & 0x0f);
  let header;
  const maskBit = masked ? 0x80 : 0;
  if (payload.length < 126) {
    header = Buffer.from([first, maskBit | payload.length]);
  } else if (payload.length <= 0xFFFF) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = maskBit | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  if (!masked) return Buffer.concat([header, payload]);
  const mask = crypto.randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, body]);
}

function encodePong(payload = Buffer.alloc(0)) {
  return encodeFrame(payload, 0xA, false, true);
}

function encodeClose(code = 1000, reason = '') {
  const reasonBuf = Buffer.from(reason, 'utf8').subarray(0, 123);
  const payload = Buffer.alloc(2 + reasonBuf.length);
  payload.writeUInt16BE(code, 0);
  reasonBuf.copy(payload, 2);
  return encodeFrame(payload, 0x8, false, true);
}


function isValidCloseCode(code) {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
}

function validateClosePayload(payload) {
  if (payload.length === 0) return;
  if (payload.length === 1) throw new Error('Invalid close payload length');
  const code = payload.readUInt16BE(0);
  if (!isValidCloseCode(code)) throw new Error('Invalid close code');
  if (payload.length > 2) decodeUtf8Strict(payload.subarray(2));
}

function parseFrame(buffer, expectMasked) {
  if (buffer.length < 2) return null;
  const b0 = buffer[0];
  const b1 = buffer[1];
  const fin = (b0 & 0x80) !== 0;
  const rsv = (b0 & 0x70) >> 4;
  const opcode = b0 & 0x0f;
  if (![0x0, 0x1, 0x2, 0x8, 0x9, 0xA].includes(opcode)) throw new Error('Unsupported WebSocket opcode');
  const masked = (b1 & 0x80) !== 0;
  let lenCode = b1 & 0x7f;
  let offset = 2;
  if (rsv !== 0) throw new Error('RSV bits are not negotiated');
  if (opcode >= 0x8 && !fin) throw new Error('Control frame fragmented');
  if (opcode >= 0x8 && lenCode > 125) throw new Error('Control frame too large');
  if (expectMasked && !masked) throw new Error('Client frame must be masked');
  if (!expectMasked && masked) throw new Error('Server frame must not be masked');
  if (lenCode === 126) {
    if (buffer.length < offset + 2) return null;
    lenCode = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (lenCode === 127) {
    if (buffer.length < offset + 8) return null;
    const lengthBig = buffer.readBigUInt64BE(offset);
    offset += 8;
    if ((lengthBig >> 63n) !== 0n) throw new Error('Invalid 64-bit payload length');
    if (lengthBig < 65536n) throw new Error('Non-minimal 64-bit payload length');
    if (lengthBig > BigInt(MAX_FRAME_PAYLOAD)) throw new Error('Frame exceeds configured maximum');
    lenCode = Number(lengthBig);
  }
  if (buffer[1] !== undefined && (buffer[1] & 0x7f) === 126 && lenCode < 126) throw new Error('Non-minimal 16-bit payload length');
  if (lenCode > MAX_FRAME_PAYLOAD) throw new Error('Frame too large');
  const maskBytes = masked ? 4 : 0;
  if (buffer.length < offset + maskBytes + lenCode) return null;
  let payload = buffer.subarray(offset + maskBytes, offset + maskBytes + lenCode);
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  } else {
    payload = Buffer.from(payload);
  }
  if (opcode === 0x8) validateClosePayload(payload);
  return { fin, opcode, payload, used: offset + maskBytes + lenCode };
}

class MessageAssembler {
  constructor() {
    this.opcode = null;
    this.parts = [];
    this.total = 0;
  }

  push(frame) {
    const { opcode, fin, payload } = frame;
    if (opcode === 0x0) {
      if (this.opcode == null) throw new Error('Unexpected continuation frame');
      this.parts.push(payload);
      this.total += payload.length;
    } else if (opcode === 0x1 || opcode === 0x2) {
      if (this.opcode != null) throw new Error('New data frame while fragmented message is active');
      this.opcode = opcode;
      this.parts = [payload];
      this.total = payload.length;
    } else {
      return null;
    }
    if (this.total > MAX_MESSAGE_PAYLOAD) throw new Error('Message too large');
    if (!fin) return null;
    const message = { opcode: this.opcode, payload: Buffer.concat(this.parts, this.total) };
    this.opcode = null;
    this.parts = [];
    this.total = 0;
    return message;
  }
}

function parseMessageStream(buffer, assembler, expectMasked) {
  const messages = [];
  let offset = 0;
  while (offset < buffer.length) {
    const frame = parseFrame(buffer.subarray(offset), expectMasked);
    if (!frame) break;
    offset += frame.used;
    if (frame.opcode >= 0x8) {
      messages.push({ control: true, frame });
      continue;
    }
    const message = assembler.push(frame);
    if (message) messages.push({ control: false, message });
  }
  return { used: offset, messages };
}

function decodeUtf8Strict(payload) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(payload); }
  catch { throw new Error('Invalid UTF-8 text'); }
}

function parseHeaders(head) {
  const lines = head.split(/\r\n/);
  const requestLine = lines.shift() ?? '';
  const headers = {};
  for (const line of lines) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    const name = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return { requestLine, headers };
}

function validateUpgradeRequest(head, allowedOrigins) {
  const { requestLine, headers } = parseHeaders(head);
  if (!/^GET\s+\S+\s+HTTP\/1\.1$/i.test(requestLine)) throw new Error('Invalid HTTP request line');
  if (!/\bwebsocket\b/i.test(headers.upgrade ?? '')) throw new Error('Missing websocket Upgrade');
  if (!/\bupgrade\b/i.test(headers.connection ?? '')) throw new Error('Missing connection Upgrade');
  if ((headers['sec-websocket-version'] ?? '') !== '13') throw new Error('Unsupported WebSocket version');
  const key = headers['sec-websocket-key'];
  if (!key || Buffer.from(key, 'base64').length !== 16) throw new Error('Invalid Sec-WebSocket-Key');
  if (allowedOrigins?.length) {
    const origin = headers.origin;
    if (!origin || !allowedOrigins.includes(origin)) throw new Error('Origin denied');
  }
  return { key, path: requestLine.split(/\s+/)[1] };
}

function nowMs() { return Date.now(); }

function createRateLimiter({ maxMessages = 30, windowMs = 1000 } = {}) {
  return {
    maxMessages, windowMs,
    consume(connection) {
      const now = nowMs();
      if (!connection.rateWindow || now - connection.rateWindow.startedAt >= windowMs) {
        connection.rateWindow = { startedAt: now, count: 0 };
      }
      connection.rateWindow.count += 1;
      return connection.rateWindow.count <= maxMessages;
    }
  };
}

function createMetrics() {
  // Delegates to the shared registry (packages/observability) instead of
  // a private local implementation -- same shape, same behavior, just no
  // longer a second, independently-maintained copy of the same 12 lines
  // of counter logic. Pre-seeded with this module's own known counter
  // names purely so `snapshot()` always reports a consistent, predictable
  // key set from the very first call, before any events have happened.
  return createMetricsRegistry({
    connectionsOpened: 0,
    connectionsClosed: 0,
    messagesReceived: 0,
    messagesRejected: 0,
    actionsAccepted: 0,
    actionsRejected: 0,
    bytesReceived: 0,
    bytesSent: 0,
    backpressureEvents: 0,
    backpressureDisconnects: 0,
  });
}

// Outbound backpressure policy, exported so it can be unit tested
// deterministically against a mock socket instead of racing real OS/
// kernel TCP buffers on loopback (which, for small messages, drain fast
// enough that genuine backpressure is slow and environment-dependent to
// reproduce reliably as an end-to-end test). `net.Socket`'s own
// `writableLength` (bytes queued internally, not yet handed to the OS) is
// the real signal; this function is just the policy layered on top of
// it: track backpressure events for visibility, and force-disconnect
// once queued bytes exceed the configured ceiling. One slow reader (a
// laggy spectator, a client that stopped reading entirely) could
// otherwise accumulate unbounded userland memory during a broadcast-
// heavy match, since nothing previously stopped writing to it. This
// intentionally does NOT wait for 'drain' before the caller continues
// writing to OTHER connections during a broadcast -- one slow connection
// must never stall delivery to every other, faster one.
export function createOutboundGuard({ metrics, maxQueuedBytes }) {
  return function writeToConnection(connection, wire) {
    const socket = connection?.socket;
    if (!socket || socket.destroyed || !socket.writable) return;
    const ok = socket.write(wire);
    metrics.inc('bytesSent', wire.length);
    if (!ok) metrics.inc('backpressureEvents');
    if (socket.writableLength > maxQueuedBytes) {
      metrics.inc('backpressureDisconnects');
      connection.forceClose?.(1013, 'outbound backpressure limit exceeded');
    }
  };
}

export function createWsServer({ protocol, resolveConnection, auth, maxClients = 128, maxMessagesPerSecond = 30, allowedOrigins = null, tlsOptions = null, requestTimeoutMs = 10000, maxPendingSockets = 512, authTimeoutMs = AUTH_TIMEOUT_MS, maxQueuedBytes = 4 * 1024 * 1024 } = {}) {
  if (!protocol || typeof protocol.handle !== 'function') throw new TypeError('protocol is required');
  if (!auth || typeof auth.verifyToken !== 'function') throw new TypeError('auth is required');
  const clients = new Set();
  const metrics = createMetrics();
  const limiter = createRateLimiter({ maxMessages: maxMessagesPerSecond });
  const sockets = new Set();
  const writeToConnection = createOutboundGuard({ metrics, maxQueuedBytes });

  // Sockets that have completed the (cheap, unauthenticated) WS handshake
  // but have not yet sent a valid HELLO. `maxClients` only ever bounded
  // *authenticated* connections -- nothing stopped an attacker from simply
  // opening many raw sockets and completing the handshake without ever
  // authenticating, exhausting file descriptors/memory long before
  // `maxClients` ever triggered. This is a second, independent cap.
  const pendingSockets = new Set();
  const maxPending = Math.max(1, Number(maxPendingSockets) | 0);
  const connections = new Map();
  const connectionsBySocket = new Map();
  const requestHandler = (_req, res) => { res.writeHead(426, { 'content-type': 'text/plain' }); res.end('Upgrade Required'); };
  const httpServer = tlsOptions
    ? https.createServer(tlsOptions, requestHandler)
    : http.createServer(requestHandler);

  httpServer.on('upgrade', (req, socket, head) => {
    if (pendingSockets.size >= maxPending) {
      try { socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch {}
      socket.destroy();
      return;
    }
    sockets.add(socket);
    pendingSockets.add(socket);
    socket.setNoDelay(true);
    socket.setTimeout(requestTimeoutMs);
    let buffer = Buffer.from(head ?? Buffer.alloc(0));
    let connection = null;
    let closed = false;
    let authTimer = null;
    const assembler = new MessageAssembler();
    const preAuthRateState = { rateWindow: null };
    const closeSocket = (code = 1002, reason = '') => {
      if (closed) return;
      closed = true;
      if (authTimer) { clearTimeout(authTimer); authTimer = null; }
      pendingSockets.delete(socket);
      try { if (socket.writable) socket.write(encodeClose(code, reason)); } catch {}
      socket.destroy();
    };
    const send = data => {
      if (closed) return;
      const wire = encodeText(data, false);
      writeToConnection(connection ?? { socket }, wire);
    };

    try {
      if (req.method !== 'GET' || req.httpVersion !== '1.1') throw new Error('Invalid HTTP request');
      const headers = req.headers ?? {};
      if (!/\bwebsocket\b/i.test(String(headers.upgrade ?? ''))) throw new Error('Missing websocket Upgrade');
      if (!/\bupgrade\b/i.test(String(headers.connection ?? ''))) throw new Error('Missing connection Upgrade');
      if (String(headers['sec-websocket-version'] ?? '') !== '13') throw new Error('Unsupported WebSocket version');
      const key = headers['sec-websocket-key'];
      if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) throw new Error('Invalid Sec-WebSocket-Key');
      if (allowedOrigins?.length) {
        const origin = headers.origin;
        if (!origin || !allowedOrigins.includes(origin)) throw new Error('Origin denied');
      }
      const response = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`;
      socket.write(response);
    } catch (error) {
      try { socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch {}
      socket.destroy();
      sockets.delete(socket);
      pendingSockets.delete(socket);
      return;
    }
    socket.setTimeout(0);
    // requestTimeoutMs covered "any inactivity" up to this point; from here
    // the socket is idle-timeout-free (long-lived game connections can go
    // quiet between turns) EXCEPT that it must still authenticate within
    // AUTH_TIMEOUT_MS specifically -- previously this constant was declared
    // and never actually wired to anything, so a handshake-completed,
    // never-authenticated socket could sit open indefinitely.
    authTimer = setTimeout(() => { closeSocket(1008, 'authentication timeout'); }, authTimeoutMs);
    authTimer.unref?.();

    // processBuffer() now awaits protocol.handle()/buildUpdate() (see
    // protocol/src/index.js's comment for why), which means it can no
    // longer be assumed to run start-to-finish synchronously between two
    // 'data' events on the same socket -- a NEW chunk could otherwise
    // arrive and trigger a SECOND, concurrent processBuffer() call while
    // the first one is still paused mid-await, racing on the shared
    // `buffer` variable and, worse, processing that connection's messages
    // out of order (e.g. two ACTIONs handled out of the order they were
    // actually sent). `processing`/`needsReprocess` serialize this: a
    // call that arrives while one is already running just flags that
    // more work is pending and returns immediately; the in-flight call's
    // own loop re-checks the buffer once it finishes its current pass,
    // so nothing is ever dropped and per-connection message order is
    // preserved regardless of how slow (or fast, relative to network
    // jitter) the underlying host's responses are.
    let processing = false;
    let needsReprocess = false;
    const processBuffer = async () => {
      if (processing) { needsReprocess = true; return; }
      processing = true;
      try {
        do {
          needsReprocess = false;
          let parsed;
          try { parsed = parseMessageStream(buffer, assembler, true); }
          catch (error) { return closeSocket(1002, error instanceof Error ? error.message : String(error)); }
          if (parsed.used) buffer = buffer.subarray(parsed.used);
          for (const item of parsed.messages) {
            if (closed) return;
            if (item.control) {
              if (item.frame.opcode === 0x8) { try { validateClosePayload(item.frame.payload); } catch (error) { return closeSocket(1002, error instanceof Error ? error.message : String(error)); } }
              if (item.frame.opcode === 0x9) { metrics.inc('messagesReceived'); socket.write(encodePong(item.frame.payload)); continue; }
              if (item.frame.opcode === 0x8) { try { socket.write(encodeFrame(item.frame.payload.subarray(0, 125), 0x8, false, true)); } catch {} return closeSocket(1000); }
              continue;
            }
            metrics.inc('messagesReceived');
            if (!limiter.consume(connection ?? preAuthRateState)) return closeSocket(1013, 'rate limit exceeded');
            if (item.message.opcode !== 0x1) { metrics.inc('messagesRejected'); return closeSocket(1003, 'text messages required'); }
            let text;
            try { text = decodeUtf8Strict(item.message.payload); } catch { metrics.inc('messagesRejected'); return closeSocket(1007, 'invalid utf8'); }
            let message;
            try { message = JSON.parse(text); } catch { metrics.inc('messagesRejected'); send({ type:'ACTION_REJECTED', protocolVersion:1, error:{ code:'INVALID_JSON' } }); continue; }
            if (!connection) {
              if (message.type !== 'HELLO' || typeof message.token !== 'string') { send({ type:'ACTION_REJECTED', protocolVersion:1, error:{code:'AUTH_REQUIRED'} }); return closeSocket(1008, 'authentication required'); }
              const claims = auth.verifyToken(message.token);
              if (!claims) { send({ type:'ACTION_REJECTED', protocolVersion:1, error:{code:'UNAUTHORIZED'} }); return closeSocket(1008, 'unauthorized'); }
              if (clients.size >= maxClients) { send({ type:'ACTION_REJECTED', protocolVersion:1, error:{code:'SERVER_FULL'} }); return closeSocket(1013, 'server full'); }
              connection = resolveConnection({ claims, request:{ remoteAddress:socket.remoteAddress, path:req.url ?? '/' } });
              if (!connection || connection.role !== claims.role || (claims.role === 'player' && connection.playerId !== claims.playerId)) return closeSocket(1008, 'identity mismatch');
              // Opt-in delta-sync (P2-PATCH's actual wire-format saving,
              // not just computing a patch nobody reads): a client
              // declares support by sending `supportsPatch:true` on its
              // own HELLO. Only THEN does createProtocolServer's
              // buildUpdate()/ACTION-reply path omit the redundant full
              // `snapshot` field from an UPDATE that already carries a
              // usable `patch` -- an existing/older client that never
              // sends this flag keeps getting the full snapshot on every
              // message exactly as before, zero behavior change. See
              // packages/protocol/src/index.js's own comment on this for
              // the full reasoning (found: the diff/patch machinery
              // already existed, fully tested, but no real client or
              // server code path had ever been wired to actually SEND
              // fewer bytes using it).
              connection.supportsPatch = message.supportsPatch === true;
              connection.id = connection.id ?? crypto.randomUUID();
              connection.subscribedMatches ??= new Set();
              // Stored directly on the connection object so broadcast never
              // needs a connection->socket lookup at all -- see below.
              connection.socket = socket;
              // Lets the shared writeToConnection() helper (and any other
              // connection's broadcast loop) close THIS connection from
              // outside its own per-connection closure, e.g. when its
              // outbound queue exceeds maxQueuedBytes during a broadcast
              // triggered by a different connection's action.
              connection.forceClose = closeSocket;
              clients.add(connection); connections.set(connection.id, connection); connectionsBySocket.set(socket, connection); metrics.inc('connectionsOpened');
              if (authTimer) { clearTimeout(authTimer); authTimer = null; }
              pendingSockets.delete(socket);
            }
            const replies = await protocol.handle({ connection, message });
            if (closed) return; // the connection may have been closed by something that happened during the awaited handle() call
            for (const reply of replies) {
              if (reply.type === 'ACTION_REJECTED') metrics.inc('actionsRejected');
              if (reply.type === 'UPDATE') metrics.inc('actionsAccepted');
            }
            for (const reply of replies) { const wire = { ...reply }; delete wire._broadcast; delete wire._rawEvents; send(wire); }
            const update = replies.find(reply => reply.type === 'UPDATE' && reply._broadcast);
            if (update) {
              for (const other of clients) {
                if (other === connection || !other.subscribedMatches?.has(update.matchId)) continue;
                // Re-filter from the RAW events for each recipient individually
                // -- `update.events` on this object is already scoped to the
                // acting connection and must never be reused for anyone else.
                const scoped = await protocol.buildUpdate({ connection: other, matchId:update.matchId, previousVersion:update.previousVersion, events:update._rawEvents });
                if (scoped.type === 'UPDATE') {
                  // O(1): the socket lives directly on the connection object
                  // (set at authentication time, above) instead of a reverse
                  // Map lookup. The old `[...connectionsBySocket.entries()]
                  // .find(...)` rebuilt an array of every connection and
                  // linearly scanned it for EVERY recipient of EVERY
                  // broadcast -- an O(N) lookup inside this O(N) loop, i.e.
                  // O(N^2) total work per broadcast action. connectionsBySocket
                  // itself is keyed the other way around (socket->connection,
                  // needed for the 'close' handler's cleanup) and was never
                  // the right structure for this direction of lookup.
                  const wire = encodeText(scoped, false);
                  writeToConnection(other, wire);
                }
              }
            }
          }
        } while (needsReprocess && !closed);
      } finally {
        processing = false;
      }
    };

    socket.on('timeout', () => closeSocket(1001, 'timeout'));
    socket.on('error', () => closeSocket(1011, 'socket error'));
    socket.on('close', () => {
      sockets.delete(socket);
      pendingSockets.delete(socket);
      if (authTimer) { clearTimeout(authTimer); authTimer = null; }
      if (connection) { clients.delete(connection); connections.delete(connection.id); connectionsBySocket.delete(socket); metrics.inc('connectionsClosed'); }
    });
    // processBuffer() is async now but intentionally not awaited here --
    // it manages its own reentrancy (see its own comment above) and any
    // unexpected internal error must not become an unhandled promise
    // rejection that could crash the process; closing the socket is the
    // same failure mode an unexpected synchronous throw used to hit
    // before this was async.
    const runProcessBuffer = () => { processBuffer().catch(() => { try { closeSocket(1011, 'internal error'); } catch {} }); };
    socket.on('data', chunk => {
      if (closed) return;
      metrics.inc('bytesReceived', chunk.length);
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_BUFFER) return closeSocket(1009, 'receive buffer exceeded');
      runProcessBuffer();
    });
    if (buffer.length) runProcessBuffer();
  });

  const api = {
    server: httpServer,
    metrics,
    listen(port = 0, host = '127.0.0.1') {
      // `host` used to be hardcoded here (always '127.0.0.1', regardless
      // of what a caller might have wanted) -- found while wiring up the
      // first real end-to-end server bootstrap (tools/server/start.mjs)
      // this engine has ever had: a `TABLECORE_SERVER_HOST` env var
      // silently did nothing at all. The return value stays a bare port
      // NUMBER, unchanged -- 17 existing call sites across this codebase
      // already do `const port = await ws.listen(); createWsClient({port,
      // ...})`, and changing the return shape to an {address,port} object
      // would have silently broken every one of them (`{address,port}.port`
      // still works by accident for direct property access, but anything
      // doing arithmetic/string interpolation on the bare value would not).
      // A caller that wants the host string back already has it -- it's
      // whatever it just passed in.
      return new Promise((resolve, reject) => {
        const onError = error => { httpServer.off('listening', onListening); reject(error); };
        const onListening = () => { httpServer.off('error', onError); const address = httpServer.address(); resolve(typeof address === 'object' && address ? address.port : port); };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(port, host);
      });
    },
    close({ code = 1001, reason = 'server shutdown', timeoutMs = 5000 } = {}) {
      for (const client of clients) {
        const socket = client.socket; // O(1), see the broadcast loop above for why
        try { socket?.write(encodeClose(code, reason)); } catch {}
        try { socket?.destroy(); } catch {}
      }
      for (const socket of sockets) { try { socket.destroy(); } catch {} }
      return new Promise(resolve => {
        let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { try { httpServer.closeAllConnections?.(); } catch {} finish(); }, timeoutMs);
        httpServer.close(finish);
      });
    },
    address: () => httpServer.address()
  };
  return api;
}

export function createWsClient({ port, host = '127.0.0.1', hello, path = '/', tlsOptions = null } = {}) {
  // `host` was previously accepted-in-appearance but silently ignored --
  // both branches below hardcoded '127.0.0.1' regardless of what was
  // passed. Found while wiring up real bot-player WS connections
  // (tools/server/start.mjs): a bot connecting via `createWsClient({port,
  // host: actualWsHost, ...})` would have silently connected to
  // 127.0.0.1 instead of wherever the server was actually configured to
  // bind (TABLECORE_SERVER_HOST), which happens to work when that's also
  // 127.0.0.1 (the default) but would silently misbehave for any other
  // configured bind address. Same class of bug, and the same fix
  // pattern, as createWsServer's own `listen(port, host)` fix earlier in
  // this engine's history.
  return new Promise((resolve, reject) => {
    const socket = tlsOptions
      ? tls.connect({ host, port, rejectUnauthorized:false, ...tlsOptions })
      : net.connect(port, host);
    let buffer = Buffer.alloc(0);
    let ready = false;
    let settled = false;
    const messages = [];
    const assembler = new MessageAssembler();
    const key = crypto.randomBytes(16).toString('base64');
    const api = {
      messages,
      send(message) { if (!ready) throw new Error('WebSocket is not ready'); const wire = encodeText(message, true); socket.write(wire); },
      close() { try { socket.write(encodeClose(1000)); } catch {} socket.end(); }
    };
    socket.once('error', error => { if (!settled) reject(error); });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!ready) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buffer.subarray(0, end + 4).toString('utf8');
        if (!/^HTTP\/1\.1 101\s/i.test(head)) { socket.destroy(); return reject(new Error('WebSocket upgrade rejected')); }
        buffer = buffer.subarray(end + 4);
        ready = true;
        try { api.send(hello); } catch (error) { socket.destroy(); return reject(error); }
        settled = true;
        resolve(api);
      }
      while (ready) {
        let parsed;
        try { parsed = parseMessageStream(buffer, assembler, false); } catch { socket.destroy(); return; }
        if (!parsed.used) break;
        buffer = buffer.subarray(parsed.used);
        for (const item of parsed.messages) {
          if (item.control) continue;
          if (item.message.opcode !== 0x1) continue;
          try { messages.push(JSON.parse(decodeUtf8Strict(item.message.payload))); } catch {}
        }
      }
    });
    socket.on('close', () => { ready = false; });
    socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
}

export const websocketTestCodec = Object.freeze({ encodeFrame, parseFrame, parseMessageStream });
