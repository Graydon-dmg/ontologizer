// @ts-check
/** @typedef {{ text: string, nodeId?: string }} TickerItem */

/** @param {any} event @param {any} ontology @returns {TickerItem|null} */
export function tickerItem(event, ontology) {
  if (!event) return null;
  if (event.t === 'node.added' && event.node && event.node.hook) return { text: event.node.hook, nodeId: event.node.id };
  if (event.t === 'insight' && event.text) return { text: event.text, nodeId: event.nodeId };
  return null;
}

/**
 * @param {{ show: (item: TickerItem|null) => void, setTimeout: Function, clearTimeout: Function, holdMs?: number }} o
 */
export function createTicker({ show, setTimeout, clearTimeout, holdMs = 4000 }) {
  /** @type {TickerItem[]} */
  let queue = [];
  let timer = null;
  let busy = false;
  function next() {
    timer = null;
    const item = queue.pop(); // newest first
    if (!item) { busy = false; show(null); return; }
    busy = true;
    show(item);
    timer = setTimeout(next, holdMs);
  }
  return {
    /** @param {TickerItem} item */
    push(item) {
      if (!item) return;
      queue.push(item);
      if (queue.length > 5) queue = queue.slice(-5);
      if (!busy) next();
    },
  };
}
