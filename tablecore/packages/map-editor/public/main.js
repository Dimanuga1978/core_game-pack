import { createHexMapEditor, axialToPixel, hexesInRadius, hexKey, hexPolygonPoints } from '../src/index.js';

const catalog = {
  terrains: {
    plain: { label: 'Plain', fill: '#263238' },
    nebula: { label: 'Nebula', fill: '#25305a' },
    asteroid: { label: 'Asteroid', fill: '#3d3427' },
    dust: { label: 'Dust', fill: '#463427' }
  },
  objects: {
    station: { label: 'Station', glyph: 'S' },
    salvage: { label: 'Salvage', glyph: '◆' },
    hazard: { label: 'Hazard', glyph: '!' },
    beacon: { label: 'Beacon', glyph: 'B' }
  }
};
const radius = 2;
const cells = Object.fromEntries(hexesInRadius(radius).map(({q,r}) => [hexKey(q,r), {q,r,terrain:'plain',object:null}]));
const editor = createHexMapEditor({catalog: {terrains: catalog.terrains, objects: catalog.objects}, map: {id:'sector', radius, cells}});
let mode = { terrain: 'plain', object: null, eraseObject: false };
const svg = document.querySelector('#map');

function renderPalette() {
  document.querySelector('#terrainPalette').innerHTML = Object.entries(catalog.terrains).map(([id,v]) => `<button class="swatch ${mode.terrain===id?'selected':''}" data-terrain="${id}"><span style="background:${v.fill}"></span>${v.label}</button>`).join('');
  document.querySelector('#objectPalette').innerHTML = Object.entries(catalog.objects).map(([id,v]) => `<button class="object ${mode.object===id && !mode.eraseObject?'selected':''}" data-object="${id}">${v.glyph} ${v.label}</button>`).join('');
  document.querySelectorAll('[data-terrain]').forEach(b => b.onclick=()=>{mode={terrain:b.dataset.terrain,object:null,eraseObject:false};renderPalette()});
  document.querySelectorAll('[data-object]').forEach(b => b.onclick=()=>{mode={terrain:null,object:b.dataset.object,eraseObject:false};renderPalette()});
  document.querySelector('#eraseBtn').classList.toggle('selected', mode.eraseObject);
}
function renderMap() {
  svg.innerHTML = '';
  for (const cell of editor.listCells()) {
    const {x,y}=axialToPixel(cell.q,cell.r,42);
    const points=hexPolygonPoints(40).map(p=>`${p.x+x},${p.y+y}`).join(' ');
    const g=document.createElementNS('http://www.w3.org/2000/svg','g');
    g.dataset.q=cell.q; g.dataset.r=cell.r; g.classList.toggle('selected', editor.selected?.q===cell.q && editor.selected?.r===cell.r);
    const poly=document.createElementNS('http://www.w3.org/2000/svg','polygon');
    poly.setAttribute('points',points); poly.setAttribute('fill',catalog.terrains[cell.terrain]?.fill ?? '#20262a');
    const coord=document.createElementNS('http://www.w3.org/2000/svg','text'); coord.setAttribute('x',x-26); coord.setAttribute('y',y+28); coord.textContent=`${cell.q},${cell.r}`;
    g.append(poly,coord);
    if(cell.object){const t=document.createElementNS('http://www.w3.org/2000/svg','text');t.setAttribute('x',x);t.setAttribute('y',y+7);t.setAttribute('text-anchor','middle');t.classList.add('glyph');t.textContent=catalog.objects[cell.object]?.glyph ?? '?';g.append(t)}
    g.onclick=()=>{ editor.setBrush(mode); const selected=mode.eraseObject||mode.object ? editor.paint(cell.q,cell.r,mode) : editor.select(cell.q,cell.r); showSelected(selected,cell.q,cell.r); renderMap(); };
    g.oncontextmenu=(event)=>{event.preventDefault(); const selected=editor.select(cell.q,cell.r); showSelected(selected,cell.q,cell.r); renderMap();};
    svg.append(g);
  }
}
function showSelected(cell,q,r){document.querySelector('#selectedTitle').textContent=cell?`Hex ${q}, ${r}`:'Nothing selected';document.querySelector('#selectedData').innerHTML=cell?`<dt>Terrain</dt><dd>${cell.terrain}</dd><dt>Object</dt><dd>${cell.object ?? '—'}</dd>`:'';document.querySelector('#status').textContent=cell?JSON.stringify(cell,null,2):'Ready.'}
document.querySelector('#eraseBtn').onclick=()=>{mode={terrain:null,object:null,eraseObject:true};renderPalette()};
document.querySelector('#fillBtn').onclick=()=>{if(mode.terrain){editor.fillTerrain(mode.terrain);renderMap();document.querySelector('#status').textContent=`Filled map with ${mode.terrain}.`}else document.querySelector('#status').textContent='Select a terrain first.'};
document.querySelector('#exportBtn').onclick=()=>{const blob=new Blob([JSON.stringify(editor.snapshot(),null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`${editor.snapshot().id ?? 'map'}.json`;a.click();URL.revokeObjectURL(a.href)};
renderPalette(); renderMap();
