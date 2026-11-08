// @ts-check
/** The right-hand panel space, shared by two panes: Explain | Chat (one shows at a time).
 * @param {any} shell */
export function mountSide(shell) {
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const tabs = $('side-tabs');
  const explain = $('explain');
  const chat = $('chat');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Side panel');
  tabs.hidden = true;
  /** @type {'explain'|'chat'|null} */
  let active = null;
  /** @type {Record<string, HTMLButtonElement>} */
  const btn = {};
  for (const [name, label] of /** @type {const} */ ([['explain', 'Explain'], ['chat', 'Chat']])) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.id = `side-tab-${name}`;
    b.setAttribute('aria-controls', name);
    b.textContent = label;
    b.addEventListener('click', () => {
      if (name === 'explain' && !shell.side.explainOpen()) {
        const o = shell.snapshot();
        shell.openExplain(o.view.focus || o.root);
      } else shell.side.show(name);
    });
    btn[name] = b;
    tabs.append(b);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'side-close';
  close.setAttribute('aria-label', 'Close the side panel');
  close.textContent = '×';
  close.addEventListener('click', () => { if (active) shell.side.hide(active); });
  tabs.append(close);
  tabs.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = active === 'explain' ? 'chat' : 'explain';
    btn[next].click();
    btn[next].focus();
  });
  chat.setAttribute('role', 'tabpanel');
  chat.setAttribute('aria-labelledby', 'side-tab-chat');
  explain.setAttribute('role', 'tabpanel');
  explain.setAttribute('aria-labelledby', 'side-tab-explain');

  const paint = () => {
    tabs.hidden = active === null;
    for (const n of ['explain', 'chat']) {
      btn[n].setAttribute('aria-selected', String(active === n));
      btn[n].tabIndex = active === n ? 0 : -1;
    }
    chat.hidden = active !== 'chat';
    if (active !== 'explain') explain.hidden = true;
  };
  shell.side = {
    get active() { return active; },
    /** set by the explain pane: does it have a node open? */
    explainOpen: () => false,
    /** @param {'explain'|'chat'} name */
    show(name) { active = name; paint(); shell.emit('side', { active }); },
    /** @param {'explain'|'chat'} name */
    hide(name) { if (active !== name) return; active = null; paint(); shell.emit('side', { active }); },
    /** @param {'explain'|'chat'} name */
    toggle(name) { if (active === name) this.hide(name); else this.show(name); },
  };
  paint();
}
