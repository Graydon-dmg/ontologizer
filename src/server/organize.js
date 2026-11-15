// @ts-check
// POST /v1/t/{tenant}/maps/organize: organise a supplied list of items into a map. The gates before
// it (auth, scope, limits, body size, queue, store) are the router's; this validates the list,
// stores an empty draft durably, starts the run and answers 202 at once, as build_map does.
import { checkInput } from '../core/engine/organize.js';

const MINUTE = 60 * 1000;

/** The run's time limit: 15 minutes plus 2 per 1,000 items, at most 45, never under the operator's. @param {number} n @param {number} [buildTimeoutMs] */
export const organizeTimeout = (n, buildTimeoutMs = 0) => Math.max(buildTimeoutMs, Math.min(45 * MINUTE, 15 * MINUTE + 2 * MINUTE * Math.ceil(n / 1000)));

/**
 * @param {{ req: any, res: any, body: any, tenant: string, principal: any, actor: any, store: any,
 *   startRun: (tenant: string, draftId: string, kind: string, work: (engine: any) => any, opts?: { timeoutMs?: number }) => void,
 *   engineFor: (tenant: string, id: string) => Promise<any>, durable: (store: any) => Promise<void>,
 *   json: Function, fail: (res: any, status: number, error: string, headers?: Record<string, string>) => any,
 *   buildTimeoutMs?: number }} c
 */
export async function organizeRoute(c) {
  const { res, body, tenant, principal, actor, store, startRun, durable, json, fail } = c;
  // An empty body (no name, no items) keeps S's answer; anything else gets the field's own error.
  if (!body || typeof body !== 'object' || (body.name === undefined && body.items === undefined)) return fail(res, 400, 'give name and items');
  const checked = checkInput(body);
  if (!checked.ok) return fail(res, 400, checked.error);
  const input = checked.input;
  const n = input.items.length;
  const id = store.createDraft({ subject: input.name, context: `Organised from ${n} supplied items`, scope: '', purpose: '', level: 'expert' }, undefined, { events: [] });
  try { await durable(store); } catch { return fail(res, 503, 'the store is not available'); }
  startRun(tenant, id, 'organize', (engine) => engine.organize(input, { actor, principal }), { timeoutMs: organizeTimeout(n, c.buildTimeoutMs) });
  const base = `/v1/t/${tenant}/maps/${id}`;
  return json(res, 202, { id, viewUrl: `${base}/view`, eventsUrl: `${base}/events` });
}
