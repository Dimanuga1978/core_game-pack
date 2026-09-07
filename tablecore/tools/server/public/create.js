// The create-match page's own client JS. Simplified after real, direct
// feedback: an earlier version had a "Обычный матч vs Лобби" mode
// toggle, per-player individual links, per-SEAT bot-strategy pickers --
// too many decisions for what is, in practice, "collect some friends and
// start a game". This version does exactly one thing: create a lobby
// (one shared link/QR, seats fill automatically as people join), then
// at start time offer exactly two choices if seats are still open:
// start with just who showed up, or fill the rest with randomly-picked
// bot strategies. No per-seat micromanagement.
//
// Runs entirely client-side, calling this same admin server's own API
// (same-origin -- no CORS concerns) plus rendering QR codes via the
// real, tested @tablecore/qrcode package (served at /qrcode/*, see
// start.mjs's own comment on why that route is exempt from the
// adminKey gate while the actual API calls below are not).
import { encodeQr, qrToSvg } from '/qrcode/index.js';

const params = new URLSearchParams(location.search);
const adminKey = params.get('key'); // see start.mjs's own comment: static assets (this page) are reachable without the key, but real API calls still need it if one is configured
const preselectedGame = params.get('game'); // set by the launcher's own "Играть" button -- see packages/launcher/public/index.html's own comment on why that link goes straight here now

