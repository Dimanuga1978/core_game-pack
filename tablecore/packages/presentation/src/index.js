const clone = (value) => structuredClone(value);

export const CLIENT_CAPABILITIES = Object.freeze({
  pc: Object.freeze({ interactive:true, input:true, effects:'standard', layout:'full' }),
  mobile: Object.freeze({ interactive:true, input:true, effects:'reduced', layout:'compact' }),
  tv: Object.freeze({ interactive:false, input:false, effects:'cinematic', layout:'display' })
});

export function getCapabilities(kind) {
  const capabilities = CLIENT_CAPABILITIES[kind];
  if (!capabilities) throw new Error(`Unknown presentation client: ${kind}`);
  return clone(capabilities);
}

function toPublicEvent(event, capabilities) {
  return { type:event.type, data:clone(Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'type'))), effects:capabilities.effects };
}

/**
 * Converts public protocol data into immutable presentation data. It deliberately
 * does not import a game pack, Match, ServerHost, or any transport implementation.
 */
export function createPresentationFrame({ snapshot, events = [], client = 'pc' }) {
  if (!snapshot || typeof snapshot !== 'object') throw new TypeError('snapshot is required');
  const capabilities = getCapabilities(client);
  return Object.freeze({
    version: snapshot.version,
    client,
    capabilities,
    state: clone(snapshot.state ?? snapshot),
    events: events.map((event) => toPublicEvent(event, capabilities))
  });
}

/** Local UI intents are intentionally a separate vocabulary and never protocol actions. */
export function createUiIntent(type, payload = {}) {
  if (typeof type !== 'string' || !type.startsWith('UI_')) throw new TypeError('UI intent type must start with UI_');
  return Object.freeze({ type, payload:clone(payload), localOnly:true });
}

export function isAuthoritativeAction(message) {
  return Boolean(message && message.type === 'ACTION');
}
