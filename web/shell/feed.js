// @ts-check
// Feeds the one page layout from events, exactly as web/shared/view.js says.
// Views never feed the layout. No DOM here.

/**
 * @param {{ add: Function, addEdge: Function, setCollapsed: Function, setFocus: Function }} layout
 * @param {any} event
 */
export function feedLayout(layout, event) {
  if (!event) return;
  switch (event.t) {
    case 'node.added':
      // Always add, even when the parent has not arrived: the layout re-places it later.
      if (event.node && event.node.id) layout.add(event.node);
      break;
    case 'edge.added':
      if (event.edge) layout.addEdge(event.edge);
      break;
    case 'view.changed': {
      const p = event.patch || {};
      if (Array.isArray(p.collapsed)) layout.setCollapsed(p.collapsed);
      if (typeof p.focus === 'string' && p.focus) layout.setFocus(p.focus);
      break;
    }
    default:
      break;
  }
}
