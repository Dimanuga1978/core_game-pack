'use strict';

/** Last Sector game-specific presentation mapping; no DOM or engine dependency. */
function createShipNode(documentRef, shipType = 'scout') {
  const svg = documentRef.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ls-asset', 'ls-fx-ship');
  const use = documentRef.createElementNS('http://www.w3.org/2000/svg', 'use');
  const id = ({scout:'ship-scout',transport:'ship-transport',warship:'ship-warship',tanker:'ship-tanker'})[shipType] || 'ship-scout';
  use.setAttribute('href', `../assets.svg#${id}`);
  svg.appendChild(use);
  return svg;
}

function resolvePoint(ctx, value) {
  if (typeof ctx?.resolvePoint === 'function') return ctx.resolvePoint(value);
  if (value && typeof value === 'object') return value;
  return { x: 50, y: 50 };
}

function pointStyle(ctx, value) {
  const point = resolvePoint(ctx, value);
  return { '--ls-fx-x': `${point?.x ?? 50}%`, '--ls-fx-y': `${point?.y ?? 50}%` };
}

function createLastSectorFx() {
  return Object.freeze({
    move: (event, ctx = {}) => ({ action: 'ship.move', className: 'ls-fx-motion', duration: 520, nodeFactory: doc => createShipNode(doc, event?.payload?.shipType || 'scout'), from: resolvePoint(ctx, event?.payload?.from), to: resolvePoint(ctx, event?.payload?.to), startOpacity: .1, peakOpacity: .96, startScale: .72, endScale: 1, style: { color: 'var(--ls-color-player)', '--ls-fx-size': '42px' } }),
    route: (event) => ({ action:'route.highlight', className:'ls-fx-route', duration:720, path:Array.isArray(event?.payload?.path)?event.payload.path:[], style:{ color:'var(--ls-color-player-strong)', '--ls-fx-width':'8px' } }),
    combat: (event, ctx = {}) => ({ action: 'combat.flash', className: 'ls-fx-burst', duration: 620, style: { ...pointStyle(ctx, event?.payload?.to || event?.payload?.coord), color: 'var(--ls-color-enemy)' }, keyframes: [{ opacity: 0, transform: 'translate(-50%,-50%) scale(.2)' }, { opacity: 1, transform: 'translate(-50%,-50%) scale(1)' }, { opacity: 0, transform: 'translate(-50%,-50%) scale(1.65)' }] }),
    projectile: (event, ctx = {}) => ({ action: 'combat.projectile', className: 'ls-fx-projectile', duration: 280, from: resolvePoint(ctx, event?.payload?.from), to: resolvePoint(ctx, event?.payload?.to), startOpacity: .1, peakOpacity: 1, startScale: .55, endScale: 1, style: { color: 'var(--ls-color-warning)', '--ls-fx-size': '10px' } }),
    teleport: (event, ctx = {}) => ({ action: 'ship.teleport', className: 'ls-fx-ring', duration: 760, style: { ...pointStyle(ctx, event?.payload?.to || event?.payload?.coord), color: 'var(--ls-color-info)' }, keyframes: [{ opacity: 0, transform: 'translate(-50%,-50%) scale(.25) rotate(-30deg)' }, { opacity: 1, transform: 'translate(-50%,-50%) scale(1) rotate(0)' }, { opacity: 0, transform: 'translate(-50%,-50%) scale(1.45) rotate(30deg)' }] }),
    scan: (event, ctx = {}) => ({ action: 'scan.resolve', className: 'ls-fx-ring', duration: 900, style: { ...pointStyle(ctx, event?.payload?.coord || event?.payload?.to), color: 'var(--ls-color-anomaly)', '--ls-fx-size': '130px' }, keyframes: [{ opacity: 0, transform: 'translate(-50%,-50%) scale(.15)' }, { opacity: .8, transform: 'translate(-50%,-50%) scale(1)' }, { opacity: 0, transform: 'translate(-50%,-50%) scale(1.35)' }] }),
    discovery: (event, ctx = {}) => ({ action: 'sector.discover', className: 'ls-fx-pulse', duration: 700, style: { ...pointStyle(ctx, event?.payload?.coord || event?.payload?.to), color: 'var(--ls-color-player-strong)' }, keyframes: [{ opacity: 0, transform: 'translate(-50%,-50%) scale(.2)' }, { opacity: 1, transform: 'translate(-50%,-50%) scale(1)' }, { opacity: 0, transform: 'translate(-50%,-50%) scale(1.6)' }] }),
    trap: (event, ctx = {}) => ({ action: 'trap.place', className: 'ls-fx-cross', duration: 520, style: { ...pointStyle(ctx, event?.payload?.coord || event?.payload?.to), color: 'var(--ls-color-warning)', '--ls-fx-size': '54px' }, keyframes: [{ opacity: 0, transform: 'translate(-50%,-50%) rotate(-30deg) scale(.4)' }, { opacity: 1, transform: 'translate(-50%,-50%) rotate(0) scale(1)' }, { opacity: 0, transform: 'translate(-50%,-50%) rotate(30deg) scale(1.2)' }] }),
    destroyed: (event, ctx = {}) => ({ action: 'player.destroyed', className: 'ls-fx-burst', duration: 820, style: { ...pointStyle(ctx, event?.payload?.coord || event?.payload?.to), color: 'var(--ls-color-enemy)', '--ls-fx-size': '110px' }, keyframes: [{ opacity: 0, transform: 'translate(-50%,-50%) scale(.1)' }, { opacity: 1, transform: 'translate(-50%,-50%) scale(.85)' }, { opacity: 0, transform: 'translate(-50%,-50%) scale(1.7)' }] })
  });
}

