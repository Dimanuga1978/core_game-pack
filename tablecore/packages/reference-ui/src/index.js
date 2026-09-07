const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function formatEvent(event) {
  const data = event?.data ?? event ?? {};
  if (event?.type === 'PLAYER_MOVED') return `${data.actor} moved to (${data.to?.x}, ${data.to?.y})`;
  if (event?.type === 'PLAYER_ATTACKED') return `${data.actor} attacked ${data.target}`;
  if (event?.type === 'TURN_CHANGED') return `Turn: ${data.activePlayer}`;
  if (event?.type === 'GAME_FINISHED') return `Winner: ${data.winner}`;
  return event?.type ?? 'Event';
}

export function renderBoard(state) {
  const players = state?.players ?? {};
  const cells = [];
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
    const occupant = Object.values(players).find(p => p.position?.x === x && p.position?.y === y);
    cells.push(`<button class="cell${occupant ? ' occupied' : ''}" data-x="${x}" data-y="${y}" aria-label="Cell ${x}, ${y}">${occupant ? esc(occupant.id) : ''}</button>`);
  }
  return cells.join('');
}

export function renderView(view) {
  const frame = view?.frame;
  if (!frame) return '<main class="app"><section class="empty">Connecting to match…</section></main>';
  const state = frame.state;
  const active = state.activePlayer;
  const playerRows = Object.values(state.players ?? {}).map(p => `<div class="player"><b>${esc(p.id)}</b><span>HP ${esc(p.hp)}</span><span>${esc(p.position.x)}, ${esc(p.position.y)}</span></div>`).join('');
  const events = frame.events.slice(-6).reverse().map(e => `<li>${esc(formatEvent(e))}</li>`).join('');
  return `<main class="app">
    <header><div><strong>Grid Duel</strong><small>Reference Client</small></div><div class="status">${esc(state.phase)} · v${esc(frame.version)}</div></header>
    <section class="hud"><div><span>TURN</span><b>${esc(active)}</b></div><div><span>YOU</span><b>${esc(view.local?.playerId ?? '—')}</b></div><div><span>CONNECTION</span><b>${esc(view.local?.connection ?? 'local')}</b></div></section>
    <section class="game"><div class="board" role="grid">${renderBoard(state)}</div><aside><h2>Players</h2>${playerRows}<h2>Events</h2><ul class="events">${events || '<li>No events yet</li>'}</ul></aside></section>
    <footer><div class="actions"><button data-action="MOVE" data-direction="N">↑</button><button data-action="MOVE" data-direction="W">←</button><button data-action="ATTACK" class="attack">Attack</button><button data-action="MOVE" data-direction="E">→</button><button data-action="MOVE" data-direction="S">↓</button></div><div class="hint">Move only on your turn. Attack when adjacent.</div></footer>
  </main>`;
}
