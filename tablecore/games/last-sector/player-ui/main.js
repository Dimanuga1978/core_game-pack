import { PlayerClient } from '/engine-client/player-client.js';
import { ClientRuntime } from '/engine-client/runtime.js';
import { FrameScheduler } from '/engine-client/frame-scheduler.js';
import { reduceLastSectorEvent } from '../client/client-state.mjs';
import { createAssetIcon, assetName } from '../client/assets.mjs';
import { computeBoardDimensions } from '../client/hex-geometry.mjs';
import { createHexBoard, updateHexTile, setTileReachable, updateHexShips, colorForOwner } from '../client/hex-board.mjs';

const q = new URLSearchParams(location.search);
const match = q.get('match') || 'demo';
const player = q.get('player') || 'p1';
// A bare player id is NOT sufficient to authenticate against this
// engine's real WS protocol -- see player-client.js's own comment for
// why. A real deployment's admin API (tools/server/start.mjs) issues one
// token per player when a match is created; whatever hands a player
// their join link is expected to include it here. Without one, PlayerClient
// refuses to open a connection at all (fails loud, not silently as an
// unauthenticated/broken connection attempt).
const token = q.get('token') || null;
// Default port fixed (was 8080, the real server's actual default port is
// 4180 -- see tools/server/start.mjs's own TABLECORE_SERVER_PORT
// default). This mismatch meant that opening this page via ANY route
// that doesn't explicitly supply `?ws=` (e.g. the launcher's own "Play"
// button, which -- see ADMIN.md's documented limitation -- just
// navigates here without ever supplying match/token/ws at all) would
// try to connect to a port nothing is listening on, even once a real
// match/token were otherwise available.
const wsUrl = q.get('ws') || `ws://${location.hostname || 'localhost'}:4180`;
const socketConnect = () => new Promise((resolve, reject) => {
  const s = new WebSocket(wsUrl);
  s.onopen = () => resolve(s);
  s.onerror = reject;
});
const client = new PlayerClient({ connect: socketConnect, match, principal: player, token });
const runtime = new ClientRuntime(client, { stateReducer: reduceLastSectorEvent });
const $ = id => document.getElementById(id);
// Set once here, not inside render() -- `player` is a fixed value read
// from the URL at page load and never reassigned for the whole session,
// so writing it into the DOM on every single render (as this used to
// do, unconditionally, every call) had zero possible effect beyond the
// very first one. Same class of real, measured redundancy as
// hex-board.mjs's own tile/ship update fixes, just simpler to spot here
// since the underlying value can't even change.
$('player').textContent = player;
const status = $('status');
const grid = $('grid');
const events = $('events');
const buttons = $('buttons');
let selectedAction = null;
let renderedActionKey = '';

// Real hex-grid board: real SVG polygons that actually tile edge-to-edge
// (see hex-geometry.mjs's own doc comment -- a direct fix for a real,
// reported complaint that the previous plain rectangular CSS grid made
// hexes look disconnected from each other, since it never actually drew
// hexagon shapes at all). `hexBoard` is built lazily, once the first
// real snapshot's tiles array reveals the true board size -- see
// computeBoardDimensions's own comment on why board size has to be
// INFERRED from the tiles array rather than read from a `cfg.w`/`cfg.h`
// field (the wire protocol doesn't currently send one).
let hexBoard = null;
const shipRefs = new Map();
// Tracks which coords currently have the 'reachable' highlight applied
// -- see the diffing logic inside render() below for why: touching
// setTileReachable() (a real classList mutation) for all ~81 tiles on
// every single render(), even though the set of reachable tiles rarely
// changes between consecutive renders, was real, measurable wasted DOM
// work (see hex-board.mjs's own updateHexTile for the same class of fix
// applied to tile kind/collapsed/loot).
let reachableCoords = new Set();

function createObjectIcon(doc, kind) {
  return createAssetIcon(doc, assetName(kind), { className: 'ls-asset' });
}

