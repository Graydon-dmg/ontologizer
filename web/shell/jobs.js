// @ts-check
/** @typedef {import('../../src/core/schema.js').Ontology} Ontology */

const ORDER = { running: 0, queued: 1, failed: 2, done: 3 };

/**
 * @param {Ontology} ontology
 * @returns {{ id: string, kind: string, nodeId?: string, label: string, state: string, error?: string }[]}
 */
export function jobRows(ontology) {
  const lensPersonas = Object.values(ontology.lenses || {}).map((l) => l.persona || l.id);
  let rosettaSeen = 0;
  return Object.values(ontology.jobs)
    .map((j, i) => ({
      i,
      row: {
        id: j.id,
        kind: j.kind,
        nodeId: j.nodeId,
        label: j.kind === 'rosetta'
          ? rosettaLabel(/** @type {any} */ (j), lensPersonas, rosettaSeen++)
          : (j.nodeId && ontology.nodes[j.nodeId] && ontology.nodes[j.nodeId].label) || '',
        state: j.state,
        error: j.error,
      },
    }))
    .sort((a, b) => (ORDER[a.row.state] ?? 4) - (ORDER[b.row.state] ?? 4) || a.i - b.i)
    .map((x) => x.row);
}

const VERB = { build: 'Building', explain: 'Explaining', research: 'Researching', sources: 'Finding sources for', rosetta: 'Building lens' };

/**
 * One line of the jobs tray: "Building Tools", "Researching Plastic cement", or "<kind> <label>".
 * @param {{ kind: string, label: string, error?: string }} row
 */
export function jobText(row) {
  if (row.kind === 'rosetta') return `Building lens${row.label ? ': ' + row.label : ''}${row.error ? ' (' + row.error + ')' : ''}`;
  const verb = Object.prototype.hasOwnProperty.call(VERB, row.kind) ? VERB[/** @type {keyof typeof VERB} */ (row.kind)] : row.kind;
  return `${verb}${row.label ? ' ' + row.label : ''}${row.error ? ' (' + row.error + ')' : ''}`;
}

/**
 * The rows the tray shows: every unfinished or failed job, plus the last few finished ones.
 * @param {ReturnType<typeof jobRows>} rows
 * @param {number} [keepDone]
 */
export function visibleJobRows(rows, keepDone = 3) {
  const done = rows.filter((r) => r.state === 'done');
  return [...rows.filter((r) => r.state !== 'done'), ...done.slice(-keepDone)];
}

/**
 * The persona of a Rosetta job: from the job itself (the server records it), else from the
 * lens made by the k-th Rosetta job (jobs and lenses are both recorded in creation order), so the
 * label survives a reload.
 * @param {{ persona?: string }} job @param {string[]} lensPersonas @param {number} k
 */
export function rosettaLabel(job, lensPersonas, k) {
  if (job.persona) return job.persona;
  return lensPersonas[k] || '';
}
