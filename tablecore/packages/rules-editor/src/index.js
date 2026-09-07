const clone=(v)=>structuredClone(v);
const ID_RE=/^[a-z][a-z0-9._-]*$/;
export const RULES_EDITOR_API_VERSION='1.0.0';
const CONDITION_TYPES=new Set(['all','any','not','compare','has','phase']);
const EFFECT_TYPES=new Set(['set','add','subtract','emit','finish']);
const OPERATORS=new Set(['eq','neq','gt','gte','lt','lte','in','contains']);
function fail(message,path=''){const e=new TypeError(path?`${path}: ${message}`:message);e.path=path;throw e;}
function assertId(v,label,path=label){if(typeof v!=='string'||!ID_RE.test(v))fail(`invalid identifier ${String(v)}`,path);}
function assertEventId(v,path='event'){if(typeof v!=='string'||!/^[A-Za-z][A-Za-z0-9._-]*$/.test(v))fail(`invalid event identifier ${String(v)}`,path);}
function assertObject(v,path){if(!v||typeof v!=='object'||Array.isArray(v))fail('must be an object',path);}
function assertValue(v,path){const t=typeof v;if(v===null||t==='string'||t==='number'||t==='boolean')return;if(Array.isArray(v)){v.forEach((x,i)=>assertValue(x,`${path}[${i}]`));return}if(t==='object'){for(const[k,x]of Object.entries(v))assertValue(x,`${path}.${k}`);return}fail('contains unsupported value type',path)}
function validateCondition(c,path='condition'){
 assertObject(c,path); if(typeof c.type!=='string'||!CONDITION_TYPES.has(c.type))fail(`unsupported type ${String(c.type)}`,`${path}.type`);
 switch(c.type){case'all':case'any':if(!Array.isArray(c.conditions)||!c.conditions.length)fail('conditions must be a non-empty array',`${path}.conditions`);c.conditions.forEach((x,i)=>validateCondition(x,`${path}.conditions[${i}]`));break;case'not':validateCondition(c.condition,`${path}.condition`);break;case'compare':if(typeof c.path!=='string'||!c.path)fail('path is required',`${path}.path`);if(typeof c.operator!=='string'||!OPERATORS.has(c.operator))fail(`unsupported operator ${String(c.operator)}`,`${path}.operator`);if(!Object.prototype.hasOwnProperty.call(c,'value'))fail('value is required',`${path}.value`);assertValue(c.value,`${path}.value`);break;case'has':if(typeof c.path!=='string'||!c.path)fail('path is required',`${path}.path`);break;case'phase':assertId(c.name,'phase name',`${path}.name`);break;default:fail('unreachable',path)}}
function validateEffect(e,path='effect'){
 assertObject(e,path);if(typeof e.type!=='string'||!EFFECT_TYPES.has(e.type))fail(`unsupported type ${String(e.type)}`,`${path}.type`);
 switch(e.type){case'set':case'add':case'subtract':if(typeof e.path!=='string'||!e.path)fail('path is required',`${path}.path`);if(!Object.prototype.hasOwnProperty.call(e,'value'))fail('value is required',`${path}.value`);assertValue(e.value,`${path}.value`);break;case'emit':assertEventId(e.event,`${path}.event`);if(e.payload!==undefined)assertValue(e.payload,`${path}.payload`);break;case'finish':if(e.reason!==undefined&&(typeof e.reason!=='string'||!e.reason))fail('reason must be a non-empty string',`${path}.reason`);break;default:fail('unreachable',path)}}
export function validateRuleDefinition(rule,path='rule'){assertObject(rule,path);assertId(rule.id,'rule id',`${path}.id`);if(rule.name!==undefined&&typeof rule.name!=='string')fail('name must be a string',`${path}.name`);if(rule.enabled!==undefined&&typeof rule.enabled!=='boolean')fail('enabled must be boolean',`${path}.enabled`);validateCondition(rule.when,`${path}.when`);if(!Array.isArray(rule.then)||!rule.then.length)fail('then must be a non-empty array',`${path}.then`);rule.then.forEach((x,i)=>validateEffect(x,`${path}.then[${i}]`));if(rule.else!==undefined){if(!Array.isArray(rule.else))fail('else must be an array',`${path}.else`);rule.else.forEach((x,i)=>validateEffect(x,`${path}.else[${i}]`))}return true}
export function validateRuleSet(rs){assertObject(rs,'ruleSet');if(rs.id!==undefined)assertId(rs.id,'rule set id','ruleSet.id');if(rs.name!==undefined&&typeof rs.name!=='string')fail('name must be a string','ruleSet.name');if(rs.parameters!==undefined){assertObject(rs.parameters,'ruleSet.parameters');for(const[id,v]of Object.entries(rs.parameters)){assertId(id,'parameter id',`ruleSet.parameters.${id}`);assertValue(v,`ruleSet.parameters.${id}`)}}if(!Array.isArray(rs.rules)||!rs.rules.length)fail('rules must be a non-empty array','ruleSet.rules');const ids=new Set;rs.rules.forEach((r,i)=>{validateRuleDefinition(r,`ruleSet.rules[${i}]`);if(ids.has(r.id))fail(`duplicate rule id ${r.id}`,`ruleSet.rules[${i}].id`);ids.add(r.id)});return true}
export function createRuleSet(rs){validateRuleSet(rs);return Object.freeze(clone(rs))}
export class RulesEditorModel{
 constructor(rs){validateRuleSet(rs);this.ruleSet=clone(rs);this.selectedRuleId=this.ruleSet.rules[0]?.id??null}
 listRules(){return clone(this.ruleSet.rules)}
 getRule(id=this.selectedRuleId){const r=this.ruleSet.rules.find(x=>x.id===id);return r?clone(r):null}
 createRule(rule){validateRuleDefinition(rule,`ruleSet.rules[${this.ruleSet.rules.length}]`);if(this.ruleSet.rules.some(x=>x.id===rule.id))fail(`duplicate rule id ${rule.id}`,'ruleSet.rules');this.ruleSet.rules.push(clone(rule));this.selectedRuleId=rule.id;return clone(rule)}
 updateRule(id,patch){const i=this.ruleSet.rules.findIndex(x=>x.id===id);if(i<0)fail(`unknown rule ${id}`,'ruleSet.rules');const next={...this.ruleSet.rules[i],...clone(patch),id};validateRuleDefinition(next,`ruleSet.rules[${i}]`);this.ruleSet.rules[i]=next;return clone(next)}
 removeRule(id=this.selectedRuleId){const i=this.ruleSet.rules.findIndex(x=>x.id===id);if(i<0)return false;this.ruleSet.rules.splice(i,1);this.selectedRuleId=this.ruleSet.rules[0]?.id??null;return true}
 setParameter(id,value){assertId(id,'parameter id',`ruleSet.parameters.${id}`);assertValue(value,`ruleSet.parameters.${id}`);if(!this.ruleSet.parameters)this.ruleSet.parameters={};this.ruleSet.parameters[id]=clone(value);return clone(value)}
 validate(){try{validateRuleSet(this.ruleSet);return[]}catch(e){return[{severity:'error',code:'INVALID_RULE_SET',path:e.path??'',message:e.message}]}}
 snapshot(){return clone(this.ruleSet)}
}
export function createRulesEditor(rs){return new RulesEditorModel(rs)}
