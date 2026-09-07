// Dependency-free reference UI. A production client supplies the same public view shape.
// This demo hardcodes local player ids ('A'/'B') and never talks to a
// server, so it isn't independently exploitable as shipped -- but it is
// exactly the kind of file an integrator copy-pastes while wiring in real
// server data, and at that point an unescaped playerId/display name
// interpolated into innerHTML is a stored-XSS vector. Escaping here
// mirrors packages/reference-ui/src/index.js's `esc()`, which the actual
// networked reference client already uses for this exact reason.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const root = document.querySelector('#root');
const state={turn:0,activePlayer:'A',phase:'playing',winner:null,players:{A:{id:'A',hp:3,position:{x:0,y:0}},B:{id:'B',hp:3,position:{x:4,y:4}}}};
let version=0, events=[];
const dirs={N:[0,-1],S:[0,1],E:[1,0],W:[-1,0]};
const render=()=>{const cells=[];for(let y=0;y<5;y++)for(let x=0;x<5;x++){const p=Object.values(state.players).find(v=>v.position.x===x&&v.position.y===y);cells.push(`<button class="cell ${p?'occupied':''}">${p?esc(p.id):''}</button>`)}root.innerHTML=`<main class="app"><header><div><strong>Grid Duel</strong><small>Reference Client · local demo</small></div><div class="status">${esc(state.phase)} · v${esc(version)}</div></header><section class="hud"><div><span>TURN</span><b>${esc(state.activePlayer)}</b></div><div><span>MODE</span><b>Player</b></div><div><span>CONNECTION</span><b>Demo</b></div></section><section class="game"><div class="board">${cells.join('')}</div><aside><h2>Players</h2>${Object.values(state.players).map(p=>`<div class="player"><b>${esc(p.id)}</b><span>HP ${esc(p.hp)}</span><span>${esc(p.position.x)}, ${esc(p.position.y)}</span></div>`).join('')}<h2>Events</h2><ul class="events">${events.slice(-6).reverse().map(e=>`<li>${esc(e)}</li>`).join('')||'<li>Ready</li>'}</ul></aside></section><footer><div class="actions"><button data-dir="N">↑</button><button data-dir="W">←</button><button data-attack>Attack</button><button data-dir="E">→</button><button data-dir="S">↓</button></div><div class="hint">This demo visualizes the public client flow; real play plugs into ClientRuntime.</div></footer></main>`};
function move(d){if(state.phase!=='playing')return;const p=state.players[state.activePlayer],q=dirs[d],to={x:p.position.x+q[0],y:p.position.y+q[1]};if(to.x<0||to.x>4||to.y<0||to.y>4){events.push('Rejected: out of bounds');render();return}if(Object.values(state.players).some(x=>x.id!==p.id&&x.position.x===to.x&&x.position.y===to.y)){events.push('Rejected: occupied');render();return}p.position=to;events.push(`${p.id} moved`);state.activePlayer=state.activePlayer==='A'?'B':'A';version++;render()}
function attack(){const p=state.players[state.activePlayer],t=state.players[state.activePlayer==='A'?'B':'A'];if(Math.abs(p.position.x-t.position.x)+Math.abs(p.position.y-t.position.y)!==1){events.push('Rejected: target not adjacent');render();return}t.hp--;events.push(`${p.id} attacked ${t.id}`);version++;if(t.hp<=0){state.phase='finished';state.winner=p.id;events.push(`Winner: ${p.id}`)}else state.activePlayer=t.id;render()}
root.addEventListener('click',e=>{const d=e.target.dataset.dir;if(d)move(d);if(e.target.hasAttribute('data-attack'))attack()});render();
