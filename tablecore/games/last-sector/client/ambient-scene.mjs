// Ambient background scene for the hex board -- built once, as a
// static layer behind the real hex grid (matching the original
// pre-engine game's own addAmbientScene() approach: build it once in
// rebuild(), never touch it again on subsequent state updates, since
// it's decorative and has nothing to do with live game state). This is
// a genuinely richer version than that original 3-circle, one-layer-of-
// dots scene -- previewed for real human approval before being ported
// into this file (see this project's own conversation history for that
// preview and the explicit go-ahead), not built blind.
//
// Star/nebula positions are DETERMINISTIC (seed01(), the exact same
// formula the original game used, not Math.random()) so the scene is
// reproducible and testable -- calling this twice with the same
// width/height always produces byte-identical output, which is what
// makes the structural tests in hexAmbientScene.test.js meaningful
// (there is a real, fixed thing to assert about, not "some random
// stars appeared somewhere").
const NS = 'http://www.w3.org/2000/svg';

function seed01(n) {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

const NEBULA_COLORS = ['#5eb8ff', '#c48be0', '#5eead4', '#5eb8ff'];

function buildNebulaLayer(documentRef, width, height) {
  const g = documentRef.createElementNS(NS, 'g');
  g.classList.add('ambient-nebula');
  // Four soft, differently-colored radial-gradient clouds at fixed
  // (relative-to-board-size) positions -- richer than the original's
  // three flat, uniformly-dim circles: each one now has real depth
  // (a bright core fading to nothing) via its own gradient, not just a
  // single flat fill-opacity.
  const spots = [
    { cx: width * 0.18, cy: height * 0.22, r: width * 0.30, color: 0 },
    { cx: width * 0.78, cy: height * 0.62, r: width * 0.34, color: 1 },
    { cx: width * 0.58, cy: height * 0.14, r: width * 0.22, color: 2 },
    { cx: width * 0.12, cy: height * 0.76, r: width * 0.20, color: 3 },
  ];
  for (let i = 0; i < spots.length; i++) {
    const spot = spots[i];
    const gradientId = `ls-ambient-neb-${i}`;
    const gradient = documentRef.createElementNS(NS, 'radialGradient');
    gradient.setAttribute('id', gradientId);
    gradient.setAttribute('cx', '50%'); gradient.setAttribute('cy', '50%'); gradient.setAttribute('r', '50%');
    const stops = [
      [0, NEBULA_COLORS[spot.color], 0.30],
      [60, NEBULA_COLORS[spot.color], 0.10],
      [100, NEBULA_COLORS[spot.color], 0],
    ];
    for (const [offset, color, opacity] of stops) {
      const stop = documentRef.createElementNS(NS, 'stop');
      stop.setAttribute('offset', `${offset}%`);
      stop.setAttribute('stop-color', color);
      stop.setAttribute('stop-opacity', String(opacity));
      gradient.appendChild(stop);
    }
    const defs = documentRef.createElementNS(NS, 'defs');
    defs.appendChild(gradient);
    g.appendChild(defs);
    const ellipse = documentRef.createElementNS(NS, 'ellipse');
    ellipse.setAttribute('cx', String(spot.cx));
    ellipse.setAttribute('cy', String(spot.cy));
    ellipse.setAttribute('rx', String(spot.r));
    ellipse.setAttribute('ry', String(spot.r * 0.68));
    ellipse.setAttribute('fill', `url(#${gradientId})`);
    ellipse.classList.add('ambient-cloud');
    g.appendChild(ellipse);
  }
  return g;
}

/**
 * One layer of `count` stars scattered across the board using seed01(),
 * offset by `seedOffset` so different layers don't reuse the exact same
 * pseudo-random positions. `twinkle` adds the CSS twinkle animation
 * class (and a per-star animation-delay, so identical loops don't all
 * breathe in sync -- same reasoning the original game's own animDelay()
 * used) -- the far/dim layer skips this (real cost/benefit call: many
 * tiny animated elements is real animation overhead for a background
 * layer, and barely-visible dim stars twinkling is not a noticeable
 * effect anyway), while the brighter, more visible layers get it.
 */
function buildStarLayer(documentRef, width, height, { count, minRadius, maxRadius, minOpacity, maxOpacity, color, seedOffset, twinkle, className }) {
  const g = documentRef.createElementNS(NS, 'g');
  g.classList.add('ambient-stars', className);
  for (let i = 0; i < count; i++) {
    const x = seed01(i + seedOffset) * width;
    const y = seed01(i + seedOffset + 500) * height;
    const r = minRadius + seed01(i + seedOffset + 900) * (maxRadius - minRadius);
    const opacity = minOpacity + seed01(i + seedOffset + 1300) * (maxOpacity - minOpacity);
    const circle = documentRef.createElementNS(NS, 'circle');
    circle.setAttribute('cx', String(x));
    circle.setAttribute('cy', String(y));
    circle.setAttribute('r', String(r));
    circle.setAttribute('fill', color);
    circle.setAttribute('opacity', String(opacity));
    if (twinkle) {
      circle.classList.add('ambient-star-twinkle');
      circle.style.animationDelay = `-${(seed01(i + seedOffset + 1700) * 5).toFixed(2)}s`;
    }
    g.appendChild(circle);
  }
  return g;
}

function buildBrightStars(documentRef, width, height) {
  const g = documentRef.createElementNS(NS, 'g');
  g.classList.add('ambient-stars-bright');
  const glowGradient = documentRef.createElementNS(NS, 'radialGradient');
  glowGradient.setAttribute('id', 'ls-ambient-star-glow');
  glowGradient.setAttribute('cx', '50%'); glowGradient.setAttribute('cy', '50%'); glowGradient.setAttribute('r', '50%');
  const glowStops = [[0, '#eaf6ff', 1], [100, '#eaf6ff', 0]];
  for (const [offset, color, opacity] of glowStops) {
    const stop = documentRef.createElementNS(NS, 'stop');
    stop.setAttribute('offset', `${offset}%`);
    stop.setAttribute('stop-color', color);
    stop.setAttribute('stop-opacity', String(opacity));
    glowGradient.appendChild(stop);
  }
  const defs = documentRef.createElementNS(NS, 'defs');
  defs.appendChild(glowGradient);
  g.appendChild(defs);
  const count = 8;
  const colors = ['#eaf6ff', '#a6f4ff', '#c8dcf5'];
  for (let i = 0; i < count; i++) {
    const x = seed01(i + 2100) * width;
    const y = seed01(i + 2600) * height;
    const glow = documentRef.createElementNS(NS, 'circle');
    glow.setAttribute('cx', String(x)); glow.setAttribute('cy', String(y)); glow.setAttribute('r', '5');
    glow.setAttribute('fill', 'url(#ls-ambient-star-glow)');
    glow.classList.add('ambient-star-twinkle');
    glow.style.animationDelay = `-${(seed01(i + 3100) * 5).toFixed(2)}s`;
    g.appendChild(glow);
    const core = documentRef.createElementNS(NS, 'circle');
    core.setAttribute('cx', String(x)); core.setAttribute('cy', String(y)); core.setAttribute('r', '1.4');
    core.setAttribute('fill', colors[i % colors.length]);
    g.appendChild(core);
  }
  return g;
}

/**
 * A single repeating shooting-star streak -- pure spectacle, the one
 * element the original game's ambient scene never had at all. A short
 * glowing line + head dot, animated along a fixed diagonal path via CSS
 * (see the shared .ambient-shooting-star keyframes both player-ui and
 * tv-ui's stylesheets define), pausing between runs rather than
 * constantly streaking (that would be distracting, not spectacular, in
 * a background layer someone stares at for a whole match).
 */
function buildShootingStar(documentRef, width, height) {
  // Outer group carries the STATIC starting position via a real SVG
  // transform attribute; the inner group is what CSS actually animates.
  // Necessary because a CSS animation that touches `transform` on the
  // SAME element REPLACES its existing SVG transform attribute rather
  // than composing with it in real browsers (the exact footgun the
  // original pre-engine game's own board.js already documented for ship
  // icon positioning, for the identical reason) -- putting the static
  // position on an outer wrapper and the animated motion on an inner
  // child keeps both intact at once.
  const outer = documentRef.createElementNS(NS, 'g');
  outer.classList.add('ambient-shooting-star');
  outer.setAttribute('transform', `translate(${width * 0.15} ${height * 0.12})`);
  const inner = documentRef.createElementNS(NS, 'g');
  inner.classList.add('ambient-shooting-star-motion');
  const line = documentRef.createElementNS(NS, 'line');
  line.setAttribute('x1', '0'); line.setAttribute('y1', '0');
  line.setAttribute('x2', String(width * 0.09)); line.setAttribute('y2', String(width * 0.09 * 0.55));
  line.setAttribute('stroke', '#eaf6ff');
  line.setAttribute('stroke-width', '2');
  line.setAttribute('stroke-linecap', 'round');
  inner.appendChild(line);
  const head = documentRef.createElementNS(NS, 'circle');
  head.setAttribute('r', '2'); head.setAttribute('fill', '#eaf6ff');
  head.setAttribute('cx', String(width * 0.09)); head.setAttribute('cy', String(width * 0.09 * 0.55));
  inner.appendChild(head);
  outer.appendChild(inner);
  return outer;
}

/**
 * Builds the full ambient scene group, sized to the board's own real
 * pixel width/height (see hex-geometry.mjs's computeBoardPixelSize) so
 * it always covers the actual playing field regardless of board size,
 * not a fixed guess. Meant to be inserted as the FIRST child of the
 * board's <svg> (behind the hex grid group), built exactly once.
 */
export function createAmbientScene(documentRef, width, height) {
  const g = documentRef.createElementNS(NS, 'g');
  g.setAttribute('id', 'ls-ambient');
  g.style.pointerEvents = 'none';
  g.appendChild(buildNebulaLayer(documentRef, width, height));
  g.appendChild(buildStarLayer(documentRef, width, height, { count: 48, minRadius: 0.4, maxRadius: 0.9, minOpacity: 0.25, maxOpacity: 0.55, color: '#8fb4d6', seedOffset: 1, twinkle: false, className: 'ambient-stars-far' }));
  g.appendChild(buildStarLayer(documentRef, width, height, { count: 21, minRadius: 0.9, maxRadius: 1.4, minOpacity: 0.6, maxOpacity: 0.95, color: '#bcdcf5', seedOffset: 4001, twinkle: true, className: 'ambient-stars-mid' }));
  g.appendChild(buildBrightStars(documentRef, width, height));
  g.appendChild(buildShootingStar(documentRef, width, height));
  return g;
}
