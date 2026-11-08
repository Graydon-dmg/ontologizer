// @ts-check
// Render parsed chat markdown into elements with textContent only. Never innerHTML of model text.
// The document is injected so Node tests can use a fake one.
import { parseMarkdown, citeChip } from './chat.js';

/**
 * @param {{ createElement: (t: string) => any, createTextNode: (s: string) => any }} doc
 * @param {string} text  model text
 * @param {{ ontology: any, onCite?: (id: string) => void }} o
 * @returns {any} a <div class="md"> element
 */
export function renderMarkdown(doc, text, o) {
  const root = doc.createElement('div');
  root.className = 'md';
  /** @param {any} parent @param {import('./chat.js').Inline[]} inl */
  const inline = (parent, inl) => {
    for (const x of inl) {
      if (x.t === 'text') parent.appendChild(doc.createTextNode(x.v));
      else if (x.t === 'code') { const c = doc.createElement('code'); c.textContent = x.v; parent.appendChild(c); }
      else if (x.t === 'b' || x.t === 'i') { const e = doc.createElement(x.t === 'b' ? 'strong' : 'em'); inline(e, x.c); parent.appendChild(e); }
      else if (x.t === 'link') {
        const a = doc.createElement('a');
        a.setAttribute('href', x.href);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        inline(a, x.c);
        parent.appendChild(a);
      } else if (x.t === 'cite') {
        const chip = citeChip(o.ontology, x.id);
        if (!chip) { parent.appendChild(doc.createTextNode(x.id)); continue; }
        const b = doc.createElement('button');
        b.setAttribute('type', 'button');
        b.className = 'cite';
        b.setAttribute('data-node', chip.id);
        b.setAttribute('title', 'Show on the map');
        b.textContent = chip.label;
        if (o.onCite) b.addEventListener('click', () => o.onCite && o.onCite(chip.id));
        parent.appendChild(b);
      }
    }
  };
  for (const blk of parseMarkdown(text)) {
    if (blk.t === 'p' || blk.t === 'h') {
      const p = doc.createElement(blk.t === 'p' ? 'p' : 'h4');
      inline(p, blk.c);
      root.appendChild(p);
    } else {
      const l = doc.createElement(blk.t);
      for (const item of blk.items) { const li = doc.createElement('li'); inline(li, item); l.appendChild(li); }
      root.appendChild(l);
    }
  }
  return root;
}
