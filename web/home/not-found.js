// @ts-check
// The "not found, or you don't have access" page: the maps home's theme, nothing else. It names no map.
import * as tokens from '../shared/tokens.js';
import { loadChoice, applyTheme } from '../shell/theme.js';

/** @type {Storage|null} */
let storage = null;
try { storage = window.localStorage; } catch { storage = null; }
const mq = matchMedia('(prefers-color-scheme: light)');
const apply = () => applyTheme(document, loadChoice(storage), mq.matches, tokens, (t, init) => new CustomEvent(t, init));
mq.addEventListener('change', apply);
apply();
