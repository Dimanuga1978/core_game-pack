// Renders an encodeQr() module grid as a real SVG string -- the simplest
// way to display a QR code in a browser page with no <canvas> setup,
// scales cleanly at any size, and is easy to embed directly in HTML.
// Found via a manual code review, not a failing test: `darkColor`/
// `lightColor` used to be interpolated directly into the returned SVG
// markup string with no validation at all -- a genuine injection risk
// in this exported, public function (e.g. a value like
// `"/><script>...` would break out of the fill attribute) if any
// FUTURE caller ever passes a user-influenced value here, even though
// this repo's own only real caller (tools/server/public/create.js)
// never does today (confirmed directly: it never passes either
// parameter, always using the safe defaults below). A CSS color is
// never legitimately anything other than a hex code or a plain CSS
// named color (letters only) -- validating against that shape closes
// the injection vector rather than merely documenting that today's one
// caller happens not to trigger it.
const SAFE_CSS_COLOR_RE = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)$/;
function assertSafeColor(value, label) {
  if (typeof value !== 'string' || !SAFE_CSS_COLOR_RE.test(value)) throw new TypeError(`${label} must be a hex color or a plain CSS color name, got: ${JSON.stringify(value)}`);
  return value;
}

export function qrToSvg({ size, modules }, { moduleSize = 8, margin = 4, darkColor = '#0b0f14', lightColor = '#ffffff' } = {}) {
  assertSafeColor(darkColor, 'darkColor');
  assertSafeColor(lightColor, 'lightColor');
  const px = size * moduleSize + margin * 2 * moduleSize;
  const rects = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!modules[r][c]) continue;
      const x = (c + margin) * moduleSize;
      const y = (r + margin) * moduleSize;
      rects.push(`<rect x="${x}" y="${y}" width="${moduleSize}" height="${moduleSize}"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${px} ${px}" width="${px}" height="${px}" shape-rendering="crispEdges"><rect width="${px}" height="${px}" fill="${lightColor}"/><g fill="${darkColor}">${rects.join('')}</g></svg>`;
}
