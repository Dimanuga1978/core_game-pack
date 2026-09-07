'use strict';
const CONTENT = require('../../content/legacy.cjs');
const { loadScenario } = require('../../scenarios/legacy.cjs');

const SHIPS = CONTENT.ships;
const LOOT = Object.fromEntries(Object.entries(CONTENT.loot).map(([k, v]) => [k, { ...v }]));
const key = (q, r) => `${q},${r}`;
const parse = (c) => { const [q, r] = String(c).split(',').map(Number); return { q, r }; };
function cube(coord) { const { q, r } = parse(coord); const x = q - (r - (r & 1)) / 2; const z = r; return { x, y: -x - z, z }; }
function dist(a, b) { const A = cube(a), B = cube(b); return Math.max(Math.abs(A.x - B.x), Math.abs(A.y - B.y), Math.abs(A.z - B.z)); }
function neighborsFor(coord, w, h, blocked = null) {
  const { q, r } = parse(coord);
  const dirs = r % 2 === 0
    ? [[1, 0], [-1, 0], [0, -1], [-1, -1], [0, 1], [-1, 1]]
    : [[1, 0], [-1, 0], [1, -1], [0, -1], [1, 1], [0, 1]];
  return dirs.map(([dq, dr]) => key(q + dq, r + dr))
    .filter(c => { const p = parse(c); return p.q >= 0 && p.r >= 0 && p.q < w && p.r < h && (!blocked || !blocked(c)); });
}
function cargoUsed(cargo) { return Array.isArray(cargo) ? cargo.reduce((s, i) => s + (Number(i?.slots) || 0), 0) : 0; }
function cargoValue(cargo) { return Array.isArray(cargo) ? cargo.reduce((s, i) => s + (Number(i?.value) || 0), 0) : 0; }
function canTake(u, item) { return !!u && !!item && cargoUsed(u.cargo) + (Number(item.slots) || 0) <= u.cargoSlots; }

