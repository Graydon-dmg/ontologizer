// @ts-check
// The stub engine's hydrate: a deterministic node.hydrated for each node of the job, no model call.
import { childrenOf } from '../core/engine/prompts-hydrate.js';

/**
 * @param {{ store: any, id: string, job: { nodeIds?: string[] }, emit: (t: string, fields: object) => void }} c
 */
export function stubHydrate({ store, id, job, emit }) {
  const o = store.read(id);
  for (const nodeId of job.nodeIds ?? []) {
    if (!Object.hasOwn(o.nodes, nodeId)) continue;
    const n = o.nodes[nodeId];
    const other = childrenOf(o.nodes, n.parent).find((s) => s.id !== nodeId);
    emit('node.hydrated', {
      nodeId,
      hydration: {
        job: `Stub job for ${n.label}`,
        examples: [1, 2, 3].map((k) => `${n.label} example ${k}`),
        not_for: other ? `Not ${other.label}.` : '',
        not_for_ids: other ? [other.id] : [],
        model: 'stub',
        at: '2026-01-01T00:00:00.000Z',
      },
    });
  }
}
