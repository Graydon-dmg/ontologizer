// @ts-check
import { infoTip } from './tip.js';

/** The ⓘ copy for every top-bar function (one line, at most ~90 characters). */
export const TIPS = {
  search: 'Find a node by name',
  categories: 'Show or hide whole branches of the map',
  depth: 'Hide nodes deeper than this level',
  views: 'Flat graph or 3D floor-and-sky view',
  rosetta: "See every node through a field you already know, e.g. 'a home chef'",
  theme: 'Colour theme',
  chat: 'Ask questions about this map; add screenshots or photos',
  fuse: 'Make a new map that joins this one with another saved map',
  minimap: 'Click or drag to move around the map',
  legend: 'What each colour means; click the title to fold it away',
};

/** Put an ⓘ next to each control. Runs once, after every control is mounted. @param {any} shell */
export function mountTips(shell) {
  const $ = (/** @type {string} */ s) => /** @type {HTMLElement|null} */ (document.querySelector(s));
  /** @param {Element|null} after @param {string} text @param {string} name */
  const after = (after, text, name) => { if (after) after.after(infoTip(text, name)); };
  after($('#search .search') || $('#search input'), TIPS.search, 'Search');
  after($('#filter .filter-box'), TIPS.categories, 'Categories');
  after($('#filter .depth-dd'), TIPS.depth, 'Depth');
  const views = $('#view-switcher'); if (views) views.append(infoTip(TIPS.views, '2D and 3D'));
  after($('#lens-switcher .dd'), TIPS.rosetta, 'Rosetta');
  after($('#fuse .fuse-btn'), TIPS.fuse, 'Fuse');
  after($('#chat-btn .chat-btn'), TIPS.chat, 'Chat');
  const theme = $('#theme-switcher'); if (theme) theme.append(infoTip(TIPS.theme, 'Light and Dark'));
  const mm = $('#minimap');
  if (mm) { const i = infoTip(TIPS.minimap, 'the minimap'); i.classList.add('info-minimap'); mm.append(i); }
  const lg = $('#legend');
  if (lg) { const i = infoTip(TIPS.legend, 'the legend'); i.classList.add('info-legend'); lg.append(i); }
  void shell;
}
