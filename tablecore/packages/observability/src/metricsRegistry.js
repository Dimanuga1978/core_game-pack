// A minimal, dependency-free metrics primitive shared across the engine
// instead of each package (transport-ws had its own private copy) hand-
// rolling the same `{ inc, snapshot }` shape independently. `set()` is
// included alongside `inc()` because not everything meaningful to
// observe is a monotonically-increasing counter -- `activeMatches`,
// `activeConnections` are gauges (can go up AND down), and forcing a
// gauge through an increment-only counter API produces numbers nobody
// can interpret correctly (a `matchesCreated` counter and an
// `activeMatches` gauge answer genuinely different operational
// questions: "how much load has this process seen, ever" vs "how much
// load is it under right now").
export function createMetricsRegistry(initialValues = {}) {
  const values = { ...initialValues };
  return {
    inc(name, amount = 1) { values[name] = (values[name] ?? 0) + amount; },
    set(name, value) { values[name] = value; },
    get(name) { return values[name]; },
    snapshot() { return Object.freeze({ ...values }); },
  };
}
