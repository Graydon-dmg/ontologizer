// @ts-check
// The 3D view uses the 2D view's graph helpers, so both views agree on neighborhoods,
// descendant counts and the label rule. Read-only import from Epic E.
export { neighborhood, descendants, ringsFrom, labelVisible } from '../graph/math.js';
