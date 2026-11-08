// @ts-check
import { jobRows, jobText, visibleJobRows } from '../jobs.js';

/** @param {HTMLElement} el @param {any} shell */
export function mountJobs(el, shell) {
  el.classList.add('onto-jobs');
  el.hidden = true;
  function render() {
    const rows = visibleJobRows(jobRows(shell.snapshot())).map((r) => (r.kind === 'rosetta' && shell.lensRequests
      ? { ...r, label: shell.lensRequests.personaForJob(r.id) || r.label }
      : r.kind === 'fuse' && shell.mapName ? { ...r, withName: shell.mapName(/** @type {any} */ (r).with) } : r));
    el.textContent = '';
    el.hidden = rows.length === 0;
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'row';
      const badge = document.createElement('span');
      badge.className = 'badge ' + r.state;
      badge.textContent = r.state;
      const text = document.createElement('span');
      text.textContent = jobText(r);
      row.append(badge, text);
      if (r.nodeId) {
        const id = r.nodeId;
        row.dataset.node = id;
        row.addEventListener('click', () => {
          shell.act({ type: 'focus', nodeId: id });
          const v = shell.activeView();
          if (v && v.setFocus) v.setFocus(id);
        });
      }
      el.appendChild(row);
    }
  }
  shell.on('event', (/** @type {any} */ d) => { if (d && d.event && String(d.event.t).startsWith('job.')) render(); });
  render();
}
