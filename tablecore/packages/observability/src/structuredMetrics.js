// --- Structured observability (P2-OPS) -----------------------------------
//
// Before this, whatever metrics existed (transport-ws's connection/
// message/byte counters) lived in one flat namespace, and nothing at the
// match/game level (matches created, started, finished, aborted; active
// match count) or resource level (process memory, uptime) was tracked at
// all. A flat namespace makes "is this a networking problem or a game-
// logic problem or are we just out of memory" a manual correlation
// exercise for whoever is debugging an incident, instead of the shape of
// the data doing that work.
//
// `buildStructuredMetrics()` combines whatever `MetricsRegistry` snapshots
// are supplied (each package/host still owns and increments its own --
// this does not centralize counting, only categorized reporting) into
// the four categories that answer four genuinely different operational
// questions:
//   - server:   lifecycle/administrative state of this process itself
//               (uptime, when it started).
//   - game:     match/rule-level activity (created, started, finished,
//               aborted, active count, actions accepted/rejected).
//   - network:  connection/transport-level activity (opened/closed,
//               messages, bytes, backpressure events).
//   - resource: what the OS/V8 actually thinks this process is costing
//               (memory breakdown) -- computed fresh on every call via
//               `process.memoryUsage()`, not tracked incrementally,
//               since it is inherently a point-in-time reading, not
//               something to count events for.
export function buildStructuredMetrics({ server = {}, game = {}, network = {}, startedAt = null } = {}) {
  const uptimeSeconds = startedAt != null ? (Date.now() - startedAt) / 1000 : null;
  return Object.freeze({
    server: Object.freeze({ uptimeSeconds, ...server }),
    game: Object.freeze({ ...game }),
    network: Object.freeze({ ...network }),
    resource: Object.freeze({ memory: process.memoryUsage() }),
  });
}
