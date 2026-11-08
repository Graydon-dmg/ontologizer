// @ts-check
/**
 * Design tokens: the only source of colors and styles. Pure functions, no DOM.
 */

/** Hues for the 12 categories (degrees), well separated. */
const HUES = [210, 20, 140, 330, 50, 270, 175, 0, 95, 245, 35, 305];

/**
 * @param {number} n
 * @returns {number} finite non-negative integer
 */
function safeIndex(n) {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Category color as a CSS string. Index wraps modulo 12; negative/NaN -> 0.
 * family 0: base set; family 1: same hues shifted 15 deg with different saturation
 * (second map in a fusion); family 2: one warm grey regardless of index (Hybrids).
 * Mid lightness (58%) reads on dark and light backgrounds.
 * @param {number} index
 * @param {number} [family]
 * @returns {string}
 */
export function categoryColor(index, family = 0) {
  if (family === 2) return 'hsl(30 8% 58%)';
  const h = HUES[safeIndex(index) % 12];
  if (family === 1) return `hsl(${(h + 15) % 360} 52% 62%)`;
  return `hsl(${h} 68% 58%)`;
}

/**
 * Lightness OFFSET in percentage points to ADD to a node's base lightness:
 * 0 at depth 0..1, +5 per ring after that, clamped at +15 (depth 4+).
 * Never NaN.
 * @param {number} depth
 * @returns {number}
 */
export function depthLightness(depth) {
  if (!Number.isFinite(depth)) return depth === Infinity ? 15 : 0;
  const d = Math.max(0, Math.floor(depth));
  return Math.min(15, Math.max(0, d - 1) * 5);
}

/**
 * Node radius in px: min(22, 5 + 3*log2(1+descendants)); negative/NaN -> 0 descendants.
 * @param {number} descendants
 * @returns {number}
 */
export function nodeRadius(descendants) {
  const d = Number.isFinite(descendants) && descendants > 0 ? descendants : descendants === Infinity ? Infinity : 0;
  return Math.min(22, 5 + 3 * Math.log2(1 + d));
}

/** @typedef {{ color: string, width: number, dash: number[]|null, curve: number }} EdgeStyle */

/** @type {Record<string, EdgeStyle>} */
const EDGES = {
  influences: { color: '#8aa4c8', width: 1.5, dash: null, curve: 0.15 },
  requires: { color: '#d9a05b', width: 2, dash: null, curve: 0 },
  'part-of': { color: '#7fbf9a', width: 1.2, dash: [2, 3], curve: 0 },
  bridge: { color: '#c77dd0', width: 2.5, dash: [8, 4], curve: 0.3 },
  analog: { color: '#6cc3c9', width: 1.5, dash: [4, 4], curve: 0.25 },
};

/**
 * Edge style by relation type; unknown types get a neutral grey default.
 * @param {string} type
 * @returns {EdgeStyle}
 */
export function edgeStyle(type) {
  const s = Object.prototype.hasOwnProperty.call(EDGES, type) ? EDGES[type] : { color: '#8b8f98', width: 1.2, dash: null, curve: 0.1 };
  return { ...s, dash: s.dash ? [...s.dash] : null };
}

/**
 * Node outline by origin. seed: solid heavier; context: solid; general: dashed;
 * fuse: double; rosetta: solid thin. sourced === false (non-seed) -> dotted [1,3].
 * Unknown origin -> plain solid.
 * @param {string} origin
 * @param {boolean} [sourced]
 * @returns {{ stroke: string, dash: number[]|null, double: boolean, width?: number }}
 */
export function originOutline(origin, sourced = true) {
  /** @type {{ stroke: string, dash: number[]|null, double: boolean, width: number }} */
  let o;
  switch (origin) {
    case 'seed': return { stroke: '#e8e8ee', dash: null, double: false, width: 2.5 };
    case 'context': o = { stroke: '#a9b1c2', dash: null, double: false, width: 1.5 }; break;
    case 'general': o = { stroke: '#a9b1c2', dash: [6, 3], double: false, width: 1.5 }; break;
    case 'fuse': o = { stroke: '#d6b4f0', dash: null, double: true, width: 1.5 }; break;
    case 'rosetta': o = { stroke: '#8fd3d8', dash: null, double: false, width: 1 }; break;
    default: o = { stroke: '#a9b1c2', dash: null, double: false, width: 1.5 };
  }
  if (sourced === false) o.dash = [1, 3];
  return o;
}

export const LABEL_RULE = { alwaysDepth: 2, zoomForDeeper: 1.6 };
export const MOTION = { spawnMs: 450, focusMs: 700, hoverDim: 0.15 };

export const THEME = {
  dark: { bg: '#0f1115', fg: '#e6e8ee', muted: '#8b92a3', panel: '#181b22' },
  light: { bg: '#fafafc', fg: '#1b1e26', muted: '#667085', panel: '#ffffff' },
};

/**
 * Brand colors from the logo (web/shared/brand/). `nodes` are the 8 symbol dots in clockwise
 * order from the top, exactly as in the SVGs; `core` is the centre dot per theme; `spoke` is the
 * line color. For the CLI, the shell and anything that should look like the logo.
 */
export const BRAND = Object.freeze({
  nodes: Object.freeze(['#36a9cf', '#249eaa', '#f2b21c', '#f2a23b', '#e98756', '#d98287', '#e88368', '#648ec5']),
  core: Object.freeze({ light: '#171b22', dark: '#f4f6fa' }),
  spoke: '#a6abb2',
});
