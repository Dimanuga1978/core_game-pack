import { createContentCatalog } from '@tablecore/content-sdk';
import raw from '../content/pack.json' with { type: 'json' };

const terrain = {
  asteroid: { id:'asteroid', fuelCost:1 },
  nebula: { id:'nebula', fuelCost:1 },
  dust: { id:'dust', fuelCost:1 },
  void: { id:'void', fuelCost:0 },
};
const objects = Object.fromEntries(Object.entries(raw.sectorObjects || {}).map(([id,v]) => [id,{id,...v}]));

export const contentCatalog = createContentCatalog({
  terrains:terrain,
  objects,
  maps:{},
  rules:{ ships:raw.ships, loot:raw.loot, board_generation:raw.boardGeneration, mechanics:{ version:'1.0.0', hiddenInformation:true } }
});
