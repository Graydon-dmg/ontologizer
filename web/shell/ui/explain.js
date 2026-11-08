// @ts-check
import { explainModel } from '../explain.js';

/** @param {HTMLElement} el @param {any} shell */
export function mountExplain(el, shell) {
  el.classList.add('onto-explain');
  el.hidden = true;
  /** @type {string|null} */
  let openId = null;
  let lastKey = '';

  /** @param {string} tag @param {string} [text] @param {string} [cls] */
  const mk = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const close = () => { openId = null; el.hidden = true; el.textContent = ''; lastKey = ''; };
  /** @param {string} id */
  const focus = (id) => { shell.act({ type: 'focus', nodeId: id }); const v = shell.activeView(); if (v && v.setFocus) v.setFocus(id); };

  function render() {
    if (!openId) return;
    const m = explainModel(shell.snapshot(), openId);
    if (!m) return close();
    el.textContent = '';
    const x = mk('button', '×', 'close');
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', close);
    el.appendChild(x);
    el.appendChild(mk('h2', m.node.label));
    const a = m.article;
    el.appendChild(mk('p', (a && a.summary) || m.node.summary || ''));
    if (m.analog) {
      const box = mk('div', undefined, 'analog');
      box.appendChild(mk('div', `As ${m.analog.persona}: ${m.analog.label}`));
      if (m.analog.breaks) box.appendChild(mk('div', `Where it breaks: ${m.analog.breaks}`, 'breaks'));
      el.appendChild(box);
    }
    if (!a) {
      el.appendChild(mk('p', m.researching ? 'Researching…' : 'No explanation yet. Use Explain on the node menu.', 'researching'));
    } else {
      if (a.keyFacts && a.keyFacts.length) {
        el.appendChild(mk('h3', 'Key facts'));
        const ul = mk('ul');
        for (const f of a.keyFacts) ul.appendChild(mk('li', f));
        el.appendChild(ul);
      }
      if (a.whyItMatters) { el.appendChild(mk('h3', 'Why it matters')); el.appendChild(mk('p', a.whyItMatters)); }
      if (m.researching) el.appendChild(mk('p', 'Researching…', 'researching'));
    }
    if (m.seeAlso.length) {
      el.appendChild(mk('h3', 'See also'));
      const ul = mk('ul');
      for (const s of m.seeAlso) {
        const li = mk('li');
        const b = mk('button', s.label, 'see-also');
        b.addEventListener('click', () => focus(s.id));
        li.appendChild(b);
        ul.appendChild(li);
      }
      el.appendChild(ul);
    }
    if (m.sources.length) {
      el.appendChild(mk('h3', 'Sources'));
      const ul = mk('ul');
      for (const s of m.sources) {
        const li = mk('li');
        const link = /** @type {HTMLAnchorElement} */ (mk('a', s.title || s.url));
        link.href = s.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        li.appendChild(link);
        ul.appendChild(li);
      }
      el.appendChild(ul);
    }
    el.hidden = false;
  }

  /** @param {string} id */
  function open(id) { openId = id; lastKey = ''; render(); lastKey = keyFor(); }
  function keyFor() {
    if (!openId) return '';
    const o = shell.snapshot();
    const n = o.nodes[openId];
    const jobs = Object.values(o.jobs).filter((/** @type {any} */ j) => j.nodeId === openId).map((/** @type {any} */ j) => j.id + j.state).join(',');
    return JSON.stringify([n && n.article, n && n.summary, jobs, o.view.lens, o.lenses]);
  }

  shell.on('explain', (/** @type {any} */ d) => { if (d && d.nodeId) open(d.nodeId); });
  shell.on('select', (/** @type {any} */ d) => {
    if (!d || !d.nodeId) return;
    const n = shell.snapshot().nodes[d.nodeId];
    if (n && n.article) open(d.nodeId);
  });
  shell.on('event', () => {
    if (!openId) return;
    const k = keyFor();
    if (k !== lastKey) { lastKey = k; render(); }
  });
}
