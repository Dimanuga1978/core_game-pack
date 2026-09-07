import {previewProfile} from './profile.js';
export function createVisualScene(state){
 const items=Array.from({length:12},(_,i)=>({id:i,label:previewProfile.phases[i%previewProfile.phases.length],value:Math.max(1,Math.floor(((state.seed||1)*(i+17)%97)+3))}));
 return {profile:previewProfile,items};
}
export function renderScene(target,scene,role){
 if(!target)return;
 target.replaceChildren();
 const root=document.createElement('div'); root.className=`visual-scene ${role}`;
 const grid=document.createElement('div'); grid.className='scene-grid';
 for(const [i,item] of scene.items.entries()){
   const node=document.createElement('div'); node.className=`scene-node n${i%4}`;
   const label=document.createElement('span'); label.textContent=String(item.label);
   const value=document.createElement('b'); value.textContent=String(item.value);
   node.append(label,value); grid.append(node);
 }
 const orbit=document.createElement('div'); orbit.className='scene-orbit';
 root.append(grid,orbit); target.append(root);
}
