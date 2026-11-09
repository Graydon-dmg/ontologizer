// @ts-check
import { panelRows, tokenLines, sourceLines, portsLine, NO_TOKENS, HELP, failureText, noteText } from '../server-panel.js';
import { keepFitted } from './fit.js';

const STYLE_ID = 'server-panel-style';
const CSS = `
.server-btn { font: inherit; font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--muted); background: var(--panel); color: var(--fg); }
.server-btn[aria-expanded="true"] { background: var(--fg); color: var(--bg); }
#server-panel.server-pop-host { position: relative; }
.server-pop { position: fixed; z-index: 25; width: 300px; box-sizing: border-box; padding: 10px; overflow: auto;
  background: var(--panel); color: var(--fg); border: 1px solid color-mix(in srgb, var(--muted) 40%, transparent); border-radius: 8px; }
.server-pop[hidden] { display: none; }
.server-body { display: flex; flex-direction: column; gap: 8px; font-size: 12px; }
.server-body dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; }
.server-body dt { color: var(--muted); }
.server-body dd { margin: 0; }
.server-body h3 { margin: 0; font-size: 12px; }
.server-body ul { margin: 0; padding-left: 18px; }
.server-msg, .server-help { color: var(--muted); }
.server-help code { color: var(--fg); }
`;

/** Add the one style element, once. */
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = CSS;
  document.head.append(st);
}

/**
 * Read-only server status panel.
 * @param {HTMLElement} el the #server-panel element
 * @param {{ tenant: string, fetch?: typeof fetch, popover?: boolean }} opts
 */
export function mountServerPanel(el, opts) {
  ensureStyle();
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const popover = opts.popover === true;
  el.hidden = false;

  const body = document.createElement('div');
  body.className = 'server-body';
  const dl = document.createElement('dl');
  const tokHead = document.createElement('h3');
  tokHead.textContent = 'Tokens';
  /** @type {HTMLElement} */
  let list = /** @type {HTMLElement} */ (el.querySelector('#server-tokens') ?? document.createElement('ul'));
  list.id = 'server-tokens';
  const msg = document.createElement('p');
  msg.className = 'server-msg';
  msg.setAttribute('role', 'status');
  msg.hidden = true;
  const help = document.createElement('p');
  help.className = 'server-help';
  const parts = HELP.split('`');
  help.append(parts[0]);
  const code = document.createElement('code');
  code.textContent = parts[1] ?? '';
  help.append(code, parts[2] ?? '');
  const note = document.createElement('p');
  note.className = 'server-msg';
  note.hidden = true;
  const srcHead = document.createElement('h3');
  srcHead.textContent = 'Sources';
  srcHead.hidden = true;
  const srcList = document.createElement('ul');
  srcList.id = 'server-sources';
  srcList.hidden = true;
  const ports = document.createElement('p');
  ports.id = 'server-ports';
  ports.className = 'server-msg';
  ports.hidden = true;
  body.append(msg, dl, note, ports, srcHead, srcList, tokHead, list, help);

  /** @param {string} text */
  const fail = (text) => { msg.textContent = text; msg.hidden = false; dl.replaceChildren(); list.replaceChildren(); tokHead.hidden = true; note.hidden = true; ports.hidden = true; srcHead.hidden = true; srcList.hidden = true; };

  async function load() {
    msg.hidden = false;
    msg.textContent = 'Loading…';
    try {
      const r = await f(`/v1/t/${encodeURIComponent(opts.tenant)}/status`, { credentials: 'same-origin' });
      /** @type {any} */
      let s = null;
      try { s = await r.json(); } catch { s = null; }
      if (!r.ok || s?.ok === false) { fail(failureText(r.status, typeof s?.error === 'string' ? s.error : undefined)); return; }
      msg.hidden = true;
      tokHead.hidden = false;
      dl.replaceChildren();
      for (const row of panelRows(s)) {
        const dt = document.createElement('dt');
        dt.textContent = row.label;
        const dd = document.createElement('dd');
        dd.textContent = row.value;
        dl.append(dt, dd);
      }
      note.textContent = noteText(s);
      note.hidden = !note.textContent;
      const pl = portsLine(s);
      ports.textContent = pl ? `Ports · ${pl}` : '';
      ports.hidden = !pl;
      const sl = sourceLines(s);
      srcList.replaceChildren();
      for (const line of sl ?? []) { const li = document.createElement('li'); li.textContent = line; srcList.append(li); }
      srcHead.hidden = srcList.hidden = !sl || !sl.length;
      const lines = tokenLines(s.tokens);
      list.replaceChildren();
      if (!lines.length) {
        const li = document.createElement('li');
        li.textContent = NO_TOKENS;
        list.append(li);
      }
      for (const line of lines) {
        const li = document.createElement('li');
        li.textContent = line;
        list.append(li);
      }
    } catch {
      fail(failureText(0));
    }
  }

  if (!popover) {
    el.append(body);
    load();
    return;
  }

  el.classList.add('server-pop-host');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'server-btn';
  btn.textContent = 'Server';
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');
  const pop = document.createElement('div');
  pop.className = 'server-pop';
  pop.hidden = true;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Server');
  pop.append(body);
  el.append(btn, pop);

  // Fixed beside the button, always inside the window (re-placed on resize and when it fills in).
  const place = keepFitted(pop, btn);
  const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', () => {
    if (!pop.hidden) { close(); return; }
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    place();
    load().then(place, place);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { close(); btn.focus(); } });
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !el.contains(/** @type {Node} */ (e.target))) close(); });
}
