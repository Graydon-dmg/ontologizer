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