function createShipIcon(doc, unit) {
  const g = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.classList.add('ship-mark');
  const isSelf = unit.owner === player;
  g.classList.toggle('own', isSelf);
  g.classList.toggle('other', !isSelf);
  g.dataset.ship = unit.shipType || '';
  g.dataset.owner = isSelf ? 'self' : 'other';
  // Per-real-player color, not just a binary own/other split -- a
  // direct fix for a real limitation: with 3-4 players, every OTHER
  // player used to render in the exact same single "other" color,
  // making it impossible to visually tell two different opponents
  // apart on the board. See hex-board.mjs's own colorForOwner() comment
  // for why this is hash-based (deterministic per real player id) and
  // not simply "order of appearance".
  g.style.color = colorForOwner(unit.owner, player);
  g.appendChild(createObjectIcon(doc, unit.shipType));
  return g;
}

function ensureHexBoard(state) {
  if (hexBoard || !Array.isArray(state?.tiles) || !state.tiles.length) return;
  const { cols, rows } = computeBoardDimensions(state.tiles);
  if (!cols || !rows) return;
  hexBoard = createHexBoard(document, cols, rows, 28);
  grid.replaceChildren(hexBoard.svg);
  grid.addEventListener('click', event => {
    if (selectedAction !== 'MOVE') return;
    const tileGroup = event.target.closest?.('[data-coord]');
    const coord = tileGroup?.dataset?.coord;
    if (!coord) return;
    const ref = hexBoard.tiles.get(coord);
    if (!ref?.g.classList.contains('reachable')) return;
    runtime.command({ type: 'MOVE', to: coord });
    selectedAction = null;
    renderScheduler.schedule();
  });
}

// Real people testing this game hit exactly this: no console error, page
// loads fine, but the board area just stays empty forever -- because
// without a token, PlayerClient refuses to even attempt a connection
// (see player-client.js's own comment), and the board is only ever
// populated once a real sync succeeds. The failure was real and correct
// (never silently connect unauthenticated), but nothing on the page
// EXPLAINED why the board was empty -- a small "ОШИБКА СОЕДИНЕНИЯ" label
// in the top bar is easy to miss entirely. This puts an impossible-to-
// miss explanation directly where the board itself would be, immediately
// on page load (no need to wait for a failed connection attempt to know
// this in advance -- we already know at parse time whether a token was
// supplied at all).
if (!token) {
  const notice = document.createElement('div');
  notice.id = 'no-match-notice';
  notice.innerHTML = '<strong>Нет активного матча</strong><p>Эта ссылка открыта без реального матча — обычно так происходит при переходе по кнопке «Играть» из общего каталога игр, которая сама по себе не создаёт матч. Попросите организатора матча прислать полную ссылку с параметрами <code>match</code>, <code>player</code>, <code>token</code> и <code>ws</code> (создаётся через admin API — см. ADMIN.md, раздел «Создать матч и получить ссылку для игрока»).</p>';
  document.querySelector('.map-frame')?.appendChild(notice);
}

const renderScheduler = new FrameScheduler(() => {
  render();
  buildButtons();
});

function setStatus(v) {
  const labels = { connecting:'ПОДКЛЮЧЕНИЕ…', 'transport-connected':'СОЕДИНЕНИЕ УСТАНОВЛЕНО', 'session-ready':'ГОТОВ', connected:'ПОДКЛЮЧЕНО', resumed:'ПЕРЕПОДКЛЮЧЕНО', disconnected:'СВЯЗЬ ПОТЕРЯНА', 'connect-error':'ОШИБКА СОЕДИНЕНИЯ', stopped:'ОСТАНОВЛЕНО' };
  status.textContent = labels[v] || String(v).toUpperCase();
  status.className = v === 'connected' || v === 'resumed' || v === 'session-ready' ? 'status-ok' : 'status-bad';
}