function createLastSectorPresentation() {
  const FX = createLastSectorFx();
  return Object.freeze({
    handlers: {
      SHIP_MOVE_ANIMATION: (event, ctx) => FX.move(event, ctx),
      ROUTE_HIGHLIGHT: (event, ctx) => FX.route(event, ctx),
      SHIP_MOVED: (event, ctx) => FX.move(event, ctx),
      COMBAT_FLASH: (event, ctx) => FX.combat(event, ctx),
      COMBAT_RESOLVED: (event, ctx) => FX.combat(event, ctx),
      TELEPORT_EFFECT: (event, ctx) => FX.teleport(event, ctx),
      TELEPORTED: (event, ctx) => FX.teleport(event, ctx),
      FORCED_MOVE_EFFECT: (event, ctx) => FX.move(event, ctx),
      SCAN_RESOLVED: (event, ctx) => FX.scan(event, ctx),
      SECTOR_DISCOVERED: (event, ctx) => FX.discovery(event, ctx),
      TRAP_PLACED: (event, ctx) => FX.trap(event, ctx),
      PLAYER_SHIP_DESTROYED: (event, ctx) => FX.destroyed(event, ctx),
      TANKER_DESTROYED: (event, ctx) => FX.destroyed(event, ctx)
    },
    sequences: {
      SHIP_MOVED: (event, ctx) => ({
        key: `move:${event?.payload?.playerId || event?.payload?.shipId || 'ship'}`, lane: 'ship', priority: 20, replace: true,
        steps: [
          { camera: { choreograph: true, shots: [
            { point: resolvePoint(ctx, event?.payload?.from), scale: 1.08, duration: 240 },
            { point: resolvePoint(ctx, event?.payload?.to), scale: 1.20, duration: 520 },
            { point: resolvePoint(ctx, event?.payload?.to), scale: 1.26, duration: 220 }
          ] } },
          { descriptor: FX.move(event, ctx) },
          { hold: 120 },
          { descriptor: FX.discovery(event, ctx) },
          { camera: { reset: true, options: { duration: 520 } } }
        ]
      }),
      COMBAT_RESOLVED: (event, ctx) => ({
        key: `combat:${event?.payload?.targetId || event?.payload?.playerId || 'combat'}`, lane: 'combat', priority: 50, replace: false,
        steps: [
          { camera: { choreograph: true, shots: [
            { point: resolvePoint(ctx, event?.payload?.from || event?.payload?.to || event?.payload?.coord), scale: 1.10, duration: 220 },
            { point: resolvePoint(ctx, event?.payload?.to || event?.payload?.coord), scale: 1.24, duration: 360 },
            { point: resolvePoint(ctx, event?.payload?.to || event?.payload?.coord), scale: 1.30, duration: 180 }
          ] } },
          ...(event?.payload?.from && event?.payload?.to ? [{ descriptor: FX.projectile(event, ctx) }, { hold: 70 }] : []),
          { descriptor: FX.combat(event, ctx) },
          { hold: 90 },
          { descriptor: event?.payload?.destroyed ? FX.destroyed(event, ctx) : null },
          { camera: { reset: true, options: { duration: 560 } } }
        ].filter(x => x.descriptor || x.hold || x.camera)
      }),
      TELEPORTED: (event, ctx) => ({
        key: `teleport:${event?.payload?.playerId || 'ship'}`, lane: 'ship', priority: 80, replace: true,
        steps: [
          { descriptor: FX.teleport(event, ctx) },
          { hold: 160 },
          { descriptor: FX.discovery(event, ctx) }
        ]
      }),
      SCAN_RESOLVED: (event, ctx) => ({
        key: `scan:${event?.payload?.playerId || 'scan'}`, lane: 'scan', priority: 10, replace: true,
        steps: [{ descriptor: FX.scan(event, ctx) }]
      }),
      SECTOR_DISCOVERED: (event, ctx) => ({
        key: `discover:${event?.payload?.coord || 'sector'}`, lane: 'discovery', priority: 30, replace: false,
        steps: [{ descriptor: FX.discovery(event, ctx) }]
      }),
      PLAYER_SHIP_DESTROYED: (event, ctx) => ({
        key: `destroy:${event?.payload?.playerId || 'ship'}`, lane: 'combat', priority: 100, replace: true,
        steps: [{ descriptor: FX.destroyed(event, ctx) }]
      })
    },
    fx: FX,
    sequenceAliases: {
      SHIP_MOVE_ANIMATION: 'SHIP_MOVED',
      COMBAT_FLASH: 'COMBAT_RESOLVED',
      TELEPORT_EFFECT: 'TELEPORTED',
      FORCED_MOVE_EFFECT: 'SHIP_MOVED'
    }
  });
}

export { createLastSectorPresentation, createLastSectorFx };
