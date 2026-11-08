// @ts-check
/** @typedef {import('../../src/core/schema.js').Ontology} Ontology */
/** @typedef {import('../../src/core/schema.js').OntoNode} OntoNode */
/** @typedef {{ id: string, label: string, action?: any, open?: 'explain' }} MenuItem */

/**
 * Menu entries for a node, in contract order.
 * @param {OntoNode} node @param {Ontology} ontology @returns {MenuItem[]}
 */
export function menuItems(node, ontology) {
  const nodeId = node.id;
  const collapsed = (ontology.view.collapsed || []).includes(nodeId);
  const hasChildren = Object.values(ontology.nodes).some((n) => n.parent === nodeId);
  /** @type {MenuItem[]} */
  const items = [];
  if (collapsed) items.push({ id: 'expand', label: 'Expand', action: { type: 'expand', nodeId } });
  if (hasChildren && !collapsed) items.push({ id: 'collapse', label: 'Collapse', action: { type: 'collapse', nodeId } });
  items.push({ id: 'research-context', label: 'Research (in context)', action: { type: 'research', nodeId, mode: 'context' } });
  items.push({ id: 'research-general', label: 'Research (general)', action: { type: 'research', nodeId, mode: 'general' } });
  if (node.article) items.push({ id: 'read', label: 'Read explanation', open: 'explain' });
  else items.push({ id: 'explain', label: 'Explain', action: { type: 'explain', nodeId } });
  items.push({ id: 'sources', label: 'Sources', action: { type: 'sources', nodeId } });
  return items;
}

/**
 * What clicking a menu item does: send its action through the shell (Explain also opens the
 * panel, so the "Researching…" state is visible at once), or open the panel.
 * @param {MenuItem} item @param {string} nodeId
 * @param {{ act: (a: any) => any, openExplain: (id: string) => void }} shell
 */
export function runMenuItem(item, nodeId, shell) {
  if (item.action) {
    const r = shell.act(item.action);
    if (item.action.type === 'explain') shell.openExplain(nodeId);
    return r;
  }
  if (item.open === 'explain') shell.openExplain(nodeId);
  return undefined;
}

/** No item may fire this soon after the menu opened (ms). */
export const MENU_ARM_MS = 300;
/** The menu opens this far from the pointer, so no item sits under it. */
export const MENU_OFFSET_PX = 8;

/**
 * Guards menu items against the tail of the gesture that opened the menu (a phantom click
 * runs a paid model call). An item fires only when:
 *   - at least MENU_ARM_MS have passed since the menu opened, and
 *   - the press started inside this open menu (a pointerdown after it opened),
 *     or it is a keyboard activation (click with detail 0).
 */
export function createMenuGuard(armMs = MENU_ARM_MS) {
  let openedAt = -Infinity;
  let pressedInside = false;
  return {
    /** @param {number} now */
    opened(now) { openedAt = now; pressedInside = false; },
    /** A pointerdown inside the open menu. @param {number} now */
    pointerDownInside(now) { if (now >= openedAt) pressedInside = true; },
    /** @param {number} now @param {boolean} keyboard */
    allow(now, keyboard) {
      if (now - openedAt < armMs) return false;
      return keyboard || pressedInside;
    },
  };
}
