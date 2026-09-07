import { ClientSession, PROTOCOL_VERSION } from '@tablecore/protocol';
import { createPresentationFrame, createUiIntent, getCapabilities } from '@tablecore/presentation';

const clone = (value) => structuredClone(value);

/**
 * Transport-neutral client runtime.
 * It owns public protocol state and local UI state, but never authoritative rules.
 */
export class ClientRuntime {
  constructor({ client = 'pc', send } = {}) {
    this.client = client;
    this.capabilities = getCapabilities(client);
    this.send = typeof send === 'function' ? send : () => {};
    this.session = new ClientSession();
    this.local = { selectedObject: null, camera: null, openPanel: null };
    this.lastEvents = [];
    this.frame = null;
  }

  receive(message) {
    const result = this.session.receive(message);
    if (!result.applied) return result;
    if (message.type === 'SYNC' || message.type === 'UPDATE') {
      this.lastEvents = clone(message.events ?? []);
      this.frame = createPresentationFrame({ snapshot: this.session.snapshot, events: this.lastEvents, client: this.client });
    }
    return result;
  }

  connect(matchId) {
    const message = this.session.makeSyncRequest(matchId);
    this.send(message);
    return message;
  }

  dispatch(action, matchId) {
    if (!this.capabilities.input) return { ok:false, error:'CLIENT_CANNOT_ACT' };
    if (!this.session.snapshot) return { ok:false, error:'NOT_SYNCED' };
    const message = this.session.makeAction({ matchId, action });
    this.send(message);
    return { ok:true, message };
  }

  ui(type, payload = {}) {
    const intent = createUiIntent(type, payload);
    if (type === 'UI_SELECT_OBJECT') this.local.selectedObject = payload.id ?? null;
    if (type === 'UI_MOVE_CAMERA') this.local.camera = clone(payload);
    if (type === 'UI_OPEN_PANEL') this.local.openPanel = payload.id ?? null;
    return intent;
  }

  getView() {
    return Object.freeze({
      protocolVersion: PROTOCOL_VERSION,
      client: this.client,
      capabilities: clone(this.capabilities),
      frame: this.frame ? clone(this.frame) : null,
      local: clone(this.local)
    });
  }
}
