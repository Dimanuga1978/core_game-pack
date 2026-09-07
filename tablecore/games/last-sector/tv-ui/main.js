// Full presentation system, replacing a version that never worked at all
// (see this file's git history / CLIENT_LAYER_FIX.md for what was
// broken) and then a deliberately simplified live-board-only version
// that replaced it while the full system was being built (see
// HARD_AUDIT... no -- see the "TV board" follow-up work: FxRuntime,
// PresentationCamera, PresentationSequenceRuntime, PresentationDispatcher,
// OnboardingRuntime, all in @tablecore/presentation-client, a real,
// tested, game-agnostic package -- consuming the real, already-complete
// declarative design in games/last-sector/client/presentation.js
// (createLastSectorPresentation), which was never the missing piece:
// only its RUNTIME was.
import { PlayerClient } from '/engine-client/player-client.js';
import { ClientRuntime } from '/engine-client/runtime.js';
import { FrameScheduler } from '/engine-client/frame-scheduler.js';
import { FxRuntime, PresentationCamera, PresentationSequenceRuntime, PresentationDispatcher, OnboardingRuntime } from '/presentation-client/index.js';
import { reduceLastSectorEvent } from '../client/client-state.mjs';
import { createAssetIcon, assetName } from '../client/assets.mjs';
import { createLastSectorPresentation } from '../client/presentation.js';
import { LastSectorTutorialDemo } from '../client/tutorial.mjs';
import { computeBoardDimensions } from '../client/hex-geometry.mjs';
import { createHexBoard, updateHexTile, updateHexShips, colorForOwner } from '../client/hex-board.mjs';

const q = new URLSearchParams(location.search);
const match = q.get('match') || 'demo';
const token = q.get('token') || null; // spectator token -- see player-client.js's own comment on why a token is required
// Default port fixed (was 8080, the real server's actual default port is
// 4180 -- same fix as player-ui/main.js, see its own comment for the
// full explanation).
const wsUrl = q.get('ws') || `ws://${location.hostname || 'localhost'}:4180`;
const socketConnect = () => new Promise((resolve, reject) => {
  const s = new WebSocket(wsUrl);
  s.onopen = () => resolve(s);
  s.onerror = reject;
});
const client = new PlayerClient({ connect: socketConnect, match, principal: null, token });

// Same real-world issue as player-ui/main.js's own comment describes
// (real people testing this game hit an empty board with no console
// error and no explanation) -- shown here immediately on load, since a
// missing token is already known at parse time.
if (!token) {
  const notice = document.createElement('div');
  notice.id = 'no-match-notice';
  notice.innerHTML = '<strong>Нет активного матча</strong><p>Эта TV-ссылка открыта без реального матча. Нужна полная ссылка с параметрами <code>match</code>, <code>ws</code> и <code>token</code> зрителя (создаётся через admin API — см. ADMIN.md).</p>';
  document.querySelector('.map-frame')?.appendChild(notice);
}
const runtime = new ClientRuntime(client, { stateReducer: reduceLastSectorEvent });

const $ = id => document.getElementById(id);
const statusEl = $('status');
const grid = $('grid');
const fxLayer = $('fx-layer');
const mapWorld = $('map-world');
const feed = $('feed');
const eventTitle = $('event-title');
const eventSub = $('event-sub');
const operatorList = $('operator-list');
let hexBoard = null;
const shipRefs = new Map();

// --- Board coordinate -> screen position -----------------------------
// The most robust way to answer "where on screen is hex q,r" is to ask
// the ALREADY-RENDERED tile element itself, rather than re-deriving hex
// pixel geometry independently (which would need to duplicate whatever
// layout hex-board.mjs decides, and silently drift out of sync with it
// if that ever changes) -- getBoundingClientRect() is always exactly
// right, for any board size/layout, with zero grid-math duplicated
// here. Works identically for the real SVG hex tiles now (an SVG <g>'s
// getBoundingClientRect() reflects its rendered content's actual screen
// position/size in every real browser, same as an HTML div's would).
function resolvePoint(value) {
  if (value && typeof value === 'object') return value; // already a {x,y}-shaped point
  const ref = hexBoard?.tiles.get(value);
  if (!ref) return { x: 50, y: 50 };
  const cellRect = ref.g.getBoundingClientRect();
  const worldRect = mapWorld.getBoundingClientRect();
  if (!worldRect.width || !worldRect.height) return { x: 50, y: 50 };
  return {
    x: ((cellRect.left + cellRect.width / 2 - worldRect.left) / worldRect.width) * 100,
    y: ((cellRect.top + cellRect.height / 2 - worldRect.top) / worldRect.height) * 100,
  };
}