async function api(path, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  if (adminKey) headers['x-admin-key'] = adminKey;
  const res = await fetch(path, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
async function apiRaw(path, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  if (adminKey) headers['x-admin-key'] = adminKey;
  const res = await fetch(path, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

const $ = id => document.getElementById(id);
const gameSelectBlock = $('game-select-block');
const gameHeading = $('game-heading');
const gameHeadingName = $('game-heading-name');
const gameHeadingDescription = $('game-heading-description');
const gameSelect = $('game-select');
const gameWarning = $('game-warning');
const seatCountInput = $('seat-count');
const submitBtn = $('submit-btn');
const form = $('lobby-form');
const errorBox = $('error');
const resultSection = $('result');
const resultMeta = $('result-meta');
const sharedLinkBox = $('shared-link');
const seatsBox = $('seats');
const startAsIsBtn = $('start-as-is-btn');
const startWithBotsBtn = $('start-with-bots-btn');
const startWarning = $('start-warning');

let games = [];
let currentLobbyId = null;
let currentGameId = null;
let pollTimer = null;
let lastStatus = null;

function checkGameWarning(selectedGameId) {
  const game = games.find(g => g.id === selectedGameId);
  if (!game) { gameWarning.hidden = true; return; }
  if (game.hasPlay === false) {
    gameWarning.textContent = `У игры «${game.id}» нет браузерного интерфейса игрока — ссылки откроются с ошибкой «not found». Создание заблокировано для этой игры.`;
    gameWarning.hidden = false;
    submitBtn.disabled = true;
  } else if (game.hasPlay === null) {
    gameWarning.textContent = 'Не удалось проверить, есть ли у этой игры интерфейс (лаунчер не настроен или недоступен) — ссылки могут не открыться.';
    gameWarning.hidden = false;
    submitBtn.disabled = false;
  } else {
    gameWarning.hidden = true;
    submitBtn.disabled = false;
  }
}

async function loadGames() {
  const data = await api('/api/games');
  games = data.games;
  if (preselectedGame && games.some(g => g.id === preselectedGame)) {
    // The organizer already picked this game on the launcher's own
    // catalog page -- showing a SECOND, redundant game picker here
    // (worse still, one that's briefly EMPTY while this fetch is in
    // flight -- see index.html's own `hidden` default on
    // game-select-block, added specifically to prevent that flash) was
    // a real, reported point of confusion. Show the game's real name/
    // description instead, prominently, as plain context -- not
    // another decision to make.
    currentGameId = preselectedGame;
    const game = games.find(g => g.id === preselectedGame);
    gameHeadingName.textContent = game.name || game.id;
    // Real prose description if the game's own manifest has one;
    // otherwise a short, still genuinely useful auto-generated line
    // from minPlayers/maxPlayers (data that already exists in every
    // manifest.json, not something needing separate content authoring)
    // rather than showing nothing at all.
    const description = game.description
      || (game.minPlayers && game.maxPlayers ? `${game.minPlayers === game.maxPlayers ? game.minPlayers : `${game.minPlayers}\u2013${game.maxPlayers}`} игрок${game.maxPlayers === 1 ? '' : 'ов'}` : '');
    gameHeadingDescription.textContent = description;
    gameHeadingDescription.hidden = !description;
    gameHeading.hidden = false;
    checkGameWarning(preselectedGame);
  } else {
    // Arrived directly at the admin port with no ?game= (e.g. a
    // bookmarked link, or the launcher-requested game wasn't actually
    // registered on this server) -- a real picker is genuinely needed
    // here, so this is the ONE case it's shown.
    gameSelectBlock.hidden = false;
    gameSelect.innerHTML = games.map(g => {
      const suffix = g.hasPlay === false ? ' — нет интерфейса игрока' : '';
      return `<option value="${g.id}">${g.name || g.id}${suffix}</option>`;
    }).join('');
    currentGameId = gameSelect.value;
    checkGameWarning(currentGameId);
    gameSelect.addEventListener('change', () => { currentGameId = gameSelect.value; checkGameWarning(currentGameId); });
  }
}

function renderQr(container, url) {
  try {
    const encoded = encodeQr(url);
    container.insertAdjacentHTML('beforeend', qrToSvg(encoded, { moduleSize: 8 }));
  } catch (error) {
    const note = document.createElement('p');
    note.className = 'qr-error';
    note.textContent = `QR недоступен: ${error.message}`;
    container.appendChild(note);
  }
}

function renderLinkCard(container, title, url) {
  const card = document.createElement('div');
  card.className = 'link-card';
  const qrDiv = document.createElement('div');
  qrDiv.className = 'qr';
  renderQr(qrDiv, url);
  card.innerHTML = `<div class="link-card-title">${title}</div>`;
  card.appendChild(qrDiv);
  const linkRow = document.createElement('div');
  linkRow.className = 'link-row';
  const a = document.createElement('a');
  a.href = url; a.textContent = url; a.target = '_blank'; a.rel = 'noopener';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button'; copyBtn.textContent = 'Копировать';
  copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(url);
    copyBtn.textContent = 'Скопировано!';
    setTimeout(() => { copyBtn.textContent = 'Копировать'; }, 1500);
  });
  linkRow.append(a, copyBtn);
  card.appendChild(linkRow);
  container.appendChild(card);
}

function renderSeats(seats) {
  seatsBox.innerHTML = seats.map(s =>
    `<div class="seat-row${s.claimed ? ' claimed' : ''}"><span class="seat-id">${s.playerId}</span><span class="seat-status">${s.claimed ? 'подключился' : 'ждём…'}</span></div>`
  ).join('');
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function pollStatus() {
  try {
    const status = await api(`/api/lobbies/${currentLobbyId}`);
    lastStatus = status;
    renderSeats(status.seats);
    const claimedCount = status.seats.filter(s => s.claimed).length;
    resultMeta.textContent = status.started
      ? `Игра началась · матч ${status.matchId}`
      : `Подключилось: ${claimedCount} из ${status.seats.length}`;
    if (status.started) {
      stopPolling();
      startAsIsBtn.hidden = true;
      startWithBotsBtn.hidden = true;
      return;
    }
    startAsIsBtn.disabled = claimedCount === 0;
    startAsIsBtn.textContent = claimedCount === status.seats.length
      ? 'Начать игру'
      : `Начать с ${claimedCount} игрок${claimedCount === 1 ? 'ом' : 'ами'}`;
    const game = games.find(g => g.id === currentGameId);
    const hasUnclaimed = claimedCount < status.seats.length;
    startWithBotsBtn.hidden = !hasUnclaimed || !game || !game.bots.length;
  } catch {
    // A transient poll failure isn't worth surfacing as a page-level
    // error -- just try again on the next tick.
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  errorBox.hidden = true;
  const seatCount = Number(seatCountInput.value);
  try {
    const created = await api('/api/lobbies', {
      method: 'POST',
      body: JSON.stringify({ gameId: currentGameId, seatCount, spectatorPolicy: 'public' }),
    });
    currentLobbyId = created.lobbyId;
    resultMeta.textContent = `Подключилось: 0 из ${seatCount}`;
    sharedLinkBox.innerHTML = '';
    if (created.joinLink) renderLinkCard(sharedLinkBox, 'Общая ссылка для всех игроков', created.joinLink.shortUrl);
    else sharedLinkBox.innerHTML = '<p>Ссылка недоступна — лаунчер не настроен (TABLECORE_LAUNCHER_URL).</p>';

    startWarning.hidden = true;
    startAsIsBtn.hidden = false;
    startWithBotsBtn.hidden = true;
    renderSeats(Array.from({ length: seatCount }, (_, i) => ({ playerId: String.fromCharCode(65 + i), claimed: false })));

    form.hidden = true;
    resultSection.hidden = false;
    stopPolling();
    pollTimer = setInterval(pollStatus, 1500);
    pollStatus();
  } catch (error) {
    errorBox.textContent = `Не удалось создать игру: ${error.message}`;
    errorBox.hidden = false;
  }
});

async function doStart(body) {
  startWarning.hidden = true;
  startAsIsBtn.disabled = true;
  startWithBotsBtn.disabled = true;
  const result = await apiRaw(`/api/lobbies/${currentLobbyId}/start`, { method: 'POST', body: JSON.stringify(body) });
  if (result.ok) {
    await pollStatus();
    return;
  }
  startAsIsBtn.disabled = false;
  startWithBotsBtn.disabled = false;
  startWarning.textContent = result.body.message || `Не удалось начать игру: ${result.body.error || result.status}`;
  startWarning.hidden = false;
}

startAsIsBtn.addEventListener('click', () => doStart({ dropUnfilledSeats: true }));

startWithBotsBtn.addEventListener('click', () => {
  // A randomly-picked strategy PER unclaimed seat (not the same one for
  // all of them) -- a direct answer to "стратегии ботов добавляются
  // рандомно": simpler than an earlier per-seat picker UI, but still
  // genuinely varied rather than every bot playing identically.
  const game = games.find(g => g.id === currentGameId);
  const strategies = game?.bots ?? [];
  const fillEmptyWithBot = {};
  for (const seat of lastStatus?.seats ?? []) {
    if (seat.claimed) continue;
    fillEmptyWithBot[seat.playerId] = strategies[Math.floor(Math.random() * strategies.length)];
  }
  doStart({ fillEmptyWithBot, dropUnfilledSeats: false });
});

$('create-another').addEventListener('click', () => {
  stopPolling();
  currentLobbyId = null;
  lastStatus = null;
  resultSection.hidden = true;
  form.hidden = false;
  seatCountInput.value = '4';
});

loadGames().catch(error => {
  errorBox.textContent = `Не удалось загрузить список игр: ${error.message}`;
  errorBox.hidden = false;
});
