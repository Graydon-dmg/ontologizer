// @ts-check
// Epic B: the offline stub engine's hydrate batch. Placeholder until Epic B lands: it emits nothing,
// so the stub's own job.queued / job.done are all a hydrate job writes.

/** @param {{ store: any, id: string, job: any, emit: (t: string, fields: object) => void }} _c @returns {Promise<void>} */
export async function stubHydrate(_c) {}
