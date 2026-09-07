const API = '1.0.0';
const demoBundle = {
  manifest: { id: 'studio-demo', name: 'TableCore Authoring Demo', version: '1.0.0', authoringApiVersion: API },
  editor: { categories: ['terrains','objects','maps','rules'] },
  schemas: {
    terrains: { terrain: { fields: [{ id:'fuel_cost', type:'integer', min:0, max:9, default:1 }] } },
    objects: { object: { fields: [
      { id:'collectible', type:'boolean', default:false },
      { id:'value', type:'integer', min:0, max:99, default:1 },
      { id:'terrain', type:'ref', group:'terrains' }
    ] } },
    maps: { map: { fields: [{ id:'radius', type:'integer', min:1, max:20, default:2 }] } },
    rules: { rule: { fields: [{ id:'value', type:'number', required:true }] } }
  },
  content: {
    terrains: { plain: { type:'terrain', fields:{fuel_cost:1} }, nebula: { type:'terrain', fields:{fuel_cost:2} } },
    objects: { station: { type:'object', fields:{collectible:false,value:0,terrain:'plain'} }, salvage: { type:'object', fields:{collectible:true,value:5,terrain:'plain'} } },
    maps: { sector: { type:'map', fields:{radius:2} } },
    rules: { fuel: { type:'rule', fields:{value:1} } }
  }
};
let state = structuredClone(demoBundle); let group='objects'; let selected=null;
const groups=['terrains','objects','maps','rules'];
function groupDefs(){return state.schemas[group]||{}}
function items(){return Object.entries(state.content[group]||{})}
function renderNav(){document.querySelector('#groupNav').innerHTML=groups.map(g=>`<button class="nav-item ${g===group?'active':''}" data-group="${g}">${g[0].toUpperCase()+g.slice(1)}</button>`).join('');document.querySelectorAll('[data-group]').forEach(b=>b.onclick=()=>{group=b.dataset.group;selected=items()[0]?.[0]||null;render()})}
function renderList(){const el=document.querySelector('#entityList');const its=items();el.innerHTML=its.length?its.map(([id,v])=>`<button class="entity-item ${id===selected?'active':''}" data-id="${id}"><strong>${id}</strong><span>${v.type}</span></button>`).join(''):'<div class="empty">No entities yet</div>';document.querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>{selected=b.dataset.id;render()})}
function selectedEntity(){return selected?state.content[group]?.[selected]:null}
function coerce(field,raw){if(field.type==='boolean')return raw==='true';if(field.type==='integer')return Number.parseInt(raw,10);if(field.type==='number')return Number(raw);return raw}
function renderInspector(){const title=document.querySelector('#inspectorTitle'), form=document.querySelector('#editorForm'), del=document.querySelector('#deleteBtn');const entity=selectedEntity();if(!entity){title.textContent='Nothing selected';form.innerHTML='<div class="empty">Select or create an entity.</div>';del.disabled=true;return}title.textContent=`${group} / ${selected}`;del.disabled=false;const schema=groupDefs()[entity.type];form.innerHTML=(schema?.fields||[]).map(f=>{const val=entity.fields?.[f.id]??f.default??'';let control='';if(f.type==='boolean')control=`<select data-field="${f.id}"><option value="true" ${val===true?'selected':''}>true</option><option value="false" ${val!==true?'selected':''}>false</option></select>`;else if(f.type==='enum')control=`<select data-field="${f.id}">${f.values.map(v=>`<option value="${v}" ${v===val?'selected':''}>${v}</option>`).join('')}</select>`;else control=`<input data-field="${f.id}" value="${val??''}" ${f.min!=null?`min="${f.min}"`:''} ${f.max!=null?`max="${f.max}"`:''} ${f.type==='number'||f.type==='integer'?`type="number" step="${f.type==='integer'?'1':'any'}"`:'type="text"'}>`;return `<div class="field"><label>${f.label||f.id} · ${f.type}</label>${control}</div>`}).join('');form.querySelectorAll('[data-field]').forEach(input=>input.onchange=()=>{const f=schema.fields.find(x=>x.id===input.dataset.field);entity.fields=entity.fields||{};entity.fields[f.id]=coerce(f,input.value);validate(false)})}
function render(){renderNav();document.querySelector('#groupTitle').textContent=group[0].toUpperCase()+group.slice(1);renderList();renderInspector()}
function diagnosticsText(diags){return diags.length?diags.map(d=>`${d.severity.toUpperCase()} ${d.code}: ${d.message}`).join('\n'):'PASS: Authoring bundle is valid'}
function validate(show=true){let diags=[];try{if(state.manifest.authoringApiVersion!==API)throw new Error(`Unsupported authoringApiVersion: ${state.manifest.authoringApiVersion}`);for(const g of groups){for(const [id,v] of Object.entries(state.content[g]||{})){if(!/^[a-z][a-z0-9._-]*$/.test(id))diags.push({severity:'error',code:'INVALID_ID',message:`Invalid ${g} id ${id}`});if(!groupDefs()[v.type] && g!=='terrains' && g!=='objects' && g!=='maps' && g!=='rules')continue;}}}catch(e){diags.push({severity:'error',code:'INVALID_AUTHORING_BUNDLE',message:e.message})}document.querySelector('#diagnosticsOutput').textContent=diagnosticsText(diags);const badge=document.querySelector('#statusBadge');badge.className=`badge ${diags.length?'fail':'pass'}`;badge.textContent=diags.length?'Errors':'PASS';return diags}
document.querySelector('#newBtn').onclick=()=>{const defs=Object.keys(state.schemas[group]||{});if(!defs.length)return;let id=prompt(`New ${group} id`,`${group.slice(0,-1)}_01`);if(!id)return;const def=defs[0];state.content[group][id]={type:def,fields:{}};selected=id;render()};
document.querySelector('#deleteBtn').onclick=()=>{if(selected&&confirm(`Delete ${group}.${selected}?`)){delete state.content[group][selected];selected=items()[0]?.[0]||null;render()}};
document.querySelector('#validateBtn').onclick=()=>validate(true);
document.querySelector('#exportBtn').onclick=()=>{const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`${state.manifest.id}.authoring.json`;a.click();URL.revokeObjectURL(a.href)};
document.querySelector('#importInput').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{const parsed=JSON.parse(await file.text());state=parsed;group='objects';selected=items()[0]?.[0]||null;render();validate()}catch(err){alert(`Import failed: ${err.message}`)}};
render();
