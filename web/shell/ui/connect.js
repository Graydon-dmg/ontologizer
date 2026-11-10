// @ts-check
// "Connect an agent": a floating panel with the commands that give an agent the map tools (see
// ../connect.js). Placed like the Export menu: inside the window, under the whole top bar.
import { agentConfigs, CONNECT_INTRO, TOKEN_NOTE, SERVE_NOTE } from '../connect.js';
import { fitTo } from './fit.js';

const STYLE_ID = 'connect-panel-style';
const CSS = `
#connect-panel { position: fixed; z-index: 30; width: 420px; box-sizing: border-box; padding: 10px; overflow: auto;
  background: var(--panel); color: var(--fg); border: 1px solid color-mix(in srgb, var(--muted) 40%, transparent); border-radius: 8px;
  font-size: 12px; display: flex; flex-direction: column; gap: 8px; }
#connect-panel[hidden] { display: none; }
#connect-panel h3 { margin: 0; font-size: 12px; }
#connect-panel > * { flex: none; }
#connect-panel p { margin: 0; }
#connect-panel .connect-note { color: var(--muted); }
#connect-panel .connect-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
#connect-panel pre { margin: 0; padding: 6px 8px; overflow: auto; border-radius: 6px; background: var(--bg);
  border: 1px solid color-mix(in srgb, var(--muted) 40%, transparent); }
#connect-panel code { font: 11px ui-monospace, Menlo, monospace; color: var(--fg); }
#connect-panel button { font: inherit; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--muted); background: var(--panel); color: var(--fg); }
`;

/** @param {string} text */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch { /* fall back below */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('the browser did not allow copying');
}

/** @type {{ close: () => void }|null} */
let current = null;

/**
 * Open the panel (replacing one already open).
 * @param {HTMLElement|{ getBoundingClientRect: () => any }} anchorEl where it opens from
 * @param {{ service: boolean, opener?: HTMLElement|null }} opts opener: gets focus back on close
 */
export function openConnectPanel(anchorEl, { service, opener = null }) {
  current?.close();
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.append(st);
  }
  const back = opener ?? /** @type {HTMLElement|null} */ (document.activeElement);
  const cfg = agentConfigs({ serverUrl: location.origin, service });

  const pop = document.createElement('div');
  pop.id = 'connect-panel';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Connect an agent');
  pop.tabIndex = -1;
  const intro = document.createElement('p');
  intro.textContent = CONNECT_INTRO;
  pop.append(intro);

  const status = document.createElement('p');
  status.className = 'connect-note';
  status.setAttribute('role', 'status');

  /** @param {string} title @param {string} text @param {string} id */
  const block = (title, text, id) => {
    const row = document.createElement('div');
    row.className = 'connect-row';
    const h = document.createElement('h3');
    h.textContent = title;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.id = `connect-copy-${id}`;
    copy.textContent = 'Copy';
    copy.setAttribute('aria-label', `Copy: ${title}`);
    copy.addEventListener('click', async () => {
      try { await copyText(text); status.textContent = `Copied: ${title}.`; } catch (err) { status.textContent = `Could not copy: ${/** @type {any} */ (err)?.message ?? err}`; }
    });
    row.append(h, copy);
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = text;
    pre.append(code);
    pop.append(row, pre);
  };
  if (cfg.http) block('Claude Code, over HTTP', cfg.http, 'http');
  block('Claude Code, local', cfg.stdio, 'stdio');
  block('MCP client settings (JSON)', cfg.json, 'json');
  const note = document.createElement('p');
  note.className = 'connect-note';
  note.textContent = service ? TOKEN_NOTE : SERVE_NOTE;
  pop.append(note, status);
  document.body.append(pop);

  // Placed like keepFitted, but its resize listener goes with the panel (a new panel per open).
  const place = () => fitTo(pop, /** @type {HTMLElement} */ (anchorEl), { align: 'right' });
  /** @param {KeyboardEvent} e */
  const onKey = (e) => { if (e.key === 'Escape') { close(); back?.focus?.(); } };
  /** @param {Event} e */
  const onDown = (e) => { if (!pop.contains(/** @type {Node} */ (e.target))) close(); };
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDown, true);
    removeEventListener('resize', place);
    pop.remove();
    if (current === handle) current = null;
  };
  const handle = { close };
  current = handle;
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  addEventListener('resize', place);
  place();
  pop.focus();
}