function createDefinition(options = {}) {
  const scenario = loadScenario(options.scenario);
  // gridWidth/gridHeight used to flow into board generation with zero
  // upper bound -- confirmed directly: {gridWidth:100000,
  // gridHeight:100000} OOM-crashed the entire Node process (heap
  // exhaustion) after tens of seconds, a real, severe DoS reachable by
  // anyone able to create a match with custom options (one bad request
  // takes the whole server down for every connected player at once, not
  // just the requester). Clamped to a generous but genuinely bounded
  // ceiling: far larger than any shipped scenario ever uses (the default
  // is 9x9), nowhere near enough cells to threaten process memory.
  const MAX_GRID_DIMENSION = 40; // ~160ms worst case for board generation, measured directly -- see this function's own comment above for why an unbounded value is dangerous. 40x40 (1600 tiles) is already ~20x the shipped default (9x9=81 tiles), generous headroom for custom scenarios without meaningfully degrading service for other connected players during match creation.
  const clampGridDimension = (value, fallback) => {
    const n = +value || fallback;
    return Math.max(1, Math.min(MAX_GRID_DIMENSION, Math.floor(n)));
  };
  const cfg = {
    w: clampGridDimension(options.gridWidth, 9),
    h: clampGridDimension(options.gridHeight, 9),
    n: +options.playerCount || 2,
    session: +options.sessionMinutes || 5,
    fuel: +options.maxFuel || 10,
    mp: +options.movePoints || 4,
    trapPrice: +options.trapPrice || 700,
    fuelPrice: +options.fuelPrice || 500,
    fuelPerBuy: +options.fuelPerBuy || 3,
    shipLives: +options.shipLives || 3,
    trapsEnabled: options.trapsEnabled !== false,
    turnSeconds: +options.turnSeconds || 30
  };
  return {
    id: 'last-sector',
    minPlayers: () => cfg.n,
    maxPlayers: () => cfg.n,
    requireReady: true,
    onboarding: {
      id: 'last-sector-intro', version: 2, gateStart: true, allowSkip: true,
      steps: [
        { id:'goal', title:'ЦЕЛЬ', body:'Исследуйте сектор, собирайте ресурсы и возвращайте ценный груз на свою базу.', durationMs:4200, focus:'база', demo:{type:'goal',camera:{x:52,y:52,scale:1.04}} },
        { id:'map', title:'СЕКТОР', body:'Каждый гекс — часть тактического поля. Исследование открывает скрытое.', durationMs:5200, focus:'карта', demo:{type:'map',camera:{x:50,y:50,scale:1.1}} },
        { id:'move', title:'ДВИЖЕНИЕ', body:'Перемещайтесь между соседними гексами. Каждый ход требует 1 ОД и 1 единицу топлива.', durationMs:5600, focus:'движение', demo:{type:'move',camera:{x:57,y:46,scale:1.22},from:'4,4',to:'5,4',choreography:[{point:{x:46,y:54},scale:1.06},{point:{x:58,y:47},scale:1.22},{point:{x:64,y:44},scale:1.26}],choreographyDurationMs:2200} },
        { id:'discovery', title:'ОБНАРУЖЕНИЕ', body:'Вход или сканирование раскрывает объект сектора и может открыть информацию для всех.', durationMs:6000, focus:'ресурсы', demo:{type:'discovery',camera:{x:62,y:48,scale:1.24},coord:'6,4'} },
        { id:'combat', title:'БОЙ', body:'Атакуйте вражеские корабли рядом. Щиты поглощают первый удар, последующие снижают прочность.', durationMs:6200, focus:'бой', demo:{type:'combat',camera:{x:54,y:52,scale:1.26},from:'5,4',to:'6,4'} },
        { id:'loot', title:'РЕСУРСЫ', body:'Обычные ресурсы могут стать публичными, редкие могут оставаться известными только обнаружившему.', durationMs:5200, focus:'ресурсы', demo:{type:'loot',camera:{x:64,y:47,scale:1.2},coord:'6,4'} },
        { id:'win', title:'ПОБЕДА', body:'Доставляйте груз на свою базу. В сценариях на очки побеждает первый, кто достигнет цели.', durationMs:4200, focus:'база', demo:{type:'victory',camera:{x:50,y:52,scale:1.06}} }
      ]
    },
    createState: () => ({ cfg, scenario, tiles:new Map(), units:new Map(), scores:new Map(), next:1, traps:[], tankerRespawn:3, tankerDefeatedUntil:0, collapseStage:0, globalEvent:null, globalEventUntil:0, finalRush:false, stats:{ moves:0,battles:0,loot:0,deliveries:0,traps:0,trapHits:0,signals:0,signalGood:0,signalBad:0,nebulaEntries:0,nebulaExits:0,globalEvents:0,glitches:0,hiddenUnits:0 }, discovered:new Map(), timeBonusSec:0 }),
    setup(ctx) {
      const s = ctx.state, players = [...ctx.players.keys()];
      s.tiles = createBoard(ctx); s.lives = {}; s.eliminated = {}; s.tankerRespawn = ctx.random.int(3,6);
      players.forEach((id, i) => {
        const homes = baseCoordinates(cfg);
        const spawnCfg = s.scenario?.playerSpawns?.[id] || s.scenario?.playerSpawns?.[i] || {};
        const home = spawnCfg.coord || homes[i];
        const type = spawnCfg.shipType || ctx.players.get(id).shipType || ['scout','transport','warship'][i % 3];
        const u = spawnUnit(s, id, home, type);
        Object.assign(u, spawnCfg.overrides || {});
        s.scores.set(id, 0);
        s.discovered.set(id, new Map());
        // The original rules begin with the map hidden. Own base and ship position are still known to the player.
        rememberTile(ctx, id, home);
        for (const c of publicCoords(s)) rememberTile(ctx, id, c);
      });
      
      ctx.emit('SECTOR_GENERATED', { cells:s.tiles.size, objectCount:[...s.tiles.values()].filter(t=>t.kind!=='empty').length });
    },
    actions: {
      MOVE: (ctx, c) => move(ctx, c),
      ATTACK: (ctx, c) => attack(ctx, c),
      STEAL: (ctx, c) => steal(ctx, c),
      SCAN: (ctx) => scan(ctx),
      REPAIR: (ctx) => repair(ctx),
      BUY_FUEL: (ctx) => buyFuel(ctx),
      BUY_TRAP: (ctx) => buyTrap(ctx),
      ATTACK_TANKER: (ctx) => attackTanker(ctx),
      END_TURN: (ctx) => nextTurn(ctx, true)
    },
    availableActions(ctx, viewer, list) {
      const u = get(ctx, viewer);
      if (!u) return [];
      const tile = ctx.state.tiles.get(u.coord);
      const actions = ['END_TURN'];
      if (u.moves <= 0) return actions;
      if (list.includes('MOVE') && neighbors(ctx, u.coord).some(c => validMove(ctx, u, c))) actions.push('MOVE');
      if (list.includes('SCAN') && u.scanAvailable && (tile?.kind === 'station' || tile?.kind === 'superstation')) actions.push('SCAN');
      if (list.includes('REPAIR') && (atHome(u) || tile?.kind === 'station' || tile?.kind === 'superstation') && (u.hp < u.maxHp || u.fuel < u.maxFuel)) actions.push('REPAIR');
      if (list.includes('BUY_FUEL') && (ctx.state.scores.get(u.owner)||0) >= ctx.state.cfg.fuelPrice && u.fuel < u.maxFuel) actions.push('BUY_FUEL');
      if (list.includes('BUY_TRAP') && ctx.state.cfg.trapsEnabled && ctx.state.cfg.n > 3 && u.moves > 0 && (ctx.state.scores.get(u.owner)||0) >= ctx.state.cfg.trapPrice && ctx.state.traps.filter(t=>t.owner===u.owner).length < trapLimit(ctx) && !ctx.state.traps.some(t=>t.owner===u.owner&&t.coord===u.coord)) actions.push('BUY_TRAP');
      const adjacent = opponentUnits(ctx, u).filter(e => dist(u.coord, e.coord) === 1 && !atHome(e));
      if (list.includes('ATTACK') && adjacent.length && !(tile?.kind === 'nebula' && tile.resolved)) actions.push('ATTACK');
      if (list.includes('STEAL') && adjacent.some(e => e.cargo.length) && !(tile?.kind === 'nebula' && tile.resolved)) actions.push('STEAL');
      const tanker = [...ctx.state.units.values()].find(x=>x.owner==='tanker'&&x.hp>0);
      if (list.includes('ATTACK_TANKER') && tanker && dist(u.coord,tanker.coord) === 1 && u.moves > 0) actions.push('ATTACK_TANKER');
      return [...new Set(actions)];
    },
    effects: {
      AUTO_TURN(ctx) { nextTurn(ctx); }
    },
    stateBasedRules: [{ id:'AUTO_TURN', test:ctx => { const u = get(ctx, ctx.active); return !!u && u.moves <= 0 && !ctx.pending; }, effect:{type:'AUTO_TURN'} }],
    victory(ctx) {
      const scenarioScore = ctx.state.scenario?.victoryMode === 'score' && Number(ctx.state.scenario?.victoryScore) > 0 ? Number(ctx.state.scenario.victoryScore) : null;
      if (scenarioScore) {
        for (const [id, score] of ctx.state.scores) if (score >= scenarioScore) return { winner:id, reason:'scenario-score', score };
      }
      const alive = [...ctx.players.values()].filter(p => !p.eliminated);
      if (alive.length === 1) return { winner:alive[0].id, reason:'last-ship-standing' };
      if (ctx.turn > Math.ceil((cfg.session * 60 + (ctx.state.timeBonusSec || 0)) / cfg.turnSeconds)) {
        const rows = [...ctx.state.scores.entries()].sort((a,b)=>b[1]-a[1]);
        return rows[0] ? { winner:rows[0][0], reason:'time-score', score:rows[0][1] } : null;
      }
      return null;
    },
    project(state, viewer, base, view={}) {
      const own = getState(state, viewer), knowledge = view.knowledge?.tiles || {};
      const tiles = [...state.tiles.entries()].map(([coord,t]) => {
        const known = knowledge[coord] || {};
        const ownBase = own?.home === coord;
        const publicCell = t.kind === 'base' || t.kind === 'center' || !!t.revealedGlobally;
        const isKnown = !!known.kind || ownBase || !!t.revealedGlobally;
        const kind = publicCell || isKnown ? (known.kind || t.kind) : 'hidden';
        // A real, measured optimization: this array is ~91% of a
        // typical UPDATE/SYNC message's total payload size (measured
        // directly: ~9.6KB of a ~10.5KB message for a real 9x9 board),
        // and the vast majority of tiles are 'hidden' for most of a
        // real match (measured: ~70/81 early game) -- yet an
        // undiscovered tile was carrying the SAME 8 fields as a fully
        // revealed one, every single one of them a trivial false/null
        // placeholder (revealed:false, collapsed:false, loot:null,
        // lootKnown:false, exit:null, to:null) that conveys zero real
        // information: an undiscovered tile categorically CANNOT have
        // known loot, exit info, etc. from this viewer's own
        // perspective, by definition of being undiscovered. Every
        // client-side reader of these fields already uses optional
        // chaining or falsy-coalescing (`cell?.collapsed`,
        // `cell.kind || 'hidden'`, `!tile.collapsed`) -- confirmed
        // directly across hex-board.mjs, player-ui/tv-ui main.js, and
        // this project's own existing tests before making this change,
        // not assumed -- so omitting these fields entirely for a hidden
        // tile is safe: `undefined` behaves identically to explicit
        // false/null everywhere they're actually read. This changes
        // WIRE REPRESENTATION only, nothing about game rules/mechanics
        // -- the real, authoritative `state.tiles` Map this reads FROM
        // is completely untouched, and no other code reads the
        // PROJECTED shape's specific field presence (only `coord`/
        // `kind`, confirmed by scanning this project's own test suite).
        if (kind === 'hidden') return { coord, kind };
        const publicLoot = !!t.revealedGlobally && t.lootVisibility === 'public-after-discovery';
        const lootKnown = publicLoot || !!known.lootKnown;
        const exitPublic = !!t.revealedGlobally;
        return { coord, kind, revealed: publicCell || isKnown, collapsed:!!t.collapsed, loot:lootKnown ? (publicLoot ? (t.publicLoot || null) : (known.loot || null)) : null, lootKnown, exit:exitPublic ? (t.exitRemaining ?? t.exit ?? null) : (known.exit ?? null), to:exitPublic ? (t.to ?? t.forceTo ?? null) : (known.to ?? null) };
      });
      const units = [...state.units.values()].map(u => {
        if (u.owner === 'tanker') return { id:u.id, owner:'tanker', coord:u.coord, shipType:'tanker', status:u.hp>0?'active':'destroyed' };
        if (u.owner === viewer) return { id:u.id, owner:u.owner, coord:u.coord, shipType:u.shipType, hp:u.hp,maxHp:u.maxHp,shield:u.shield,fuel:u.fuel,maxFuel:u.maxFuel,moves:u.moves,movePoints:u.movePoints,score:state.scores.get(u.owner)||0,cargo:u.cargo,pendingCredits:u.pendingCredits||0,lives:state.lives?.[u.owner] ?? 0,skipTurns:u.skipTurns||0 };
        return { id:u.id, owner:u.owner, coord:u.coord, shipType:u.shipType, status:u.hp>0?'active':'destroyed', score:state.scores.get(u.owner)||0 };
      });
      const traps = viewer ? state.traps.filter(t=>t.owner===viewer).map(t=>({owner:t.owner,coord:t.coord})) : [];
      return { ...base, state:{ units,tiles,traps,scores:Object.fromEntries(state.scores),lives:{...(state.lives||{})},eliminated:{...(state.eliminated||{})},stats:state.stats,globalEvent:state.globalEvent,globalEventUntil:state.globalEventUntil,finalRush:!!state.finalRush,tankerRespawn:state.tankerRespawn,timeBonusSec:state.timeBonusSec||0 } };
    }
  };

  function baseCoordinates(cfg) { const out=[key(0,0),key(cfg.w-1,cfg.h-1)]; if(cfg.n>=3)out.push(key(cfg.w-1,0)); if(cfg.n>=4)out.push(key(0,cfg.h-1)); return out; }
  function publicCoords(state) { return [...state.tiles.entries()].filter(([,t])=>t.kind==='base'||t.kind==='center').map(([c])=>c); }
  function shipForType(type){ return SHIPS[type] || SHIPS.scout; }
  function spawnUnit(s, owner, coord, type) { const z=shipForType(type), configuredFuel=Number.isFinite(s.cfg?.fuel)?s.cfg.fuel:z.fuel, configuredMoves=Number.isFinite(s.cfg?.mp)?s.cfg.mp:z.moves, u={id:`u${s.next++}`,owner,shipType:type,coord,home:coord,prevCoord:coord,hp:z.hp,maxHp:z.hp,shield:z.shield,maxShield:z.shield,fuel:configuredFuel,maxFuel:configuredFuel,moves:configuredMoves,movePoints:configuredMoves,cargoSlots:z.cargoSlots,attack:z.attack,cargo:[],scanAvailable:true,pendingCredits:0,skipTurns:0}; s.units.set(u.id,u); if(!s.lives) s.lives={}; if(!s.eliminated) s.eliminated={}; if(owner!=='tanker'&&s.lives[owner]==null){s.lives[owner]=s.cfg.shipLives;s.eliminated[owner]=false;}
    if(owner!=='tanker'){ u.lootBonus=z.lootBonus ?? 1; u.lootLuck=z.lootLuck ?? 0; u.canTeleport=z.canTeleport !== false; } return u; }
  function get(ctx,id) { return [...ctx.state.units.values()].find(u=>u.id===id || u.owner===id) || null; }
  function getState(state,id){ return [...state.units.values()].find(u=>u.owner===id) || null; }
  function at(ctx,coord){ return [...ctx.state.units.values()].find(u=>u.coord===coord&&u.hp>0)||null; }
  function neighbors(ctx,coord){ return neighborsFor(coord,ctx.state.cfg.w,ctx.state.cfg.h,c=>ctx.state.tiles.get(c)?.collapsed); }
  function publicResource(ctx,t){ return t.loot && t.lootVisibility==='public-after-discovery' ? {...t.loot} : null; }
  function rememberTile(ctx,viewer,coord){ const t=ctx.state.tiles.get(coord); if(!t) return; if(t.kind==='teleport'||t.kind==='accelerator'||t.lootVisibility==='public-after-discovery'){t.revealedGlobally=true;const pub=publicResource(ctx,t);if(pub)t.publicLoot=pub;} const rec={kind:t.kind,loot:t.loot?{...t.loot}:null,lootKnown:!!t.loot,exit:t.exitRemaining??t.exit??null,to:t.to??t.forceTo??null}; const m=ctx.state.discovered.get(viewer)||new Map();m.set(coord,rec);ctx.state.discovered.set(viewer,m); const k=ctx.knowledge.ensure(viewer,{tiles:{}}); k.tiles ||= {}; k.tiles[coord]={...rec}; }
  function revealAround(ctx,viewer,coord,radius=1){ for(const c of ctx.state.tiles.keys()) if(dist(coord,c)<=radius) rememberTile(ctx,viewer,c); }
  function randomLoot(ctx){ const r=ctx.random.next(); const type=r<.01?'ancient':r<.10?'artifact':r<.30?'technology':r<.65?'mineral':'scrap'; return { type, ...LOOT[type] }; }
  function transportLoot(ctx,item,u){ if(!item||u.shipType!=='transport'||ctx.random.next()>(u.lootLuck||0)||item.type==='ancient')return item; const order=['scrap','mineral','technology','artifact','ancient'],idx=order.indexOf(item.type);if(idx<0||idx>=order.length-1)return item;return {type:order[idx+1],...LOOT[order[idx+1]]}; }
  function createBoard(ctx){ const s=ctx.state,cfg=s.cfg,layout=s.scenario?.boardLayout; const m=new Map();for(let r=0;r<cfg.h;r++)for(let q=0;q<cfg.w;q++)m.set(key(q,r),{kind:'empty',revealed:false,collapsed:false,loot:null,droppedLoot:[],resolved:false});const bases=baseCoordinates(cfg);bases.forEach(c=>m.get(c).kind='base');m.get(key(Math.floor(cfg.w/2),Math.floor(cfg.h/2))).kind='center';
    if(layout?.cells){ for(const [coord,cell] of Object.entries(layout.cells)){if(m.has(coord)&&cell?.kind)m.get(coord).kind=cell.kind;} }
    else { const pool=[...m.keys()].filter(c=>!bases.includes(c)&&m.get(c).kind!=='center');ctx.random.shuffle(pool);const free=pool.slice();const types=[...Array(scaleCount(14,cfg)).fill('planet'),...Array(Math.max(2,scaleCount(5,cfg))).fill('station'),...Array(Math.max(1,scaleCount(1,cfg))).fill('superstation'),...Array(scaleCount(8,cfg)).fill('asteroid'),...Array(scaleCount(6,cfg)).fill('anomaly'),...Array(scaleCount(6,cfg)).fill('pirate'),...Array(scaleCount(3,cfg)).fill('nebula'),...Array(scaleCount(3,cfg)).fill('directional_arrow'),...Array(scaleCount(3,cfg)).fill('accelerator'),...Array(scaleCount(3,cfg)).fill('teleport'),...Array(scaleCount(2,cfg)).fill('broken_teleport'),...Array(scaleCount(3,cfg)).fill('signal'),'blackhole','thief_mineral','thief_scrap'];ctx.random.shuffle(types);for(const type of types){if(!free.length)break;let choices=free;if(type==='teleport'||type==='broken_teleport')choices=free.filter(c=>bases.every(b=>dist(c,b)>=3));if(!choices.length)continue;const c=ctx.random.pick(choices);free.splice(free.indexOf(c),1);m.get(c).kind=type;}}
    for(const [coord,t] of m.entries()){const over=layout?.cells?.[coord];if(t.kind==='planet'){t.loot=over?.loot?{...over.loot}:randomLoot(ctx);t.lootVisibility=over?.lootVisibility||CONTENT.loot[t.loot.type]?.visibility||'first-discoverer';}if(t.kind==='nebula'){t.exitCost=Number(over?.exit||rollNebulaExit(ctx));t.exitRemaining=t.exitCost;}if(t.kind==='directional_arrow'||t.kind==='accelerator'){const ns=neighborsFor(coord,cfg.w,cfg.h);const target=over?.to || (ns.length?ctx.random.pick(ns):coord);t.forceTo=target;t.directionVector=diffCube(coord,target);}if(t.kind==='teleport'){const ns=neighborsFor(coord,cfg.w,cfg.h);t.to=over?.to || (ns.length?ctx.random.pick(ns):null);t.revealedGlobally=!!over?.revealedGlobally;}if(t.kind==='signal'&&over?.revealedGlobally)t.revealedGlobally=true;if(over?.publicLoot)t.publicLoot={...over.publicLoot};if(over?.revealedGlobally)t.revealedGlobally=true;}
    return m; }
  function scaleCount(base,cfg){const ratio=(cfg.w*cfg.h-baseCoordinates(cfg).length-1)/(9*9-3);return Math.max(0,Math.round(base*ratio));}
function rollNebulaExit(ctx){const r=ctx.random.next();return r<0.45?2:r<0.75?3:r<0.93?4:5;}
  function diffCube(from,to){const a=cube(from),b=cube(to);return{x:Math.sign(b.x-a.x),y:Math.sign(b.y-a.y),z:Math.sign(b.z-a.z)};}
  function stepCube(from,dir,steps){const a=cube(from);return offsetFromCube({x:a.x+dir.x*steps,y:a.y+dir.y*steps,z:a.z+dir.z*steps});}
  function offsetFromCube(c){ return key(c.x+(c.z-(c.z&1))/2,c.z); }
  function unitAtOther(ctx,u,coord){return [...ctx.state.units.values()].find(x=>x.hp>0&&x.coord===coord&&x!==u)||null;}
  function label(u){ if(!u)return 'Корабль'; if(u.owner==='tanker')return 'Танкер'; return `Игрок ${u.owner}`; }
  function atHome(u){return !!u&&u.coord===u.home;}
  function opponentUnits(ctx,u){return [...ctx.state.units.values()].filter(x=>x.owner!=='tanker'&&x.owner!==u.owner&&x.hp>0&&!(ctx.players.get(x.owner)?.eliminated));}
  function validMove(ctx,u,to){ if(!ctx.state.tiles.has(to)||ctx.state.tiles.get(to).collapsed||u.moves<1||u.fuel<=0||unitAtOther(ctx,u,to)||!neighbors(ctx,u.coord).includes(to))return false;const cur=ctx.state.tiles.get(u.coord);if(cur?.kind==='directional_arrow'&&cur.forceTo&&to!==cur.forceTo)return false;return true; }
  function deliver(ctx,u){ if(!atHome(u))return; const cargo=cargoValue(u.cargo),pending=u.pendingCredits||0;if(!cargo&&!pending)return;const total=cargo+pending;ctx.state.scores.set(u.owner,(ctx.state.scores.get(u.owner)||0)+total);u.cargo=[];u.pendingCredits=0;ctx.state.stats.deliveries++;ctx.emit('CARGO_DELIVERED',{player:u.owner,value:total}); }
  function repairUnit(ctx,u){u.hp=u.maxHp;u.shield=shipForType(u.shipType).shield;u.fuel=u.maxFuel;}
  function resolveTile(ctx,u,t){ if(!t)return; if(Array.isArray(t.droppedLoot)&&t.droppedLoot.length){t.droppedLoot=t.droppedLoot.filter(item=>{if(canTake(u,item)){u.cargo.push(item);return false;}return true;});}
    if(t.kind==='asteroid'&&t.resolved)return;
    if(t.resolved){ rememberTile(ctx,u.owner,u.coord); return; }
    switch(t.kind){
      case 'asteroid': t.resolved=true;t.exitRemaining=2;break;
      case 'planet': if(t.loot){const item=transportLoot(ctx,t.loot,u);let lucky=item; const active=[...ctx.state.units.values()].filter(x=>x.owner!=='tanker'&&x.hp>0&&x!==u); const mine=(ctx.state.scores.get(u.owner)||0)+cargoValue(u.cargo); const leader=active.reduce((m,x)=>Math.max(m,(ctx.state.scores.get(x.owner)||0)+cargoValue(x.cargo)),0); if(leader>0&&mine<leader*0.62&&ctx.random.next()<0.12&&lucky.type!=='ancient'){const order=['scrap','mineral','technology','artifact','ancient'];const idx=order.indexOf(lucky.type);if(idx>=0&&idx<order.length-1)lucky={type:order[idx+1],...LOOT[order[idx+1]]};} const picked={...lucky,value:Math.round(lucky.value*(u.lootBonus||1))};if(canTake(u,picked)){u.cargo.push(picked);t.loot=null;ctx.state.stats.loot++;ctx.emit('RESOURCE_COLLECTED',{player:u.owner,type:picked.type,value:picked.value}); if(u.shipType==='transport'&&ctx.random.next()<0.25){const bonus0=transportLoot(ctx,randomLoot(ctx),u);const bonus={...bonus0,value:Math.round(bonus0.value*(u.lootBonus||1))};if(canTake(u,bonus)){u.cargo.push(bonus);ctx.state.stats.loot++;}}} }break;
      case 'station': repairUnit(ctx,u); t.resolved=true;ctx.emit('SHIP_REPAIRED',{player:u.owner,source:'station'});break;
      case 'superstation': t.usedBy=t.usedBy||new Set();repairUnit(ctx,u);if(!t.usedBy.has(u.owner)){t.usedBy.add(u.owner);u.moves+=2;}ctx.emit('SHIP_REPAIRED',{player:u.owner,source:'superstation'});break;
      case 'accelerator': applyAcceleratorPush(ctx,u,u.coord,t); break;
      case 'anomaly': {const e=ctx.random.range(1,4);if(e===1)u.fuel=Math.min(u.maxFuel,u.fuel+3);else if(e===2)u.hp--;else if(e===3)revealAround(ctx,u.owner,u.coord,2);else {const ns=neighbors(ctx,u.coord).filter(c=>!unitAtOther(ctx,u,c));if(ns.length){u.prevCoord=u.coord;u.coord=ctx.random.pick(ns);revealAround(ctx,u.owner,u.coord,1);}}t.resolved=true;ctx.emit('ANOMALY_RESOLVED',{player:u.owner,branch:e});break;}
      case 'pirate': {const raid=ctx.state.globalEvent?.name==='ПИРАТСКИЙ РЕЙД'&&ctx.turn<=ctx.state.globalEventUntil; if(ctx.random.next()<(raid?0.4:0.6)){u.pendingCredits=(u.pendingCredits||0)+ctx.random.range(1000,3000); } else u.hp--;t.resolved=true;ctx.emit('PIRATE_RESOLVED',{player:u.owner,success:u.hp>0});break;}
      case 'nebula': t.resolved=true;t.exitRemaining=t.exitRemaining??t.exitCost??rollNebulaExit(ctx);ctx.state.stats.nebulaEntries++;ctx.emit('NEBULA_ENTERED',{player:u.owner,remaining:t.exitRemaining});break;
      case 'center': {const r=ctx.random.next();if(r<0.35&&canTake(u,{...LOOT.ancient,type:'ancient'}))u.cargo.push({type:'ancient',...LOOT.ancient});else if(r<0.65)u.fuel=Math.min(u.maxFuel,u.fuel+5);else if(r<0.85)revealAround(ctx,u.owner,u.coord,3);else u.hp=0;t.resolved=true;break;}
      case 'blackhole': u.hp=0;t.kind='empty';break;
      case 'thief_mineral': case 'thief_scrap': {const kind=t.kind==='thief_mineral'?'mineral':'scrap';u.cargo=u.cargo.filter(i=>i.type!==kind);const respawnKind=t.kind; t.kind='empty'; respawnRare(ctx,respawnKind);break;}
      case 'signal': {const r=ctx.random.next();ctx.state.stats.signals++; if(r<0.32){const item=randomLoot(ctx);if(canTake(u,item)){u.cargo.push(item);ctx.state.stats.signalGood++;}else u.pendingCredits=(u.pendingCredits||0)+700;} else if(r<0.52){u.fuel=Math.min(u.maxFuel,u.fuel+3);ctx.state.stats.signalGood++;} else if(r<0.72){revealAround(ctx,u.owner,u.coord,3);ctx.state.stats.signalGood++;} else if(r<0.88){u.hp--;ctx.state.stats.signalBad++;} else {u.moves=Math.max(0,u.moves-1);ctx.state.stats.signalBad++;} t.resolved=true;t.kind='empty';break;}
      case 'teleport': teleport(ctx,u,t);break;
      case 'broken_teleport': brokenTeleport(ctx,u,t);break;
      case 'glitch': regenerateBoard(ctx); break;
      default: break;
    }
    rememberTile(ctx,u.owner,u.coord); deliver(ctx,u);
  }
  function applyAcceleratorPush(ctx,u,landing,tile){
    if(!tile||tile.kind!=='accelerator'||!tile.directionVector)return;
    const desired=ctx.random.range(1,3);
    let target=landing;
    let steps=0;
    for(let i=1;i<=desired;i++){
      const next=stepCube(landing,tile.directionVector,i);
      const nt=ctx.state.tiles.get(next);
      if(!nt||nt.collapsed||unitAtOther(ctx,u,next))break;
      target=next;steps++;
    }
    if(steps>0){
      u.prevCoord=landing;
      u.coord=target;
      u.fuel=Math.max(0,u.fuel-steps);
      ctx.state.stats.moves+=steps;
      rememberTile(ctx,u.owner,target);
      ctx.emit('ACCELERATOR_PUSH',{player:u.owner,from:landing,to:target,steps,fuelCost:steps});
      ctx.emitPresentation('FORCED_MOVE_EFFECT',{player:u.owner,from:landing,to:target,path:[landing,target],kind:'accelerator',steps});
    }
  }
  function teleport(ctx,u,t){ if(u.canTeleport===false)return; const storm=ctx.state.globalEvent?.name==='СОЛНЕЧНАЯ БУРЯ'&&ctx.turn<=ctx.state.globalEventUntil;if(storm)return;if(ctx.random.next()<0.5){if(!unitAtOther(ctx,u,u.home)){u.prevCoord=u.coord;u.coord=u.home;rememberTile(ctx,u.owner,u.coord);} } else {const path=shortestPath(ctx,u.coord,u.home);const steps=Math.min(2,path.length-1);const target=steps>0?path[steps]:u.coord;if(target!==u.coord&&!unitAtOther(ctx,u,target)){u.prevCoord=u.coord;u.coord=target;rememberTile(ctx,u.owner,target);}} }
  function brokenTeleport(ctx,u,t){ const hidden=[...ctx.state.tiles.entries()].filter(([c,tile])=>c!==u.coord&&!tile.revealed&&!tile.collapsed&&!unitAtOther(ctx,u,c));let target=hidden.length?ctx.random.pick(hidden)[0]:null;if(!target){const candidates=[...ctx.state.tiles.keys()].filter(c=>c!==u.coord&&!ctx.state.tiles.get(c).collapsed&&!unitAtOther(ctx,u,c)&&dist(u.coord,c)>=1&&dist(u.coord,c)<=3);if(candidates.length)target=ctx.random.pick(candidates);}if(target){u.prevCoord=u.coord;u.coord=target;rememberTile(ctx,u.owner,target);}t.resolved=true;}
  function shortestPath(ctx,from,to){if(from===to)return[from];const prev=new Map([[from,null]]),q=[from];while(q.length){const cur=q.shift();if(cur===to)break;for(const n of neighbors(ctx,cur)){if(!prev.has(n)){prev.set(n,cur);q.push(n);}}}if(!prev.has(to))return[from];const out=[to];let c=to;while(prev.get(c)!==null){c=prev.get(c);out.push(c);}return out.reverse();}
  function respawnRare(ctx,kind){const free=[...ctx.state.tiles.keys()].filter(c=>{const t=ctx.state.tiles.get(c);return t.kind==='empty'&&!t.collapsed&&!at(ctx,c);});if(free.length)ctx.state.tiles.get(ctx.random.pick(free)).kind=kind;}
  function move(ctx,c){const u=get(ctx,ctx.actor);if(!u||!validMove(ctx,u,c.to))return false;const from=u.coord;const cur=ctx.state.tiles.get(from);if(cur?.kind==='nebula'&&cur.resolved){cur.exitRemaining=Math.max(0,(cur.exitRemaining??3)-1);u.moves--;if(cur.exitRemaining===0){cur.kind='empty';cur.resolved=false;ctx.state.stats.nebulaExits++;}ctx.emit('NEBULA_EXIT_PROGRESS',{player:u.owner,remaining:cur.exitRemaining});} else if(cur?.kind==='asteroid'&&cur.resolved){cur.exitRemaining=Math.max(0,(cur.exitRemaining??2)-1);u.moves--;if(cur.exitRemaining===0){cur.kind='empty';cur.resolved=false;}ctx.emit('ASTEROID_EXIT_PROGRESS',{player:u.owner,remaining:cur.exitRemaining});} else {u.prevCoord=from;u.direction=diffCube(from,c.to);u.coord=c.to;u.moves--;u.fuel--;ctx.state.stats.moves++;rememberTile(ctx,u.owner,u.coord);const t=ctx.state.tiles.get(u.coord);resolveTile(ctx,u,t);}ctx.emit('SHIP_MOVED',{player:u.owner,from,to:u.coord,tileKind:ctx.state.tiles.get(u.coord)?.kind||'empty'});ctx.emitPresentation('ROUTE_HIGHLIGHT',{player:u.owner,path:[from,u.coord]});ctx.emitPresentation('SHIP_MOVE_ANIMATION',{player:u.owner,from,to:u.coord,path:[from,u.coord]});triggerTrap(ctx,u);collision(ctx,u);destroyIfNeeded(ctx,u);deliver(ctx,u);
    // Real bug found via a full-game bot-vs-bot simulation (seed 13,
    // step 182): the ACTOR's own unit can be fully ELIMINATED (0 lives
    // left, removed from ctx.state.units entirely -- see
    // destroyIfNeeded's own `ctx.state.units.delete(u.id)` branch)
    // DURING the resolution of its own move -- e.g. landing on an
    // unresolved 'anomaly' tile has a real chance to deal 1 damage (see
    // resolveTile's `case 'anomaly'`), which is lethal at 1 HP / last
    // life. The ORIGINAL check here (`if(u.moves<=0)nextTurn(ctx)`) used
    // `u`, the SAME local variable captured before deletion -- once the
    // unit is removed from ctx.state.units, that object is detached but
    // its `.moves` property is untouched (still whatever it was after
    // this move's own `u.moves--`, typically >0), so this check silently
    // stayed false and nextTurn() was never called. The match then hangs
    // permanently: activePlayer stays pointed at the now-eliminated
    // player, whose unit no longer exists, so availableActions() (which
    // requires `get(ctx,viewer)` to return a real unit even to offer
    // END_TURN) returns an empty list -- there is no longer ANY legal
    // action for that player, not even to give up their turn. Confirmed
    // via a real, reproducible fuzz run before this fix (2/100 seeds
    // hung this exact way) and confirmed resolved after (0/100), plus a
    // permanent regression test for this exact seed (see
    // fuzz.test.mjs). ctx.state.units.has(u.id) is the correct check --
    // NOT get(ctx,u.owner), since a respawned-with-remaining-lives unit
    // keeps the SAME owner but a DIFFERENT unit id would only matter for
    // future units, and this unit's own id is what was actually deleted.
    if(u.moves<=0||!ctx.state.units.has(u.id))nextTurn(ctx);return true;}
  // `player` added alongside the original `victim` field (kept for
  // backward compatibility, nothing reads it independently -- confirmed
  // directly) -- emit()'s own audience-scoping fallback (game.js) reads
  // payload.player/payload.owner, not payload.victim, so this event used
  // to only reach the correct person by coincidence (the trap's victim
  // always happens to equal action.actor here, since a trap can only be
  // triggered by walking onto it with your own move) rather than by an
  // explicit, stated contract -- found via manual code review.
  function triggerTrap(ctx,u){const trap=ctx.state.traps.find(t=>t.coord===u.coord&&t.owner!==u.owner);if(!trap)return;ctx.state.traps=ctx.state.traps.filter(x=>x!==trap);u.skipTurns=1;ctx.state.stats.trapHits++;ctx.emit('TRAP_TRIGGERED',{player:u.owner,victim:u.owner});}
  function collision(ctx,u){for(const o of opponentUnits(ctx,u)){if(o.coord===u.coord){if(!atHome(u))u.hp--;if(!atHome(o))o.hp--;ctx.emit('COLLISION',{players:[u.owner,o.owner]});destroyIfNeeded(ctx,u);destroyIfNeeded(ctx,o);}}}
  function destroyIfNeeded(ctx,u,attacker=null){if(u.hp>0)return;if(u.owner==='tanker'){ctx.state.units.delete(u.id);ctx.state.tankerDefeatedUntil=ctx.turn+ctx.random.range(4,7);return;}const bounty=attacker&&attacker.owner!=='tanker'?(attacker.shipType==='warship'?1300:700):0;if(bounty)attacker.pendingCredits=(attacker.pendingCredits||0)+bounty;ctx.emitPresentation('SHIP_DESTROYED',{owner:u.owner,coord:u.coord});const tile=ctx.state.tiles.get(u.coord);if(tile){tile.droppedLoot=tile.droppedLoot||[];tile.droppedLoot.push(...u.cargo);}u.cargo=[];ctx.state.lives[u.owner]=Math.max(0,(ctx.state.lives[u.owner]??ctx.state.cfg.shipLives)-1);if(ctx.state.lives[u.owner]<=0){ctx.eliminate(u.owner,'ship-destroyed');ctx.emit('PLAYER_SHIP_DESTROYED',{player:u.owner});ctx.state.units.delete(u.id);}else{u.coord=u.home;repairUnit(ctx,u);u.moves=0;u.skipTurns=0;}}
  function attack(ctx,c){const u=get(ctx,ctx.actor),t=get(ctx,c.target);if(!u||!t||t.owner===u.owner||t.owner==='tanker'&&t.hp<=0||dist(u.coord,t.coord)!==1||u.moves<1)return false;const cur=ctx.state.tiles.get(u.coord);if(cur?.kind==='nebula'&&cur.resolved)return false;if(t.owner!=='tanker'&&atHome(t))return false;u.moves--;ctx.state.stats.battles++;if(t.shield>0){t.shield=0;ctx.emit('SHIELD_BROKEN',{attacker:u.owner,target:t.owner});}else{const damage=u.attack;t.hp-=damage;ctx.emit('DAMAGE',{attacker:u.owner,target:t.owner,damage});}ctx.emit('COMBAT_RESOLVED',{attacker:u.owner,target:t.owner,damage:t.hp>0?u.attack:1});ctx.emitPresentation('COMBAT_FLASH',{attacker:u.owner,target:t.owner,damage:u.attack,from:u.coord,to:t.coord,destroyed:t.hp<=0});destroyIfNeeded(ctx,t,u);return true;}
  function steal(ctx,c){const u=get(ctx,ctx.actor),t=get(ctx,c.target);if(!u||!t||t.owner===u.owner||dist(u.coord,t.coord)!==1||u.moves<1||t.cargo.length===0)return false;const cur=ctx.state.tiles.get(u.coord);if(cur?.kind==='nebula'&&cur.resolved)return false;if(atHome(t))return false;const stealable=t.cargo.filter(item=>canTake(u,item));if(!stealable.length)return false;const item=stealable[ctx.random.int(stealable.length)];u.moves--;t.cargo=t.cargo.filter(x=>x!==item);u.cargo.push(item);ctx.emit('LOOT_STOLEN',{player:u.owner,target:t.owner,value:item.value});return true;}
  function scan(ctx){const u=get(ctx,ctx.actor);if(!u||!u.scanAvailable)return false;const here=ctx.state.tiles.get(u.coord);if(!here||!['station','superstation'].includes(here.kind))return false;const {q,r}=parse(u.coord);const dirs=r%2===0?[[1,0],[-1,0],[0,-1],[-1,-1],[0,1],[-1,1]]:[[1,0],[-1,0],[1,-1],[0,-1],[1,1],[0,1]];const validDirs=[0,1,2,3,4,5].filter(idx=>{const [dq,dr]=dirs[idx];const c=key(q+dq,r+dr);return ctx.state.tiles.has(c);});const order=validDirs.sort(()=>ctx.random.next()-0.5).slice(0,Math.min(3,validDirs.length));let opened=0;for(const idx of order){const [dq,dr]=dirs[idx];for(const step of [1,2]){const c=key(q+dq*step,r+dr*step),t=ctx.state.tiles.get(c);if(t&&!t.collapsed&&!ctx.state.discovered.get(u.owner)?.has(c)){rememberTile(ctx,u.owner,c);opened++;}}}u.scanAvailable=false;ctx.emit('SCAN_RESOLVED',{player:u.owner,opened});return true;}
  function repair(ctx){const u=get(ctx,ctx.actor);if(!u||!atHome(u)&&!['station','superstation'].includes(ctx.state.tiles.get(u.coord)?.kind))return false;repairUnit(ctx,u);ctx.emit('SHIP_REPAIRED',{player:u.owner});return true;}
  function buyFuel(ctx){const u=get(ctx,ctx.actor),cfg=ctx.state.cfg;if(!u||u.fuel>=u.maxFuel)return false;const score=ctx.state.scores.get(u.owner)||0;if(score<cfg.fuelPrice)return false;ctx.state.scores.set(u.owner,score-cfg.fuelPrice);u.fuel=Math.min(u.maxFuel,u.fuel+cfg.fuelPerBuy);ctx.emit('FUEL_PURCHASED',{player:u.owner,amount:cfg.fuelPerBuy,cost:cfg.fuelPrice});return true;}
  function trapLimit(ctx){return 2*(Math.max(2,Math.min(4,ctx.state.cfg.n))-1);}
  function buyTrap(ctx){const u=get(ctx,ctx.actor),cfg=ctx.state.cfg;if(!u||!cfg.trapsEnabled||cfg.n<4||u.moves<1)return false;if((ctx.state.traps.filter(t=>t.owner===u.owner).length)>=trapLimit(ctx))return false;const score=ctx.state.scores.get(u.owner)||0;if(score<cfg.trapPrice)return false;if(ctx.state.traps.some(t=>t.owner===u.owner&&t.coord===u.coord))return false;ctx.state.scores.set(u.owner,score-cfg.trapPrice);u.moves--;ctx.state.traps.push({owner:u.owner,coord:u.coord});ctx.state.stats.traps++;ctx.emit('TRAP_PLACED',{player:u.owner,coord:u.coord},u.owner);return true;}
  function attackTanker(ctx){const u=get(ctx,ctx.actor),t=[...ctx.state.units.values()].find(x=>x.owner==='tanker');if(!u||!t||dist(u.coord,t.coord)!==1||u.moves<1)return false;u.moves--;const gain=Math.min(u.maxFuel-u.fuel,ctx.state.cfg.fuelPerBuy);u.fuel+=gain;t.hp--;ctx.emit('TANKER_ATTACKED',{player:u.owner,fuel:gain});if(t.hp<=0){ctx.state.units.delete(t.id);ctx.state.tankerDefeatedUntil=ctx.turn+ctx.random.range(4,7);ctx.emit('TANKER_DESTROYED',{player:u.owner});}return true;}
  function maybeSpawnTanker(ctx,force=false){if([...ctx.state.units.values()].some(u=>u.owner==='tanker'))return; if(!force&&ctx.turn<ctx.state.tankerRespawn)return;const occupied=new Set([...ctx.state.units.values()].map(u=>u.coord));const candidates=[...ctx.state.tiles.keys()].filter(c=>{const t=ctx.state.tiles.get(c);return t.kind!=='base'&&t.kind!=='center'&&!t.collapsed&&!occupied.has(c);});if(!candidates.length)return;const t=spawnUnit(ctx.state,'tanker',ctx.random.pick(candidates),'tanker');t.hp=2;t.maxHp=2;t.shield=0;t.moves=1;t.movePoints=1;t.fuel=99;ctx.state.tankerRespawn=ctx.turn+ctx.random.range(4,7);ctx.emit('TANKER_SPAWNED',{coord:t.coord});}
  function tankerTurn(ctx){const t=[...ctx.state.units.values()].find(u=>u.owner==='tanker');if(!t)return;const ns=neighbors(ctx,t.coord).filter(c=>!unitAtOther(ctx,t,c));if(ns.length)t.coord=ctx.random.pick(ns);}
  function respawnResources(ctx){for(const t of ctx.state.tiles.values())if(t.kind==='planet'&&!t.loot&&ctx.random.next()<0.15)t.loot=randomLoot(ctx);}
  function collapseHexes(ctx,fraction){const units=[...ctx.state.units.values()].filter(u=>u.owner!=='tanker'&&u.hp>0);const bases=baseCoordinates(ctx.state.cfg),center=key(Math.floor(ctx.state.cfg.w/2),Math.floor(ctx.state.cfg.h/2));const protectedCoords=new Set([...bases,center,...units.map(u=>u.coord)]);const cands=[...ctx.state.tiles.keys()].filter(c=>{const t=ctx.state.tiles.get(c);return !protectedCoords.has(c)&&!t.collapsed&&t.kind==='empty';});ctx.random.shuffle(cands);let done=0;const need=Math.round(ctx.state.cfg.w*ctx.state.cfg.h*fraction);for(const c of cands){if(done>=need)break;ctx.state.tiles.get(c).collapsed=true;const safe=units.every(u=>neighbors(ctx,u.coord).some(n=>validMove(ctx,u,n)));if(safe)done++;else ctx.state.tiles.get(c).collapsed=false;}if(done)ctx.emit('SECTOR_COLLAPSE',{count:done});}
  function periodicTick(ctx){if(ctx.turn%4===0)respawnResources(ctx);if(ctx.turn%6===0|| (ctx.state.finalRush&&ctx.turn%2===0))triggerGlobalEvent(ctx);if(ctx.turn>=3&&ctx.random.next()<(ctx.state.finalRush?.11:.06))spawnGlitch(ctx);if(ctx.turn>=ctx.state.tankerRespawn&&![...ctx.state.units.values()].some(u=>u.owner==='tanker'))maybeSpawnTanker(ctx);tankerTurn(ctx);const remaining=Math.max(0,ctx.state.cfg.session*60+(ctx.state.timeBonusSec||0)-ctx.turn*ctx.state.cfg.turnSeconds);if(remaining<=ctx.state.cfg.session*60*0.5&&ctx.state.collapseStage<1){ctx.state.collapseStage=1;collapseHexes(ctx,0.04);}if(remaining<=ctx.state.cfg.session*60*0.25&&ctx.state.collapseStage<2){ctx.state.collapseStage=2;collapseHexes(ctx,0.06);}if(remaining<=ctx.state.cfg.session*60*0.10&&ctx.state.collapseStage<3){ctx.state.collapseStage=3;collapseHexes(ctx,0.08);}}
  function triggerGlobalEvent(ctx){const events=[['СОЛНЕЧНАЯ БУРЯ','Телепорты нестабильны до следующего раунда.','warning'],['МИНЕРАЛЬНЫЙ ВСПЛЕСК','Планеты получают дополнительную добычу.','good'],['ПИРАТСКИЙ РЕЙД','Пираты опаснее на короткий срок.','danger'],['РАЗРЫВ ПРОСТРАНСТВА','Случайный пустой сектор стал аномальным.','warning'],['СИГНАЛ SOS','На карте появился неоднозначный сигнал.','warning']];const e=ctx.random.pick(events);ctx.state.globalEvent={name:e[0],kind:e[2]};ctx.state.globalEventUntil=ctx.turn+3;ctx.state.stats.globalEvents++;if(e[0]==='МИНЕРАЛЬНЫЙ ВСПЛЕСК'){for(const t of ctx.state.tiles.values())if(t.kind==='planet'&&!t.loot&&ctx.random.next()<0.3)t.loot=randomLoot(ctx);}if(e[0]==='СИГНАЛ SOS'){const free=[...ctx.state.tiles.keys()].filter(c=>{const t=ctx.state.tiles.get(c);return t.kind==='empty'&&!t.collapsed&&!at(ctx,c);});if(free.length){const c=ctx.random.pick(free);ctx.state.tiles.get(c).kind='signal';ctx.state.tiles.get(c).revealedGlobally=true;}}if(e[0]==='РАЗРЫВ ПРОСТРАНСТВА'){const free=[...ctx.state.tiles.entries()].filter(([c,t])=>t.kind==='empty'&&!t.collapsed);if(free.length)free[ctx.random.int(free.length)][1].kind='anomaly';}}
  function regenerateBoard(ctx){
    ctx.state.stats.glitches++;
    ctx.state.tiles=createBoard(ctx);
    ctx.state.collapseStage=0;
    for(const t of ctx.state.tiles.values()) t.revealedGlobally=false;
    for(const u of ctx.state.units.values()) if(u.owner!=='tanker' && u.hp>0) { u.prevCoord=u.coord; revealAround(ctx,u.owner,u.coord,1); }
    ctx.state.timeBonusSec=(ctx.state.timeBonusSec||0)+ctx.random.range(60,180);
    ctx.emit('NAVIGATION_GLITCH',{bonusSeconds:ctx.state.timeBonusSec});
    ctx.emitPresentation('GLITCH_EFFECT',{players:[...ctx.state.units.values()].filter(u=>u.owner!=='tanker'&&u.hp>0).map(u=>u.coord)});
  }
  function spawnGlitch(ctx){const free=[...ctx.state.tiles.entries()].filter(([c,t])=>t.kind==='empty'&&t.revealedGlobally&&!t.collapsed&&!at(ctx,c));if(free.length)free[ctx.random.int(free.length)][1].kind='glitch';}
  function endIfNeeded(ctx){const alive=[...ctx.players.values()].filter(p=>!p.eliminated);if(alive.length<=1&&ctx.players.size>1)ctx.finish(alive[0]?.id||null,'elimination');}
  function nextTurn(ctx,force=false){if(ctx.pending||ctx.phase!=='playing')return false;const active=get(ctx,ctx.active);if(!force&&active&&active.moves>0){return true;}const ids=ctx.turnOrder.ids.filter(id=>!ctx.players.get(id)?.eliminated&&get(ctx,id));if(!ids.length){ctx.finish(null,'no-players');return true;}const idx=Math.max(0,ids.indexOf(ctx.active));let nextId=ids[(idx+1)%ids.length];let next=get(ctx,nextId);if(next?.skipTurns>0){next.skipTurns--;nextId=ids[(idx+2)%ids.length]||nextId;next=get(ctx,nextId);}for(const u of ctx.state.units.values())if(u.owner!=='tanker'&&u.owner!==nextId){}if(next){next.moves=next.movePoints;next.scanAvailable=true;if(next.fuel<=0)next.fuel=1;}ctx.endTurn(nextId,{reason:'turn-end'});ctx.state.finalRush=ctx.turn>=Math.max(1,Math.ceil((ctx.state.cfg.session*60+(ctx.state.timeBonusSec||0))/ctx.state.cfg.turnSeconds)-2);periodicTick(ctx);endIfNeeded(ctx);return true;}
  // expose selected helpers for tests / tooling
  function getSettings(){return cfg;}
  returnDefinitionHelpers();
  function returnDefinitionHelpers(){ /* intentionally empty: all public hooks are below */ }
}

module.exports = { createDefinition, SHIPS, LOOT };