let autoReadySent = false;
runtime.on('state', state => {
  setStatus(state);
  const qs = new URLSearchParams(location.search);
  if (qs.get('deviceTest') === '1' && qs.get('autoReady') === '1' && !autoReadySent && (state === 'session-ready' || state === 'resumed')) {
    autoReadySent = true;
    runtime.ready(true);
    queueLog('device-test: ready');
  }
});
runtime.on('error', e => queueLog(`error: ${e.code || e.message || 'unknown'}`));
runtime.on('snapshot', () => renderScheduler.schedule());
runtime.on('events', (list, msg) => {
  queueLogs(list, msg?.stream);
  if (msg?.stream === 'state') renderScheduler.schedule();
});

function render() {
  const snap = runtime.snapshot;
  const state = snap?.state;
  if (!state) return;
  ensureHexBoard(state);
  if (!hexBoard) return; // board size not knowable yet (no tiles in this snapshot) -- next render() call will retry

  const own = state.units?.find(u => u.owner === player && u.status !== 'destroyed');
  if (own) {
    $('ship-type').textContent = own.shipType.toUpperCase();
    $('ship-hp').textContent = `${own.hp}/${own.maxHp} HP`;
    $('hp-readout').textContent = `${own.hp}/${own.maxHp}`;
    $('fuel-readout').textContent = `${own.fuel}`;
    $('move-readout').textContent = `${own.moves}`;
    $('hp-bar').style.width = `${Math.max(0, Math.min(100, own.hp / Math.max(1, own.maxHp) * 100))}%`;
    $('fuel-bar').style.width = `${Math.max(0, Math.min(100, own.fuel / Math.max(1, own.maxFuel ?? 10) * 100))}%`;
    $('move-bar').style.width = `${Math.max(0, Math.min(100, own.moves / Math.max(1, own.movePoints ?? 4) * 100))}%`;
    $('score').textContent = snap.scores?.[player] ?? state.scores?.[player] ?? 0;
    $('cargo').textContent = (own.cargo || []).length;
  }
  $('turn').textContent = `Active: ${snap.active || '—'}`;
  updateMobileStatus(own);

  const units = (state.units || []).filter(u => u.status !== 'destroyed');

  const nextReachable = new Set();
  for (const cell of state.tiles || []) {
    const ref = hexBoard.tiles.get(cell.coord);
    if (!ref) continue;
    updateHexTile(document, ref, cell, createObjectIcon);
    // Same scope as before this hex-geometry port: "reachable" highlight
    // applies to any DISCOVERED tile while a MOVE is pending, not a real
    // legality check (adjacency/collapsed/occupancy) -- the server is
    // always the actual authority and rejects an illegal MOVE regardless;
    // preserved here as-is rather than widened, to keep this specific
    // change scoped to the hex-rendering geometry itself. Computed here,
    // in the SAME pass as updateHexTile (not a second full iteration),
    // and only APPLIED below via a diff against the previous set -- see
    // reachableCoords' own declaration above for why that diff is what
    // actually avoids touching all ~81 tiles' DOM on every render.
    if (selectedAction === 'MOVE') {
      const kind = cell.kind || 'hidden';
      if (kind !== 'hidden') nextReachable.add(cell.coord);
    }
  }
  for (const coord of nextReachable) {
    if (!reachableCoords.has(coord)) setTileReachable(hexBoard.tiles.get(coord), true);
  }
  for (const coord of reachableCoords) {
    if (!nextReachable.has(coord)) setTileReachable(hexBoard.tiles.get(coord), false);
  }
  reachableCoords = nextReachable;

  updateHexShips(document, hexBoard.shipsGroup, units, hexBoard.tiles, shipRefs, createShipIcon);
  for (const u of units) {
    const ref = shipRefs.get(u.id);
    if (!ref) continue;
    // Ownership (own vs other) never changes for a given unit's whole
    // lifetime -- createShipIcon() above already sets these classes
    // exactly ONCE, at creation. Re-toggling the SAME own/other value
    // for every unit on every single render (as this loop used to do
    // unconditionally) was pure wasted work with zero possible visible
    // effect, ever -- the same class of real, measured redundancy as
    // hex-board.mjs's own updateHexTile/updateHexShips fixes.
    const title = u.owner === player
      ? `${({scout:'РАЗВЕДЧИК',transport:'ТРАНСПОРТ',warship:'БОЕВОЙ КОРАБЛЬ',tanker:'ТАНКЕР'}[u.shipType]||u.shipType).toUpperCase()} • ${u.hp}/${u.maxHp} прочности • ${u.fuel} топлива`
      : `Игрок ${u.owner} • ${u.shipType} • позиция ${u.coord}`;
    if (ref.title !== title) {
      ref.title = title;
      ref.g.replaceChildren(...[...ref.g.children].filter(c => c.tagName !== 'title'));
      const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      titleEl.textContent = title;
      ref.g.appendChild(titleEl);
    }
  }
}

