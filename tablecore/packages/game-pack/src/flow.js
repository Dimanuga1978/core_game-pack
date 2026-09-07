/** Optional, declarative phase helper for packs that genuinely need multi-stage flow.
 * It is deliberately pack-level: the core match lifecycle remains unaware of phases. */

export function createFlow(definition) {
  if (!definition || typeof definition !== 'object') throw new TypeError('Flow definition must be an object');
  const { initial, phases } = definition;
  if (typeof initial !== 'string' || !initial) throw new TypeError('Flow requires initial phase');
  if (!phases || typeof phases !== 'object' || !phases[initial]) throw new TypeError('Flow initial phase must exist');
  for (const [name, phase] of Object.entries(phases)) {
    if (!phase || typeof phase !== 'object') throw new TypeError(`Invalid phase: ${name}`);
    if (phase.actions && !Array.isArray(phase.actions)) throw new TypeError(`Phase actions must be an array: ${name}`);
    if (phase.next && typeof phase.next !== 'string' && typeof phase.next !== 'function') throw new TypeError(`Invalid phase next: ${name}`);
  }
  // Keep callbacks intact; only freeze the shallow declarative structure.
  const frozenPhases = {};
  for (const [name, phase] of Object.entries(phases)) frozenPhases[name] = Object.freeze({ ...phase, actions: phase.actions ? Object.freeze([...phase.actions]) : undefined });
  return Object.freeze({ initial, phases: Object.freeze(frozenPhases) });
}

export function getPhaseActions(flow, phase) {
  return [...(flow.phases[phase]?.actions ?? [])];
}

/** Evaluates automatic transitions after a successful game action. */
export function resolveFlow(flow, state, context = {}) {
  let phase = state.phase ?? flow.initial;
  const events = [];
  const visited = new Set();
  while (true) {
    if (visited.has(phase)) throw new Error(`Flow transition loop detected at phase: ${phase}`);
    visited.add(phase);
    const config = flow.phases[phase];
    if (!config) throw new Error(`Unknown flow phase: ${phase}`);
    const shouldEnd = typeof config.endIf === 'function' ? config.endIf(state, context) : false;
    if (!shouldEnd) break;
    const next = typeof config.next === 'function' ? config.next(state, context) : config.next;
    if (!next) break;
    if (!flow.phases[next]) throw new Error(`Unknown next flow phase: ${next}`);
    const from = phase; phase = next; state.phase = phase;
    events.push({ type: 'PHASE_CHANGED', from, to: phase });
  }
  return { state, events };
}
