'use strict';

/** Last Sector game-specific FX descriptors. No DOM or engine dependency. */
function pointStyle(point) {
  return { '--ls-fx-x': `${point?.x ?? 50}%`, '--ls-fx-y': `${point?.y ?? 50}%` };
}

function createLastSectorFx() {
  return Object.freeze({
    move: event => ({ className: 'ls-fx-line', duration: 520, color: 'var(--ls-color-player)', style: { ...pointStyle(event?.payload?.to), '--ls-fx-distance': '140px', '--ls-fx-angle': `${Number(event?.payload?.angle || 0)}deg`, color: 'var(--ls-color-player)' }, keyframes: [{ opacity: 0, transform: 'rotate(var(--ls-fx-angle,0deg)) scaleY(.15)' }, { opacity: .9, transform: 'rotate(var(--ls-fx-angle,0deg)) scaleY(1)' }, { opacity: 0, transform: 'rotate(var(--ls-fx-angle,0deg)) scaleY(.15)' }] }),
    combat: event => ({ className: 'ls-fx-burst', duration: 620, style: { ...pointStyle(event?.payload?.to), color: 'var(--ls-color-enemy)' }, keyframes: [{ opacity: 0, transform: 'translate(-50%,-50%) scale(.2)' }, { opacity: 1, transform: 'translate(-50%,-50%) scale(1)' }, { opacity: 0, transform: 'translate(-50%,-50%) scale(1.65)' }] }),
    teleport: event => ({ className: 'ls-fx-ring', duration: 760, style: { ...pointStyle(event?.payload?.to), color: 'var(--ls-color-info)' }, keyframes: [{ opacity: 0, transform: 'translate(-50%,-50%) scale(.25) rotate(-30deg)' }, { opacity: 1, transform: 'translate(-50%,-50%) scale(1) rotate(0)' }, { opacity: 0, transform: 'translate(-50%,-50%) scale(1.45) rotate(30deg)' }] }),
    scan: event => ({ className: 'ls-fx-ring', duration: 900, style: { ...pointStyle(event?.payload?.coord), color: 'var(--ls-color-anomaly)', '--ls-fx-size': '130px' }, keyframes: [{ opacity: 0, transform: 'translate(-50%,-50%) scale(.15)' }, { opacity: .8, transform: 'translate(-50%,-50%) scale(1)' }, { opacity: 0, transform: 'translate(-50%,-50%) scale(1.35)' }] }),
    discovery: event => ({ className: 'ls-fx-pulse', duration: 700, style: { ...pointStyle(event?.payload?.coord), color: 'var(--ls-color-player-strong)' }, keyframes: [{ opacity: 0, transform: 'translate(-50%,-50%) scale(.2)' }, { opacity: 1, transform: 'translate(-50%,-50%) scale(1)' }, { opacity: 0, transform: 'translate(-50%,-50%) scale(1.6)' }] }),
    trap: event => ({ className: 'ls-fx-cross', duration: 520, style: { ...pointStyle(event?.payload?.coord), color: 'var(--ls-color-warning)', '--ls-fx-size': '54px' }, keyframes: [{ opacity: 0, transform: 'translate(-50%,-50%) rotate(-30deg) scale(.4)' }, { opacity: 1, transform: 'translate(-50%,-50%) rotate(0) scale(1)' }, { opacity: 0, transform: 'translate(-50%,-50%) rotate(30deg) scale(1.2)' }] }),
    destroyed: event => ({ className: 'ls-fx-burst', duration: 820, style: { ...pointStyle(event?.payload?.coord), color: 'var(--ls-color-enemy)', '--ls-fx-size': '110px' }, keyframes: [{ opacity: 0, transform: 'translate(-50%,-50%) scale(.1)' }, { opacity: 1, transform: 'translate(-50%,-50%) scale(.85)' }, { opacity: 0, transform: 'translate(-50%,-50%) scale(1.7)' }] })
  });
}

function createLastSectorPresentation() {
  const FX = createLastSectorFx();
  return Object.freeze({
    handlers: {
      SHIP_MOVE_ANIMATION: event => FX.move(event),
      SHIP_MOVED: event => FX.move(event),
      COMBAT_FLASH: event => FX.combat(event),
      COMBAT_RESOLVED: event => FX.combat(event),
      TELEPORT_EFFECT: event => FX.teleport(event),
      TELEPORTED: event => FX.teleport(event),
      FORCED_MOVE_EFFECT: event => FX.move(event),
      SCAN_RESOLVED: event => FX.scan(event),
      SECTOR_DISCOVERED: event => FX.discovery(event),
      TRAP_PLACED: event => FX.trap(event),
      PLAYER_SHIP_DESTROYED: event => FX.destroyed(event),
      TANKER_DESTROYED: event => FX.destroyed(event),
      default: event => null
    },
    fx: FX
  });
}

module.exports = { createLastSectorPresentation, createLastSectorFx };