const EVENT_NAMES = Object.freeze({
  SECTOR_GENERATED:'Сектор создан', SHIP_MOVED:'Корабль перемещён', TELEPORTED:'Телепорт', FORCED_MOVE:'Принудительное перемещение',
  PLAYER_SHIP_DESTROYED:'Корабль уничтожен', CARGO_DELIVERED:'Груз доставлен', SIGNAL_GOOD:'Сигнал принят', TRAP_PLACED:'Ловушка установлена',
  TURN_STARTED:'Начало хода', DISCOVERY_REVEALED:'Обнаружено', LOOT_FOUND:'Найден ресурс', BATTLE_RESOLVED:'Бой завершён', GREAT_STORM:'Великий шторм'
});
const ACTIONS = Object.freeze({
  MOVE:['i-move','Движение'], ATTACK:['i-attack','Атака'], ATTACK_TANKER:['i-attack','Атака танкера'],
  SCAN:['i-scan','Сканирование'], COLLECT:['i-collect','Сбор'], TELEPORT:['i-teleport','Телепорт'],
  REPAIR:['i-repair','Ремонт'], BUY_FUEL:['i-fuel','Купить топливо'], BUY_TRAP:['i-trap','Установить ловушку'], END_TURN:['i-end','Конец хода']
});
function actionButton(action, mobile=false) {
  const meta=ACTIONS[action]||['i-info',action.replaceAll('_',' ').toLowerCase()];
  const b=document.createElement('button'); b.type='button'; b.className='action-button'; b.dataset.action=action;
  b.setAttribute('aria-label',meta[1]); b.title=meta[1];
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('aria-hidden','true');
  const use=document.createElementNS('http://www.w3.org/2000/svg','use'); use.setAttribute('href',`./icons.svg#${meta[0]}`); svg.appendChild(use);
  const label=document.createElement('span'); label.className='action-label'; label.textContent=meta[1]; b.append(svg,label);
  if(action==='MOVE') b.addEventListener('click',()=>{selectedAction='MOVE'; renderScheduler.schedule();});
  else b.addEventListener('click',()=>runtime.command({type:action}));
  return b;
}
function buildButtons() {
  const actions=runtime.snapshot?.availableActions||[]; const key=actions.join('|'); if(renderedActionKey===key)return; renderedActionKey=key;
  const frag=document.createDocumentFragment(); const mfrag=document.createDocumentFragment();
  for(const action of actions){frag.appendChild(actionButton(action));mfrag.appendChild(actionButton(action,true));}
  buttons.replaceChildren(frag); $('mobile-actions').replaceChildren(mfrag);
}
function updateMobileStatus(own) {
  if(!own)return;
  $('m-hp').textContent=`${own.hp}`; $('m-fuel').textContent=`${own.fuel}`; $('m-moves').textContent=`${own.moves}`;
  $('m-turn').textContent=(runtime.snapshot?.active||'—').toString().slice(0,4).toUpperCase();
}
function openMobileInfo(){
  const sheet=$('mobile-sheet'); const own=runtime.snapshot?.state?.units?.find(u=>u.owner===player&&u.status!=='destroyed');
  sheet.replaceChildren();
  const title=document.createElement('div'); title.className='sheet-title'; title.textContent=own?'СОСТОЯНИЕ КОРАБЛЯ':'КОРАБЛЬ'; sheet.append(title);
  if(!own){const empty=document.createElement('div'); empty.className='sheet-value'; empty.textContent='Активный корабль отсутствует'; sheet.append(empty); sheet.hidden=false; return;}
  const type=document.createElement('div'); type.className='sheet-value'; type.textContent=(({scout:'РАЗВЕДЧИК',transport:'ТРАНСПОРТ',warship:'БОЕВОЙ КОРАБЛЬ',tanker:'ТАНКЕР'}[own.shipType]||own.shipType||'').toUpperCase()); sheet.append(type);
  const rows=[['КОРПУС',`${own.hp}/${own.maxHp}`],['ТОПЛИВО',String(own.fuel)],['ОД',String(own.moves)],['ГРУЗ',String((own.cargo||[]).length)],['ОЧКИ',String(runtime.snapshot?.scores?.[player]??runtime.snapshot?.state?.scores?.[player]??0)]];
  for(const [k,v] of rows){const row=document.createElement('div'); row.className='sheet-row'; const l=document.createElement('span'); l.textContent=k; const b=document.createElement('b'); b.textContent=v; row.append(l,b); sheet.append(row);}
  sheet.hidden=!sheet.hidden;
}
$('mobile-info')?.addEventListener('click',openMobileInfo);
document.addEventListener('click', event => { const sheet=$('mobile-sheet'); if (!sheet || sheet.hidden) return; if (event.target.closest?.('#mobile-sheet') || event.target.closest?.('#mobile-info') || event.target.closest?.('#mobile-menu')) return; sheet.hidden=true; });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { const sheet=$('mobile-sheet'); if (sheet) sheet.hidden=true; } });
$('mobile-menu')?.addEventListener('click',()=>{
  const sheet=$('mobile-sheet');
  const actions=runtime.snapshot?.availableActions||[];
  sheet.hidden=false;
  sheet.replaceChildren(); const title=document.createElement('div'); title.className='sheet-title'; title.textContent='ТАКТИЧЕСКОЕ УПРАВЛЕНИЕ'; sheet.append(title);
  const value=document.createElement('div'); value.className='sheet-value'; value.textContent=actions.length ? actions.map(a=>String(a).replaceAll('_',' ')).join(' · ') : 'Доступных действий нет'; sheet.append(value);
  const row=document.createElement('div'); row.className='sheet-row'; const l=document.createElement('span'); l.textContent='СОЕДИНЕНИЕ'; const b=document.createElement('b'); b.textContent=status.textContent; row.append(l,b); sheet.append(row);
});

const logQueue = [];
let logScheduled = false;
function queueLogs(list, stream) {
  for (const e of list || []) logQueue.push(`${stream === 'presentation' ? 'ВИЗУАЛ' : 'СОСТОЯНИЕ'}: ${EVENT_NAMES[e.type] || String(e.type).replaceAll('_',' ')}`);
  scheduleLogFlush();
}
function queueLog(text) { logQueue.push(text); scheduleLogFlush(); }
function scheduleLogFlush() {
  if (logScheduled) return;
  logScheduled = true;
  queueMicrotask(flushLogs);
}
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
  events.prepend(frag);
  while (events.children.length > 40) events.lastElementChild.remove();
}

buildButtons();
runtime.start();
window.addEventListener('beforeunload', () => { renderScheduler.cancelPending(); client.stop(); });
