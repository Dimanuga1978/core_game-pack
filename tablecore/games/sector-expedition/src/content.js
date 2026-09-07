import { createContentCatalog, materializeMap } from '@tablecore/content-sdk';

export const directions = [
  { id:'E', dq:1, dr:0 },
  { id:'NE', dq:1, dr:-1 },
  { id:'NW', dq:0, dr:-1 },
  { id:'W', dq:-1, dr:0 },
  { id:'SW', dq:-1, dr:1 },
  { id:'SE', dq:0, dr:1 },
];

export const terrain = Object.freeze({
  void: { id:'void', fuelCost:0 },
  asteroid: { id:'asteroid', fuelCost:1 },
  nebula: { id:'nebula', fuelCost:1 },
  dust: { id:'dust', fuelCost:1 },
});

export const objects = Object.freeze({
  station: { id:'station', collectible:false },
  salvage: { id:'salvage', collectible:true },
  hazard: { id:'hazard', collectible:false },
  beacon: { id:'beacon', collectible:false },
});

const key = (q,r) => `${q},${r}`;
const CONTENT = createContentCatalog({ terrains: terrain, objects });

export function buildSectorMap(radius = 2) {
  const tiles = {};
  for (let q=-radius;q<=radius;q++) {
    const rMin=Math.max(-radius,-q-radius);
    const rMax=Math.min(radius,-q+radius);
    for (let r=rMin;r<=rMax;r++) {
      tiles[key(q,r)]={q,r,terrain:'asteroid',object:null,revealedBy:[]};
    }
  }
  const set=(q,r,patch)=>Object.assign(tiles[key(q,r)],patch);
  for (const tile of Object.values(tiles)) tile.collectedBy=[];
  set(0,0,{terrain:'void',object:'station'});
  set(1,0,{terrain:'dust',object:'salvage'});
  set(-1,1,{terrain:'nebula',object:'salvage'});
  set(0,-1,{terrain:'asteroid',object:'salvage'});
  set(2,-1,{terrain:'nebula',object:'hazard'});
  set(-2,1,{terrain:'asteroid',object:'hazard'});
  set(1,-2,{terrain:'dust',object:'beacon'});
  // Validate final references through the content layer without moving game state into it.
  const refs = Object.fromEntries(Object.entries(tiles).map(([k,t]) => [k,{q:t.q,r:t.r,terrain:t.terrain,object:t.object}]));
  const mapCatalog = createContentCatalog({ terrains: CONTENT.terrains, objects: CONTENT.objects, maps: { generated: { cells: refs } } });
  materializeMap(mapCatalog, 'generated');
  return tiles;
}

export const mapKey = key;

export const contentCatalog = Object.freeze({
  terrains: terrain,
  objects,
  maps: {
    sector: {
      cells: buildSectorMap(2),
    },
  },
  rules: {
    starting_fuel: 3,
    salvage_goal: 3,
  },
});
