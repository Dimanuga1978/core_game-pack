import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeQr } from '../src/encoder.js';
import { qrToSvg } from '../src/svg.js';

test('qrToSvg produces well-formed SVG with the right viewBox dimensions', () => {
  const encoded = encodeQr('http://192.168.1.42:4170/j/test01');
  const svg = qrToSvg(encoded, { moduleSize: 10, margin: 4 });
  assert.match(svg, /^<svg /);
  assert.match(svg, /<\/svg>$/);
  const expectedPx = (encoded.size + 8) * 10;
  assert.match(svg, new RegExp(`viewBox="0 0 ${expectedPx} ${expectedPx}"`));
});

test('qrToSvg draws exactly one <rect> per dark module, plus the background rect', () => {
  const encoded = encodeQr('http://x/j/A');
  const svg = qrToSvg(encoded);
  let darkModuleCount = 0;
  for (const row of encoded.modules) for (const cell of row) if (cell) darkModuleCount++;
  const rectCount = (svg.match(/<rect/g) || []).length;
  assert.equal(rectCount, darkModuleCount + 1, 'one <rect> per dark module, plus the one background rect');
});

test('qrToSvg respects custom colors', () => {
  const encoded = encodeQr('http://x/j/color-test');
  const svg = qrToSvg(encoded, { darkColor: '#123456', lightColor: '#abcdef' });
  assert.match(svg, /fill="#abcdef"/);
  assert.match(svg, /fill="#123456"/);
});

// Regression test for a real, if latent, injection risk found via
// manual code review (not a failing test): darkColor/lightColor used
// to be interpolated directly into the returned SVG markup string with
// no validation at all. Not reachable via this repo's own only real
// caller today (tools/server/public/create.js never passes either
// parameter), but this is an exported, public function any future
// caller could pass a user-influenced value to.
test('qrToSvg rejects a non-color value for darkColor/lightColor instead of interpolating it unescaped into the returned SVG markup', () => {
  const modules = [[true, false], [false, true]];
  assert.throws(() => qrToSvg({ size: 2, modules }, { darkColor: '"/><script>alert(1)</script>' }), TypeError);
  assert.throws(() => qrToSvg({ size: 2, modules }, { lightColor: '"/><script>alert(1)</script>' }), TypeError);
});

test('qrToSvg still accepts legitimate hex colors and CSS color names', () => {
  const modules = [[true, false], [false, true]];
  assert.doesNotThrow(() => qrToSvg({ size: 2, modules }, { darkColor: '#ff0000', lightColor: 'white' }));
  const svg = qrToSvg({ size: 2, modules }, { darkColor: '#ff0000' });
  assert.ok(svg.includes('#ff0000'));
});
