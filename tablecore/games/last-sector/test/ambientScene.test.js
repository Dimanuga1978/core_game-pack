import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSvgDocument } from './fakeSvgDom.js';
import { createAmbientScene } from '../client/ambient-scene.mjs';

function countByClass(root, className) {
  let count = 0;
  const walk = el => {
    if (el.classList?.contains(className)) count++;
    for (const child of el.children ?? []) walk(child);
  };
  walk(root);
  return count;
}

function collectIds(root) {
  const ids = [];
  const walk = el => {
    const id = el.getAttribute?.('id');
    if (id) ids.push(id);
    for (const child of el.children ?? []) walk(child);
  };
  walk(root);
  return ids;
}

test('createAmbientScene is fully deterministic -- the same width/height always produces byte-identical structure (seed01, not Math.random)', () => {
  const doc = createFakeSvgDocument();
  const a = createAmbientScene(doc, 500, 400);
  const b = createAmbientScene(doc, 500, 400);
  function fingerprint(root) {
    const out = [];
    const walk = el => {
      if (el.tagName === 'circle' || el.tagName === 'ellipse') {
        out.push(JSON.stringify(el._attrs));
      }
      for (const child of el.children ?? []) walk(child);
    };
    walk(root);
    return out;
  }
  assert.deepEqual(fingerprint(a), fingerprint(b));
});

test('every gradient id inside one ambient scene is unique', () => {
  const doc = createFakeSvgDocument();
  const scene = createAmbientScene(doc, 500, 400);
  const ids = collectIds(scene);
  assert.ok(ids.length >= 5, `sanity: expected at least 5 real ids (4 nebula + 1 star glow), got ${ids.length}`);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids found: ${ids}`);
});

test('the scene has exactly 4 nebula clouds, matching the approved richer design (up from the original 3 flat circles)', () => {
  const doc = createFakeSvgDocument();
  const scene = createAmbientScene(doc, 500, 400);
  assert.equal(countByClass(scene, 'ambient-cloud'), 4);
});

test('the scene has three distinct star layers with the expected counts (far/mid/bright), for real visual depth', () => {
  const doc = createFakeSvgDocument();
  const scene = createAmbientScene(doc, 500, 400);
  assert.equal(countByClass(scene, 'ambient-stars-far'), 1, 'exactly one far-layer group');
  assert.equal(countByClass(scene, 'ambient-stars-mid'), 1, 'exactly one mid-layer group');
  assert.equal(countByClass(scene, 'ambient-stars-bright'), 1, 'exactly one bright-layer group');
});

test('the scene includes exactly one repeating shooting star -- the one real spectacle element the original ambient scene never had', () => {
  const doc = createFakeSvgDocument();
  const scene = createAmbientScene(doc, 500, 400);
  assert.equal(countByClass(scene, 'ambient-shooting-star'), 1);
});

test('every star and nebula position stays within the requested width/height bounds -- nothing drawn wildly outside the intended area', () => {
  const doc = createFakeSvgDocument();
  const width = 500, height = 400;
  const scene = createAmbientScene(doc, width, height);
  const walk = el => {
    if (el.tagName === 'circle') {
      const cx = Number(el.getAttribute('cx'));
      const cy = Number(el.getAttribute('cy'));
      if (Number.isFinite(cx) && Number.isFinite(cy) && el.getAttribute('cx') !== null) {
        assert.ok(cx >= -1 && cx <= width + 1, `circle cx=${cx} out of [0,${width}] bounds`);
        assert.ok(cy >= -1 && cy <= height + 1, `circle cy=${cy} out of [0,${height}] bounds`);
      }
    }
    for (const child of el.children ?? []) walk(child);
  };
  walk(scene);
});

test('createAmbientScene sets pointer-events:none on the root group so it never intercepts clicks meant for the real hex tiles beneath the grid layer', () => {
  const doc = createFakeSvgDocument();
  const scene = createAmbientScene(doc, 500, 400);
  assert.equal(scene.style.pointerEvents, 'none');
});

test('the shooting star\'s static position and its CSS-animated motion live on DIFFERENT elements -- a real footgun: a CSS animation touching "transform" on the same element that already carries a static SVG transform attribute REPLACES it instead of composing with it in real browsers', () => {
  const doc = createFakeSvgDocument();
  const scene = createAmbientScene(doc, 500, 400);
  let outer = null;
  const walk = el => { if (el.classList?.contains('ambient-shooting-star')) outer = el; for (const c of el.children ?? []) walk(c); };
  walk(scene);
  assert.ok(outer, 'expected to find the shooting star outer group');
  assert.ok(outer.getAttribute('transform'), 'the outer group must carry the static position transform');
  const inner = outer.children.find(c => c.classList.contains('ambient-shooting-star-motion'));
  assert.ok(inner, 'expected a distinct inner group for the CSS-animated motion');
  assert.equal(inner.getAttribute('transform'), null, 'the inner (CSS-animated) group must NOT also carry a static transform attribute, or the animation would silently replace it');
});
