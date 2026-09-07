import { AUTHORING_API_VERSION, createAuthoringBundle } from '@tablecore/authoring-sdk';

export const sectorExpeditionAuthoring = createAuthoringBundle({
  manifest: {
    id: 'sector-expedition',
    name: 'Sector Expedition',
    version: '0.1.0',
    authoringApiVersion: AUTHORING_API_VERSION,
    gamePackApiVersion: '1.0.0',
    contentApiVersion: '1.0.0'
  },
  editor: {
    categories: ['terrains', 'objects', 'maps', 'rules'],
    mapEditor: { coordinateSystem: 'axial-hex', preview: true },
  },
  schemas: {
    terrains: {
      terrain: { fields: [
        { id: 'fuel_cost', type: 'integer', min: 0, max: 99, required: true },
      ] }
    },
    objects: {
      object: { fields: [
        { id: 'collectible', type: 'boolean', default: false },
      ] }
    },
    maps: {
      map: { fields: [
        { id: 'radius', type: 'integer', min: 1, max: 20, default: 2 },
      ] }
    },
    rules: {
      rule: { fields: [
        { id: 'value', type: 'number', required: true },
      ] }
    }
  }
});
