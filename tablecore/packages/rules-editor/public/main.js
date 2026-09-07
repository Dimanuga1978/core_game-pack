const demo = {
  apiVersion: '1.0.0',
  id: 'sector-rules',
  name: 'Sector Rules',
  parameters: { salvage_goal: 3, fuel_pack_amount: 3, fuel_pack_cost: 500 },
  rules: [
    { id:'salvage-available', name:'Salvage Available', enabled:true, when:{type:'has',path:'tile.salvage'}, then:[{type:'emit',event:'SALVAGE_AVAILABLE'}] },
    { id:'deliver-salvage', name:'Deliver Salvage', enabled:true, when:{type:'all',conditions:[{type:'phase',name:'playing'},{type:'compare',path:'player.salvage',operator:'gte',value:3},{type:'compare',path:'tile.object',operator:'eq',value:'station'}]}, then:[{type:'finish',reason:'SALVAGE_DELIVERED'},{type:'emit',event:'GAME_FINISHED'}] }
  ]
};
let state = structuredClone(demo);
let selected = state.rules[0]?.id ?? null;
const rulesEl = document.querySelector('#rules');
const formEl = document.querySelector('#form');
const previewEl = document.querySelector('#preview');
const statusEl = document.querySelector('#status');
const diagEl = document.querySelector('#diagnostics');
const titleEl = document.querySelector('#ruleTitle');
const deleteBtn = document.querySelector('#deleteBtn');
const clone = v => structuredClone(v);
const idOk = id => typeof id === 'string' && /^[a-z][a-z0-9._-]*$/.test(id);
function selectedRule(){ return state.rules.find(r => r.id === selected) ?? null; }
function render(){
  document.querySelector('#ruleCount').textContent = String(state.rules.length);
  rulesEl.innerHTML = state.rules.map(r => `<button class="rule ${r.id===selected?'active':''}" data-id="${r.id}"><strong>${r.name||r.id}</strong><span>${r.enabled===false?'disabled':'enabled'}</span></button>`).join('');
  rulesEl.querySelectorAll('[data-id]').forEach(b => b.onclick = () => { selected=b.dataset.id; render(); });
  renderEditor(); validate(false);
}
function renderEditor(){
  const rule = selectedRule();
  deleteBtn.disabled = !rule;
  if(!rule){ titleEl.textContent='Nothing selected'; formEl.innerHTML='<div class="empty">Create or select a rule.</div>'; previewEl.textContent=''; return; }
  titleEl.textContent = rule.name || rule.id;
  formEl.innerHTML = `
    <label>ID<input id="id" value="${rule.id}" disabled></label>
    <label>Name<input id="name" value="${rule.name||''}"></label>
    <label class="inline"><input id="enabled" type="checkbox" ${rule.enabled===false?'':'checked'}> Enabled</label>
    <label>WHEN <textarea id="when" rows="8">${JSON.stringify(rule.when,null,2)}</textarea></label>
    <label>THEN <textarea id="then" rows="8">${JSON.stringify(rule.then,null,2)}</textarea></label>
    <label>ELSE <textarea id="else" rows="6">${rule.else?JSON.stringify(rule.else,null,2):''}</textarea></label>`;
  document.querySelector('#name').onchange = e => { rule.name=e.target.value; render(); };
  document.querySelector('#enabled').onchange = e => { rule.enabled=e.target.checked; render(); };
  for(const field of ['when','then','else']){
    document.querySelector(`#${field}`).onchange = e => {
      try { const value=e.target.value.trim(); rule[field]=value?JSON.parse(value):undefined; if(rule[field]===undefined) delete rule[field]; validate(true); previewEl.textContent=JSON.stringify(rule,null,2); }
      catch(err){ diagEl.textContent=`ERROR INVALID_JSON: ${err.message}`; statusEl.textContent='ERROR'; }
    };
  }
  previewEl.textContent=JSON.stringify(rule,null,2);
}
function validate(show=true){
  const diagnostics=[];
  for(const [i,r] of state.rules.entries()){
    if(!idOk(r.id)) diagnostics.push(`ERROR INVALID_ID: rules[${i}].id`);
    if(!r.when || typeof r.when!=='object') diagnostics.push(`ERROR MISSING_WHEN: ${r.id}`);
    if(!Array.isArray(r.then) || r.then.length===0) diagnostics.push(`ERROR MISSING_THEN: ${r.id}`);
  }
  if(new Set(state.rules.map(r=>r.id)).size!==state.rules.length) diagnostics.push('ERROR DUPLICATE_RULE_ID: rule ids must be unique');
  diagEl.textContent=diagnostics.length?diagnostics.join('\n'):'PASS: Rule set is structurally valid';
  statusEl.textContent=diagnostics.length?'Errors':'PASS';
  statusEl.className=diagnostics.length?'fail':'pass';
  return diagnostics;
}
document.querySelector('#newRuleBtn').onclick = () => { let id=prompt('New rule id',`rule_${String(state.rules.length+1).padStart(2,'0')}`); if(!id || !idOk(id) || state.rules.some(r=>r.id===id)) return; state.rules.push({id,name:id,enabled:true,when:{type:'has',path:'state.example'},then:[{type:'emit',event:'RULE_TRIGGERED'}]}); selected=id; render(); };
deleteBtn.onclick = () => { if(!selected)return; state.rules=state.rules.filter(r=>r.id!==selected); selected=state.rules[0]?.id??null; render(); };
document.querySelector('#validateBtn').onclick = () => validate(true);
document.querySelector('#exportBtn').onclick = () => { const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`${state.id}.rules.json`; a.click(); URL.revokeObjectURL(a.href); };
render();
