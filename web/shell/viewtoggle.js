// @ts-check
// The 2D | 3D toggle model (no DOM).

/**
 * A short button label: the view's own label when it is already short, else "2D" / "3D" from the id.
 * @param {{ id: string, label: string }} view
 */
export function shortLabel(view) {
  const label = String(view.label || '');
  if (label && label.length <= 3) return label;
  const id = String(view.id || '').toLowerCase();
  if (id === 'graph-2d' || /(^|[-_])2d($|[-_])/.test(id)) return '2D';
  if (/sky|3d/.test(id)) return '3D';
  return label || view.id;
}

/**
 * One button per registered view; none when there is only one view.
 * @param {{ id: string, label: string }[]} views
 * @param {string|null} activeId
 * @returns {{ id: string, label: string, title: string, pressed: boolean }[]}
 */
export function toggleButtons(views, activeId) {
  if (!views || views.length < 2) return [];
  return views.map((v) => ({ id: v.id, label: shortLabel(v), title: v.label, pressed: v.id === activeId }));
}

/**
 * Pressing a button: switch through the shell unless that view is already active.
 * @param {{ switchView: (id: string) => void, activeViewId: () => string|null }} shell
 * @param {string} id
 * @returns {boolean} whether it switched
 */
export function pressToggle(shell, id) {
  if (shell.activeViewId() === id) return false;
  shell.switchView(id);
  return true;
}
