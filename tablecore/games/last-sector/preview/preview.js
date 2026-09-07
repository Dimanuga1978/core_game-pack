import {previewMeta,createPreviewState} from './mock-state.js';
import {createVisualScene,renderScene} from './adapter.js';
const params=new URLSearchParams(location.search);const previewScenario=params.get('scenario')||'opening';const previewRole=params.get('role')||'both';
let state=createPreviewState();
if(previewScenario==='late-game'){state.turn=Math.max(state.turn||1,9);state.phase='Late game';state.values=state.values.map((v,i)=>({...v,value:i===0?Math.max(1,Math.ceil(Number(v.value)||0)):v.value}));}
if(previewScenario==='finale'){state.phase='Finale';state.turn=Math.max(state.turn||1,12);}
if(previewScenario==='action')state.phase='Action';
const $=s=>document.querySelector(s);
function render(){
 document.body.dataset.previewScenario=previewScenario;
 if(previewRole==='player')document.querySelector('.grid .card:first-child').style.display='none';
 if(previewRole==='tv')document.querySelector('.grid .card:nth-child(2)').style.display='none';
 document.title=`${previewMeta.name} — Interface Preview`;
 $('#title').textContent=previewMeta.name; $('#gid').textContent=previewMeta.gameId;
 $('#phase').textContent=state.phase; $('#turn').textContent=`Ход ${state.turn} · Игрок ${state.active}`;
 const stats=$('#stats'); stats.replaceChildren();
 for(const v of state.values||[]){const card=document.createElement('div');card.className='stat';const small=document.createElement('small');small.textContent=String(v.label);const b=document.createElement('b');b.textContent=String(v.value);card.append(small,b);stats.append(card);}
 const scene=createVisualScene(state); renderScene($('#real-tv'),scene,'tv'); renderScene($('#real-player'),scene,'player');
 const assets=$('#assets'); assets.replaceChildren(); const list=previewMeta.assets||[];
 if(list.length){for(const [i,src] of list.entries()){const card=document.createElement('div');card.className='asset';const img=document.createElement('img');img.src=String(src);img.alt=`asset ${i+1}`;img.addEventListener('error',()=>card.classList.add('missing'),{once:true});const span=document.createElement('span');span.textContent=`ASSET ${i+1}`;card.append(img,span);assets.append(card);}}
 else {const empty=document.createElement('div');empty.className='empty';empty.textContent='Для этого pack Preview использует его visual profile и реальный design context. Специализированный adapter может заменить эту сцену без изменения Preview shell.';assets.append(empty);}
 $('#scene').textContent=`Демонстрационная сцена #${state.seed}`;
 $('#caps').textContent=previewMeta.capabilities.length?previewMeta.capabilities.join(' · '):'game';
}
$('#randomize').onclick=()=>{state=createPreviewState();render()};render();