const fxRuntime = new FxRuntime({ container: fxLayer, resolvePoint, getCellElement: coord => hexBoard?.tiles.get(coord)?.g ?? null });
const camera = new PresentationCamera({ target: mapWorld, resolvePoint });
const sequenceRuntime = new PresentationSequenceRuntime({ fxRuntime, camera });
const dispatcher = new PresentationDispatcher({ presentation: createLastSectorPresentation(), sequenceRuntime, fxRuntime });

const renderScheduler = new FrameScheduler(() => render());

function setStatus(v) {
  const labels = { connecting: 'ПОДКЛЮЧЕНИЕ…', 'transport-connected': 'СОЕДИНЕНИЕ УСТАНОВЛЕНО', 'session-ready': 'ГОТОВ', connected: 'В ЭФИРЕ', resumed: 'ПЕРЕПОДКЛЮЧЕНО', disconnected: 'СВЯЗЬ ПОТЕРЯНА', 'connect-error': 'ОШИБКА СОЕДИНЕНИЯ', stopped: 'ОСТАНОВЛЕНО' };
  statusEl.textContent = labels[v] || String(v).toUpperCase();
  statusEl.className = (v === 'connected' || v === 'resumed' || v === 'session-ready') ? 'status-ok' : 'status-bad';
}

runtime.on('state', setStatus);
runtime.on('error', e => queueLog(`ошибка: ${e.code || e.message || 'unknown'}`));
runtime.on('snapshot', () => renderScheduler.schedule());
runtime.on('events', (list, msg) => {
  for (const e of list || []) {
    if (msg?.stream === 'presentation') {
      dispatcher.dispatch(e, { resolvePoint });
    }
    queueLog(`${msg?.stream === 'presentation' ? 'ВИЗУАЛ' : 'СОСТОЯНИЕ'}: ${EVENT_NAMES[e.type] || String(e.type).replaceAll('_', ' ')}`);
  }
});

function createObjectIcon(doc, kind) {
  return createAssetIcon(doc, assetName(kind), { className: 'ls-asset' });
}
function createShipIcon(doc, unit) {
  const g = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.classList.add('ship-mark');
  g.dataset.owner = unit.owner || '';
  // A spectator/TV view has no "self" player -- every real player gets
  // their own distinct, stable color (see hex-board.mjs's own
  // colorForOwner() comment), none of them singled out as "you".
  g.style.color = colorForOwner(unit.owner, null);
  g.appendChild(createObjectIcon(doc, unit.shipType));
  return g;
}

function ensureHexBoard(state) {
  if (hexBoard || !Array.isArray(state?.tiles) || !state.tiles.length) return;
  const { cols, rows } = computeBoardDimensions(state.tiles);
  if (!cols || !rows) return;
  hexBoard = createHexBoard(document, cols, rows, 28);
  grid.replaceChildren(hexBoard.svg);
}

function render() {
  const snap = runtime.snapshot;
  const state = snap?.state;
  if (!state) return;
  ensureHexBoard(state);
  if (!hexBoard) return;

  eventTitle.textContent = `ХОД: ${snap.active || '—'}`;
  eventSub.textContent = `Матч ${match} · версия ${snap.version ?? '—'}`;

  const units = (state.units || []).filter(u => u.status !== 'destroyed');
  for (const cell of state.tiles || []) {
    const ref = hexBoard.tiles.get(cell.coord);
    if (!ref) continue;
    updateHexTile(document, ref, cell, createObjectIcon);
  }
  updateHexShips(document, hexBoard.shipsGroup, units, hexBoard.tiles, shipRefs, createShipIcon);
  for (const u of units) {
    const ref = shipRefs.get(u.id);
    if (!ref) continue;
    const title = `Игрок ${u.owner} · ${u.shipType} · ${u.hp}/${u.maxHp} HP`;
    if (ref.title !== title) {
      ref.title = title;
      ref.g.replaceChildren(...[...ref.g.children].filter(c => c.tagName !== 'title'));
      const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      titleEl.textContent = title;
      ref.g.appendChild(titleEl);
    }
  }

  const scores = snap.scores || state.scores || {};
  const ownersSeen = new Set((state.units || []).map(u => u.owner));
  const rows = [...ownersSeen].sort().map(owner => {
    const unit = (state.units || []).find(u => u.owner === owner);
    const active = state.activePlayer === owner;
    return `<div class="operator-row${active ? ' active' : ''}"><b>${escapeHtml(owner)}</b><span>${unit ? `${unit.hp}/${unit.maxHp} HP · ${unit.shipType}` : '—'}</span><span>${scores[owner] ?? 0} очков</span></div>`;
  });
  operatorList.innerHTML = rows.join('') || '<div class="operator-row"><span>Нет данных</span></div>';
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }

const EVENT_NAMES = Object.freeze({
  SECTOR_GENERATED: 'Сектор создан', SHIP_MOVED: 'Корабль перемещён', TELEPORTED: 'Телепорт', FORCED_MOVE: 'Принудительное перемещение',
  PLAYER_SHIP_DESTROYED: 'Корабль уничтожен', CARGO_DELIVERED: 'Груз доставлен', SIGNAL_GOOD: 'Сигнал принят', TRAP_PLACED: 'Ловушка установлена',
  TURN_STARTED: 'Начало хода', DISCOVERY_REVEALED: 'Обнаружено', LOOT_FOUND: 'Найден ресурс', BATTLE_RESOLVED: 'Бой завершён', GREAT_STORM: 'Великий шторм',
});

const logQueue = [];
let logScheduled = false;
function queueLog(text) { logQueue.push(text); if (!logScheduled) { logScheduled = true; queueMicrotask(flushLogs); } }
function flushLogs() {
  logScheduled = false;
  if (!logQueue.length) return;
  const frag = document.createDocumentFragment();
  while (logQueue.length) {
    const e = document.createElement('div');
    e.className = 'event';
    e.textContent = `${new Date().toLocaleTimeString()} · ${logQueue.shift()}`;
    frag.appendChild(e);
  }
  feed.prepend(frag);
  while (feed.children.length > 40) feed.lastElementChild.remove();
}

// --- Onboarding / tutorial overlay (opt-in via ?tutorial=1) -----------
// The live TV board above works fully without this -- onboarding is a
// separate, optional demo shown BEFORE (or instead of) connecting to a
// real match, driven by the game's own LastSectorTutorialDemo (a
// self-contained rules simulation, touches no real match state at all).
if (q.get('tutorial') === '1') {
  const tutorialRoot = $('tutorial');
  const sceneRoot = $('tutorial-scene');
  const steps = [
    { title: 'ДОБРО ПОЖАЛОВАТЬ', body: 'Это тактическая трансляция Last Sector — публичный, только для просмотра, вид на матч.' },
    { title: 'КОРАБЛИ', body: 'Каждый цветной значок — корабль игрока. Наведите, чтобы увидеть HP и тип корабля.' },
    { title: 'СОБЫТИЯ', body: 'Лента справа показывает все действия в реальном времени, по мере их совершения.' },
  ];
  const demo = new LastSectorTutorialDemo(sceneRoot);
  const onboarding = new OnboardingRuntime({
    steps,
    onStep: (step, index, total) => {
      $('tutorial-title').textContent = step.title;
      $('tutorial-body').textContent = step.body;
      $('tutorial-step').textContent = `${index + 1} / ${total}`;
      $('tutorial-progress').style.width = `${((index + 1) / total) * 100}%`;
    },
    onComplete: () => { tutorialRoot.hidden = true; sceneRoot.hidden = true; },
  });
  tutorialRoot.hidden = false;
  sceneRoot.hidden = false;
  onboarding.start();
  $('tutorial-skip').addEventListener('click', () => onboarding.skip());
  window.addEventListener('keydown', e => { if (e.key === 'Escape') onboarding.skip(); else if (e.key === 'ArrowRight') onboarding.next(); else if (e.key === 'ArrowLeft') onboarding.prev(); });
}

runtime.start();
window.addEventListener('beforeunload', () => { renderScheduler.cancelPending(); client.stop(); });
