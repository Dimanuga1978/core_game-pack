// The waiting-room page's own client JS. Deliberately simple: no WS, no
// game protocol at all, just plain HTTP polling of this launcher's own
// /api/lobby-seat-status/:lobbyId/:seatIndex proxy (which itself
// server-to-server-checks the loopback-only admin API -- this page runs
// in a REMOTE player's browser, which can never reach that admin API
// directly). See tools/server/start.mjs's own lobby data model comment
// for the full reasoning on why this exists as a genuinely SEPARATE page
// from player-ui: no real match exists until the organizer starts the
// game, so there is nothing for a live game client to connect to yet.
const params = new URLSearchParams(location.search);
const lobbyId = params.get('lobby');
const seatIndex = params.get('seat');

const $ = id => document.getElementById(id);
const seatLabel = $('seat-label');
const statusTitle = $('status-title');
const statusHint = $('status-hint');
const countHint = $('count-hint');
const spinner = $('spinner');
const errorBox = $('error');

function seatPlayerName(index) {
  // Same letter-naming convention as the server's own seatPlayerName()
  // in tools/server/start.mjs -- A, B, C, ... Z, AA, AB, ... -- purely
  // for display here (this page never decides anyone's actual player
  // id, the server does that).
  let n = Number(index), name = '';
  do { name = String.fromCharCode(65 + (n % 26)) + name; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return name;
}

function showError(message) {
  spinner.hidden = true;
  errorBox.textContent = message;
  errorBox.hidden = false;
}

if (!lobbyId || seatIndex === null || seatIndex === '') {
  showError('Ссылка повреждена — не хватает данных о лобби. Попросите организатора прислать ссылку заново.');
} else {
  seatLabel.textContent = seatPlayerName(seatIndex);

  let cancelled = false;
  window.addEventListener('beforeunload', () => { cancelled = true; });

  async function poll() {
    if (cancelled) return;
    try {
      const res = await fetch(`/api/lobby-seat-status/${encodeURIComponent(lobbyId)}/${encodeURIComponent(seatIndex)}`, { cache: 'no-store' });
      if (res.status === 404) {
        showError('Это лобби больше не существует — возможно, сервер перезапускался. Попросите организатора создать новое.');
        return;
      }
      const body = await res.json();
      // A real, direct request: the waiting page should show live
      // progress ("2 из 4 подключились"), not just a bare spinner with
      // no indication of how many people have joined so far.
      if (typeof body.claimedCount === 'number' && typeof body.seatCount === 'number') {
        countHint.textContent = `Подключилось: ${body.claimedCount} из ${body.seatCount}`;
      }
      if (body.started) {
        if (body.dropped) {
          // The organizer started the match without this specific seat
          // (see dropUnfilledSeats on POST /api/lobbies/:id/start) --
          // this can only happen to an UNCLAIMED seat, so a real person
          // watching this exact page always means THEY claimed it and
          // are therefore never the one dropped; shown anyway as a
          // defensive, honest message rather than assuming it can't
          // happen.
          spinner.hidden = true;
          statusTitle.textContent = 'Игра началась без этого места';
          statusHint.textContent = 'Организатор начал игру, не дожидаясь этого места. Свяжитесь с организатором, если это неожиданно.';
          return;
        }
        if (body.joinUrl) {
          spinner.hidden = true;
          statusTitle.textContent = 'Игра началась!';
          statusHint.textContent = 'Переходим...';
          location.href = body.joinUrl;
          return;
        }
      }
    } catch {
      // A transient network hiccup isn't worth interrupting the wait
      // for -- just try again on the next tick.
    }
    setTimeout(poll, 1500);
  }
  poll();
}
